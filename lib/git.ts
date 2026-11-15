// Git smart HTTP: upload-pack (protocol v2 and v0) and receive-pack (v0).
// Serves the wire protocol the suite's git client drives.

import { ServerResponse, IncomingMessage } from 'node:http';
import { encodePktLine, decodePktLines, pktLineFlush, pktLineDelim } from './pktline.ts';
import type { PktPacket } from './pktline.ts';
import {
  ZERO_OID,
  collectReachable,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
} from './gitobj.ts';
import type { GitObject } from './gitobj.ts';
import type { ForgeStore, Repo } from './store.ts';

const AGENT = 'github-core-clone-forge/0.1';
const UPLOAD = 'git-upload-pack';
const RECEIVE = 'git-receive-pack';

interface Ctx {
  store: ForgeStore;
  authorized: boolean;
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
  });
  res.end(body);
}

function sendErr(res: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(JSON.stringify({ message }), 'utf8');
  sendBytes(res, status, 'application/json', body);
}

/** Parse the Git-Protocol header: 'version=2' etc. */
function wantsV2(req: IncomingMessage): boolean {
  const gp = req.headers['git-protocol'];
  if (typeof gp === 'string') return gp.includes('version=2');
  if (Array.isArray(gp)) return gp.some((g) => g.includes('version=2'));
  return false;
}

function refSort(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** All refs of a repo as [name, oid] including HEAD. */
function allRefs(repo: Repo): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const headTarget = repo.refs.get('refs/heads/' + repo.defaultBranch);
  if (headTarget) out.push(['HEAD', headTarget]);
  const names = [...repo.refs.keys()].sort(refSort);
  for (const name of names) {
    const oid = repo.refs.get(name);
    if (oid) out.push([name, oid]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(ctx: Ctx, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string): void {
  const repo = ctx.store.getRepo(owner, repoName);
  const v2 = wantsV2(req);
  if (!repo) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  if (service === UPLOAD) {
    if (v2) {
      const lines: Buffer[] = [];
      lines.push(encodePktLine('# service=git-upload-pack\n'));
      lines.push(pktLineFlush());
      lines.push(encodePktLine('version 2\n'));
      lines.push(encodePktLine(`agent=${AGENT}\n`));
      lines.push(encodePktLine('fetch=shallow\n'));
      lines.push(encodePktLine('ls-refs=unborn\n'));
      lines.push(encodePktLine('object-format=sha1\n'));
      lines.push(pktLineFlush());
      sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(lines));
    } else {
      const lines: Buffer[] = [];
      lines.push(encodePktLine('# service=git-upload-pack\n'));
      lines.push(pktLineFlush());
      const refs = allRefs(repo);
      const caps = `multi_ack_detailed side-band-64k ofs-delta agent=${AGENT} shallow thin-pack no-progress include-tag symref=HEAD:refs/heads/${repo.defaultBranch}`;
      if (refs.length === 0) {
        lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
      } else {
        refs.forEach(([name, oid], i) => {
          lines.push(encodePktLine(`${oid} ${name}${i === 0 ? `\u0000${caps}` : ''}\n`));
        });
      }
      lines.push(pktLineFlush());
      sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(lines));
    }
  } else if (service === RECEIVE) {
    const lines: Buffer[] = [];
    lines.push(encodePktLine('# service=git-receive-pack\n'));
    lines.push(pktLineFlush());
    const refs = allRefs(repo);
    const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
    if (refs.length === 0) {
      lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    } else {
      refs.forEach(([name, oid], i) => {
        lines.push(encodePktLine(`${oid} ${name}${i === 0 ? `\u0000${caps}` : ''}\n`));
      });
    }
    lines.push(pktLineFlush());
    sendBytes(res, 200, 'application/x-git-receive-pack-advertisement', Buffer.concat(lines));
  } else {
    sendErr(res, 404, 'Not Found');
  }
}

// ---------------------------------------------------------------------------
// upload-pack POST
// ---------------------------------------------------------------------------

export function handleUploadPack(ctx: Ctx, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, body: Buffer): void {
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  if (wantsV2(req)) {
    handleUploadPackV2(ctx, repo, body, res);
  } else {
    handleUploadPackV0(ctx, repo, body, res);
  }
}

function handleUploadPackV2(ctx: Ctx, repo: Repo, body: Buffer, res: ServerResponse): void {
  const { packets, trailing } = decodePktLines(body);
  const lines: string[] = [];
  for (const p of packets) if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  // First packet(s) before delim carry command=... and args; args after delim.
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const line of lines) {
    const clean = line.replace(/\n$/, '');
    if (clean === '') continue;
    if (clean.startsWith('command=')) {
      command = clean.slice('command='.length);
      continue;
    }
    if (clean === 'agent=' + AGENT || clean.startsWith('agent=')) continue;
    if (clean.startsWith('object-format=')) continue;
    if (afterDelim) args.push(clean);
  }
  // Also handle delim packets
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') seenDelim = true;
    else if (p.kind === 'data' && seenDelim) {
      const clean = p.payload.toString('utf8').replace(/\n$/, '');
      if (clean && !clean.startsWith('agent=') && !clean.startsWith('object-format=') && !clean.startsWith('command=')) args.push(clean);
    }
  }
  void trailing;
  if (command === 'ls-refs') {
    respondLsRefs(ctx, repo, args, res);
    return;
  }
  if (command === 'fetch') {
    respondFetchV2(ctx, repo, args, res);
    return;
  }
  sendErr(res, 400, 'unknown command');
}

function respondLsRefs(ctx: Ctx, repo: Repo, args: string[], res: ServerResponse): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const filter = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const refs = allRefs(repo);
  for (const [name, oid] of refs) {
    if (!filter(name)) continue;
    let line = `${oid} ${name}`;
    if (name === 'HEAD' && symrefs) {
      const target = repo.refs.get('refs/heads/' + repo.defaultBranch);
      if (target) line += ' symref-target:refs/heads/' + repo.defaultBranch;
    }
    if (peel) {
      const obj = ctx.store.lookupObject(repo, oid);
      if (obj && obj.type === 'tag') {
        const peeled = parseTag(obj.data).object;
        if (isObjectId(peeled)) line += ` peeled:${peeled}`;
      }
    }
    out.push(encodePktLine(line + '\n'));
  }
  out.push(pktLineFlush());
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

interface FetchPlan {
  sendObjects: GitObject[];
  shallowLines: string[];
  unshallowLines: string[];
}

/**
 * Compute which objects to send for a fetch, observing depth and shallow boundaries.
 */
function planFetch(ctx: Ctx, repo: Repo, wants: string[], haves: string[], shallowSet: Set<string>, depth: number | null): FetchPlan {
  const store = ctx.store;
  const lookup = (oid: string) => store.lookupObject(repo, oid);

  // Peel tag wants to commits for traversal; keep tag objects to send.
  const tagWants = new Set<string>();
  const commitWants: string[] = [];
  for (const w of wants) {
    const obj = lookup(w);
    if (obj && obj.type === 'tag') {
      tagWants.add(w);
      const peeled = parseTag(obj.data).object;
      if (isObjectId(peeled)) commitWants.push(peeled);
    } else {
      commitWants.push(w);
    }
  }

  const sendObjects: GitObject[] = [];
  const sentOids = new Set<string>();
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];

  const addObject = (oid: string): void => {
    if (sentOids.has(oid)) return;
    const obj = lookup(oid);
    if (!obj) return;
    sentOids.add(oid);
    sendObjects.push(obj);
  };

  if (depth === null) {
    // full fetch: everything reachable from wants, minus what the client holds
    const held = new Set<string>();
    for (const h of [...haves, ...shallowSet]) {
      try {
        for (const oid of collectReachable([h], lookup, true)) held.add(oid);
      } catch {
        /* ignore */
      }
    }
    const roots = [...commitWants, ...tagWants];
    for (const oid of collectReachable(roots, lookup, true)) {
      if (!held.has(oid)) addObject(oid);
    }
    return { sendObjects, shallowLines, unshallowLines };
  }

  // Shallow fetch with depth d.
  const includeCommits = new Set<string>();
  const levelOf = new Map<string, number>();
  const queue: Array<[string, number]> = commitWants.map((w) => [w, 0]);
  let qi = 0;
  while (qi < queue.length) {
    const [oid, level] = queue[qi++];
    if (levelOf.has(oid)) continue;
    levelOf.set(oid, level);
    if (level >= depth) continue;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (haves.includes(oid) || shallowSet.has(oid)) {
      // already held; traverse through only if deeper levels are in range
      if (level + 1 < depth) {
        for (const p of parseCommit(obj.data).parents) if (!levelOf.has(p)) queue.push([p, level + 1]);
      }
      continue;
    }
    includeCommits.add(oid);
    if (level + 1 < depth) {
      for (const p of parseCommit(obj.data).parents) if (!levelOf.has(p)) queue.push([p, level + 1]);
    } else {
      shallowLines.push(`shallow ${oid}`);
    }
  }

  // unshallow client boundaries that now have an included parent
  for (const s of shallowSet) {
    const obj = lookup(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => includeCommits.has(p))) unshallowLines.push(`unshallow ${s}`);
  }

  // collect objects: commits in includeCommits + their trees, tags, blobs
  const walk = (oid: string): void => {
    if (sentOids.has(oid)) return;
    const obj = lookup(oid);
    if (!obj) return;
    if (obj.type === 'commit') {
      if (!includeCommits.has(oid)) return;
      sentOids.add(oid);
      sendObjects.push(obj);
      const c = parseCommit(obj.data);
      walk(c.tree);
      for (const p of c.parents) if (includeCommits.has(p)) walk(p);
    } else if (obj.type === 'tag') {
      sentOids.add(oid);
      sendObjects.push(obj);
      const t = parseTag(obj.data);
      if (isObjectId(t.object) && (includeCommits.has(t.object) || commitWants.includes(t.object))) walk(t.object);
    } else if (obj.type === 'tree') {
      sentOids.add(oid);
      sendObjects.push(obj);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        walk(e.oid);
      }
    } else {
      sentOids.add(oid);
      sendObjects.push(obj);
    }
  };
  for (const w of tagWants) walk(w);
  for (const c of includeCommits) walk(c);

  return { sendObjects, shallowLines, unshallowLines };
}

function respondFetchV2(ctx: Ctx, repo: Repo, args: string[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowSet = new Set<string>();
  let depth: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) { const oid = a.slice(5); if (isObjectId(oid)) wants.push(oid); }
    else if (a.startsWith('have ')) { const oid = a.slice(5); if (isObjectId(oid)) haves.push(oid); }
    else if (a.startsWith('shallow ')) { const oid = a.slice(8); if (isObjectId(oid)) shallowSet.add(oid); }
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7), 10);
    else if (a.startsWith('deepen-since ')) { /* ignore */ }
    else if (a.startsWith('deepen-not ')) { /* ignore */ }
  }
  if (isNaN(depth as number)) depth = null;
  const plan = planFetch(ctx, repo, wants, haves, shallowSet, depth);

  const out: Buffer[] = [];
  // The acknowledgments section is only needed when the client offered haves.
  if (haves.length > 0) {
    out.push(encodePktLine('acknowledgments\n'));
    out.push(encodePktLine('NAK\n'));
    out.push(pktLineFlush());
  }
  if (plan.shallowLines.length || plan.unshallowLines.length) {
    out.push(encodePktLine('shallow-info\n'));
    for (const l of plan.shallowLines) out.push(encodePktLine(l + '\n'));
    for (const l of plan.unshallowLines) out.push(encodePktLine(l + '\n'));
    out.push(pktLineFlush());
  }
  out.push(encodePktLine('packfile\n'));
  const pack = writePack(plan.sendObjects);
  // sideband band 1, chunked
  const MAX = 65515;
  for (let i = 0; i < pack.length; i += MAX) {
    const chunk = pack.subarray(i, i + MAX);
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  out.push(pktLineFlush());
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------------------
// upload-pack v0 (fallback)
// ---------------------------------------------------------------------------

function handleUploadPackV0(ctx: Ctx, repo: Repo, body: Buffer, res: ServerResponse): void {
  const { packets, trailing } = decodePktLines(body);
  const lines: string[] = [];
  for (const p of packets) if (p.kind === 'data') lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowSet = new Set<string>();
  let depth: number | null = null;
  let phase = 0; // 0 = wants section, 1 = haves/done
  for (const line of lines) {
    if (line === '') continue;
    if (line.startsWith('want ')) { const oid = line.slice(5).split(' ')[0]; if (isObjectId(oid)) wants.push(oid); }
    else if (line.startsWith('shallow ')) { const oid = line.slice(8); if (isObjectId(oid)) shallowSet.add(oid); }
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('have ')) { const oid = line.slice(5); if (isObjectId(oid)) haves.push(oid); }
    else if (line === 'done') { /* ok */ }
  }
  void trailing;
  if (isNaN(depth as number)) depth = null;
  const plan = planFetch(ctx, repo, wants, haves, shallowSet, depth);
  const out: Buffer[] = [];
  for (const s of plan.shallowLines) out.push(encodePktLine(s + '\n'));
  for (const s of plan.unshallowLines) out.push(encodePktLine(s + '\n'));
  out.push(encodePktLine('NAK\n'));
  const pack = writePack(plan.sendObjects);
  const MAX = 65515;
  for (let i = 0; i < pack.length; i += MAX) {
    const chunk = pack.subarray(i, i + MAX);
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  out.push(pktLineFlush());
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(ctx: Ctx, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, body: Buffer): void {
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo) {
    sendErr(res, 404, 'Not Found');
    return;
  }
  const { packets, trailing } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const clean = nul >= 0 ? text.slice(0, nul) : text;
    const parts = clean.split(' ');
    if (parts.length === 3 && isObjectId(parts[0]) && isObjectId(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  const pack = trailing.length ? trailing : null;
  if (pack && pack.length) {
    try {
      const read = readPack(pack, (oid) => ctx.store.lookupObject(repo, oid));
      for (const [oid, obj] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (e) {
      unpackOk = false;
      unpackDetail = `error ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const reportLines: string[] = [];
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}`);
  } else {
    reportLines.push('unpack ok');
    for (const cmd of commands) {
      const verdict = applyCommand(ctx.store, repo, cmd);
      reportLines.push(verdict);
    }
  }

  const band1 = Buffer.concat([...reportLines.map((l) => encodePktLine(l + '\n')), pktLineFlush()]);
  const out: Buffer[] = [];
  const MAX = 65515;
  for (let i = 0; i < band1.length; i += MAX) {
    const chunk = band1.subarray(i, i + MAX);
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  out.push(pktLineFlush());
  sendBytes(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(out));
}

function applyCommand(store: ForgeStore, repo: Repo, cmd: PushCommand): string {
  const { oldOid, newOid, ref } = cmd;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // delete
    if (current && current !== ZERO_OID) {
      repo.refs.delete(ref);
      repo.pushed_at = new Date().toISOString();
      return `ok ${ref}`;
    }
    return `ng ${ref} cannot delete non-existent ref`;
  }
  if (oldOid === ZERO_OID) {
    // create
    if (current && current !== ZERO_OID) return `ng ${ref} already exists`;
    if (!store.lookupObject(repo, newOid)) return `ng ${ref} missing objects`;
    repo.refs.set(ref, newOid);
    repo.pushed_at = new Date().toISOString();
    return `ok ${ref}`;
  }
  // update
  if (!current || current !== oldOid) return `ng ${ref} non-fast-forward`;
  const oldCommit = store.peelToCommit(repo, oldOid);
  const newCommit = store.peelToCommit(repo, newOid);
  if (!store.isAncestor(repo, oldCommit, newCommit)) return `ng ${ref} non-fast-forward`;
  repo.refs.set(ref, newOid);
  repo.pushed_at = new Date().toISOString();
  return `ok ${ref}`;
}
