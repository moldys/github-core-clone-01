// In-memory store: repositories, git objects/refs, issues, comments, labels, pull requests.
// All state lives here; the HTTP surfaces read and mutate it.

import {
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
} from './gitobj.ts';
import type { GitObject, GitObjectType, TreeEntry } from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
export const ROOT_COMMIT = 'f2a2e6a2f4d8c2e0b1a0c2d3e4f5a6b7c8d9e0';

export interface UserView {
  login: string;
  id: number;
  name: string;
}

export interface IssueComment {
  id: number;
  body: string;
  created_at: string;
  user: UserView;
}

export interface Issue {
  id: string; // global id
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: number; // monotonic order counter
  created_at: string;
  updated_at: string;
  user: UserView;
  comments: IssueComment[];
  isPullRequest: boolean;
}

export interface PullRequest {
  id: string;
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  merged: boolean;
  head: string; // branch name
  base: string; // branch name
  headSha: string;
  baseSha: string; // base tip at creation
  mergeBaseSha: string; // base tip at creation (for conflict detection)
  merge_commit_sha: string | null;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  createdAt: number;
  user: UserView;
}

export interface Repo {
  id: string;
  dbId: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  // time counter for ordering commits/issues deterministically
  seq: number;
}

interface ObjectIndex {
  type: GitObjectType;
}

export class ForgeStore {
  repos: Map<string, Repo> = new Map(); // key: `${owner}/${name}`
  private nextRepoDbId = 1;
  private nextIssueDbId = 1;
  private nextPullDbId = 1;
  private timeCounter = 1000000;

  private now(): string {
    // fixed-ish timestamps; monotonic for ordering
    const t = this.timeCounter++;
    const base = 1720000000 + Math.floor(t / 1000);
    const iso = new Date(base * 1000).toISOString();
    return iso;
  }

  private nextSeq(): number {
    return this.timeCounter++;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(owner: string, name: string, privateRepo: boolean, description: string): Repo {
    const fullName = `${owner}/${name}`;
    const dbId = this.nextRepoDbId++;
    const created = this.now();
    const repo: Repo = {
      id: `repo:${dbId}`,
      dbId,
      owner,
      name,
      fullName,
      description: description ?? '',
      private: privateRepo,
      defaultBranch: DEFAULT_BRANCH,
      created_at: created,
      updated_at: created,
      pushed_at: created,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      seq: 0,
    };
    this.repos.set(fullName, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): void {
    this.repos.delete(`${owner}/${name}`);
  }

  listUserRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);
    return out;
  }

  // ---- object helpers ----

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  blob(repo: Repo, content: Buffer): string {
    return this.putObject(repo, 'blob', content);
  }

  treeFromEntries(repo: Repo, entries: TreeEntry[]): string {
    return this.putObject(repo, 'tree', buildTree(entries));
  }

  commit(repo: Repo, fields: { tree: string; parents: string[]; message: string; author?: string; committer?: string }): string {
    const data = buildCommit({
      tree: fields.tree,
      parents: fields.parents,
      message: fields.message,
      author: fields.author,
      committer: fields.committer,
      timestamp: 1720000000 + repo.seq,
    });
    return this.putObject(repo, 'commit', data);
  }

  tag(repo: Repo, name: string, target: string, message: string): string {
    const data = buildTag({ object: target, type: 'commit', tag: name, message, timestamp: 1720000000 + repo.seq });
    return this.putObject(repo, 'tag', data);
  }

  lookupObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /**
   * Build a tree object representing the given files (path -> content), recursively.
   * Returns tree oid.
   */
  buildTreeForFiles(repo: Repo, files: ReadonlyMap<string, Buffer>): string {
    interface Node {
      files: Map<string, Buffer>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, content] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i++) {
        const s = segments[i];
        if (!node.dirs.has(s)) node.dirs.set(s, make());
        node = node.dirs.get(s)!;
      }
      node.files.set(segments[segments.length - 1], content);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, data] of [...node.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        entries.push({ mode: '100644', name, oid: this.blob(repo, data) });
      }
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.treeFromEntries(repo, entries);
    };
    return build(root);
  }

  /** The tree oid of a commit. */
  commitTree(repo: Repo, oid: string): string {
    const obj = this.lookupObject(repo, oid);
    if (!obj || obj.type !== 'commit') throw new Error('not a commit');
    return parseCommit(obj.data).tree;
  }

  /** List files of a tree: Map path -> {oid, mode}. */
  listTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (treeOid: string, base: string): void => {
      const treeObj = this.lookupObject(repo, treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      for (const entry of parseTree(treeObj.data)) {
        const path = base ? `${base}/${entry.name}` : entry.name;
        if (entry.mode === '40000') {
          walk(entry.oid, path);
        } else {
          out.set(path, { oid: entry.oid, mode: entry.mode });
        }
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Get a single file's content bytes by path from a tree. */
  getFileAtTree(repo: Repo, treeOid: string, path: string): { oid: string; content: Buffer } | null {
    const files = this.listTree(repo, treeOid);
    const hit = files.get(path);
    if (!hit) return null;
    const obj = this.lookupObject(repo, hit.oid);
    if (!obj) return null;
    return { oid: hit.oid, content: obj.data };
  }

  /** Look up the oid a ref points at (resolving tags), or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (!oid) return null;
    return this.peelToCommit(repo, oid);
  }

  peelToCommit(repo: Repo, oid: string): string {
    let cur = oid;
    for (let i = 0; i < 10; i++) {
      const obj = this.lookupObject(repo, cur);
      if (!obj) return cur;
      if (obj.type === 'tag') {
        cur = parseTag(obj.data).object;
        continue;
      }
      return cur;
    }
    return cur;
  }

  /** refs/heads/<branch> -> commit oid (creating if unborn). */
  branchTip(repo: Repo, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (!oid) return null;
    return this.peelToCommit(repo, oid);
  }

  /**
   * Create a commit on `branch` with the given file changes (path -> content, or null to delete),
   * based on the branch's current tip (or unborn). Also handles a repo with no commits yet.
   * Returns { commitSha, treeSha }.
   */
  commitFiles(repo: Repo, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string, author?: string): { commitSha: string; treeSha: string } {
    const tip = this.branchTip(repo, branch);
    let baseTree: string;
    const parents: string[] = [];
    if (tip) {
      baseTree = this.commitTree(repo, tip);
      parents.push(tip);
    } else {
      baseTree = this.treeFromEntries(repo, []);
    }
    const files = this.listTree(repo, baseTree);
    for (const [path, content] of changes) {
      if (content === null) files.delete(path);
      else files.set(path, { oid: this.blob(repo, content), mode: '100644' });
    }
    // Rebuild nested tree properly via buildTreeForFiles
    const fileMap = new Map<string, Buffer>();
    for (const [path, info] of files) {
      const obj = this.lookupObject(repo, info.oid);
      if (obj) fileMap.set(path, obj.data);
    }
    const treeSha = this.buildTreeForFiles(repo, fileMap);
    const commitSha = this.commit(repo, { tree: treeSha, parents, message, author });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.seq += 1;
    repo.pushed_at = this.now();
    return { commitSha, treeSha };
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.lookupObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      for (const p of c.parents) queue.push(p);
    }
    return false;
  }

  /** Commits reachable from a ref, newest-first (by seq/date). */
  commitHistory(repo: Repo, tip: string): string[] {
    const reachable = collectReachable([tip], (oid) => this.lookupObject(repo, oid));
    const commits: string[] = [];
    for (const oid of reachable) {
      const obj = this.lookupObject(repo, oid);
      if (obj && obj.type === 'commit') commits.push(oid);
    }
    commits.sort((a, b) => {
      const ca = parseCommit(this.lookupObject(repo, a)!.data);
      const cb = parseCommit(this.lookupObject(repo, b)!.data);
      const ta = this.commitTime(ca);
      const tb = this.commitTime(cb);
      return tb - ta;
    });
    return commits;
  }

  private commitTime(c: ReturnType<typeof parseCommit>): number {
    const m = / (\d+) ([+-]\d{4})$/.exec(c.committer);
    return m ? Number(m[1]) : 0;
  }

  // ---- issues ----

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextIssueNumber++;
    const dbId = this.nextIssueDbId++;
    const now = this.now();
    const issue: Issue = {
      id: `issue:${dbId}`,
      dbId,
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      createdAt: this.nextSeq(),
      created_at: now,
      updated_at: now,
      user: { login: repo.owner, id: 1000, name: repo.owner },
      comments: [],
      isPullRequest: false,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  listIssues(repo: Repo, state: string | undefined, sort: string | undefined, direction: string | undefined): Issue[] {
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    const dir = direction === 'asc' ? 1 : -1;
    if (sort === 'created' || sort === 'created_at') {
      list.sort((a, b) => (a.createdAt - b.createdAt) * dir || (a.number - b.number) * dir);
    } else {
      list.sort((a, b) => (b.number - a.number) * dir);
    }
    return list;
  }

  setIssueState(repo: Repo, number: number, state: 'open' | 'closed'): Issue | undefined {
    const issue = repo.issues.get(number);
    if (!issue) return undefined;
    issue.state = state;
    issue.updated_at = this.now();
    return issue;
  }

  addComment(repo: Repo, issueNumber: number, body: string): IssueComment | undefined {
    const issue = repo.issues.get(issueNumber);
    if (!issue) return undefined;
    const comment: IssueComment = {
      id: repo.nextCommentId++,
      body,
      created_at: this.now(),
      user: { login: repo.owner, id: 1000, name: repo.owner },
    };
    issue.comments.push(comment);
    issue.updated_at = this.now();
    return comment;
  }

  // ---- pull requests ----

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | string {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (!headSha) return 'head branch does not exist';
    if (!baseSha) return 'base branch does not exist';
    const number = repo.nextPullNumber++;
    const dbId = this.nextPullDbId++;
    const now = this.now();
    const pr: PullRequest = {
      id: `pull:${dbId}`,
      dbId,
      number,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      head,
      base,
      headSha,
      baseSha,
      mergeBaseSha: baseSha,
      merge_commit_sha: null,
      merged_at: null,
      created_at: now,
      updated_at: now,
      createdAt: this.nextSeq(),
      user: { login: repo.owner, id: 1000, name: repo.owner },
    };
    repo.pulls.set(number, pr);
    return pr;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.get(number);
  }

  listPulls(repo: Repo, state: string | undefined): PullRequest[] {
    let list = [...repo.pulls.values()];
    if (state === 'open') list = list.filter((p) => p.state === 'open');
    else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
    else if (state === 'all') list = list.filter((p) => p.state === 'open' || p.state === 'closed' || p.state === 'merged');
    list.sort((a, b) => b.number - a.number);
    return list;
  }

  /**
   * Merge a pull request (squash). Returns {ok:true, sha} or {ok:false, error} where error is
   * 'not_found' (404), 'conflict' (405), or an internal detail.
   */
  mergePull(repo: Repo, number: number): { ok: boolean; sha?: string; error?: string } {
    const pr = repo.pulls.get(number);
    if (!pr) return { ok: false, error: 'not_found' };
    if (pr.merged) return { ok: true, sha: pr.merge_commit_sha ?? undefined };
    const headSha = this.branchTip(repo, pr.head);
    const baseTip = this.branchTip(repo, pr.base);
    if (!headSha || !baseTip) return { ok: false, error: 'conflict' };
    const headTree = this.commitTree(repo, headSha);
    const baseTree = this.commitTree(repo, baseTip);
    // Conflict detection: if a file changed in head vs its merge-base differs from current base's version
    const mergeBaseTree = this.commitTree(repo, pr.mergeBaseSha);
    const headFiles = this.listTree(repo, headTree);
    const mergeBaseFiles = this.listTree(repo, mergeBaseTree);
    const currentBaseFiles = this.listTree(repo, baseTree);
    const changedPaths: string[] = [];
    for (const [path, info] of headFiles) {
      const mb = mergeBaseFiles.get(path);
      if (!mb || mb.oid !== info.oid) {
        changedPaths.push(path);
        const cur = currentBaseFiles.get(path);
        if (mb && cur && cur.oid !== mb.oid && cur.oid !== info.oid) {
          // base changed since the branch point and head also changed it => conflict
          return { ok: false, error: 'conflict' };
        }
      }
    }
    for (const [path] of mergeBaseFiles) {
      if (!headFiles.has(path)) changedPaths.push(path);
    }
    // Build merged tree: start from current base files, apply head changes
    const mergedFiles = new Map<string, { oid: string; mode: string }>();
    for (const [path, info] of currentBaseFiles) mergedFiles.set(path, info);
    for (const [path, info] of headFiles) {
      const mb = mergeBaseFiles.get(path);
      if (!mb || mb.oid !== info.oid) mergedFiles.set(path, info);
    }
    // deletions: files present in mergebase but absent in head
    for (const [path] of mergeBaseFiles) {
      if (!headFiles.has(path)) mergedFiles.delete(path);
    }
    const fileMap = new Map<string, Buffer>();
    for (const [path, info] of mergedFiles) {
      const obj = this.lookupObject(repo, info.oid);
      if (obj) fileMap.set(path, obj.data);
    }
    const treeSha = this.buildTreeForFiles(repo, fileMap);
    const commitSha = this.commit(repo, {
      tree: treeSha,
      parents: [baseTip, headSha],
      message: `Merge pull request #${number} from ${pr.head}`,
      author: `Hermes <hermes@make.fun>`,
    });
    repo.refs.set(`refs/heads/${pr.base}`, commitSha);
    pr.merged = true;
    pr.state = 'merged';
    pr.merge_commit_sha = commitSha;
    pr.merged_at = this.now();
    pr.updated_at = this.now();
    repo.seq += 1;
    repo.pushed_at = this.now();
    return { ok: true, sha: commitSha };
  }
}

export function fileDiff(store: ForgeStore, repo: Repo, baseTree: string, headTree: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseFiles = store.listTree(repo, baseTree);
  const headFiles = store.listTree(repo, headTree);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const allPaths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of allPaths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (!h) {
      // deletion
      const obj = store.lookupObject(repo, b!.oid);
      const lines = obj ? obj.data.toString('utf8').split('\n').length : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (!b) {
      const obj = store.lookupObject(repo, h.oid);
      const lines = obj ? obj.data.toString('utf8').split('\n').length : 1;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (b.oid !== h.oid) {
      const bo = store.lookupObject(repo, b.oid);
      const ho = store.lookupObject(repo, h.oid);
      const bt = bo ? bo.data.toString('utf8') : '';
      const ht = ho ? ho.data.toString('utf8') : '';
      const bLines = bt.split('\n');
      const hLines = ht.split('\n');
      let additions = 0;
      let deletions = 0;
      for (const l of hLines) if (!bLines.includes(l)) additions += 1;
      for (const l of bLines) if (!hLines.includes(l)) deletions += 1;
      if (additions === 0 && deletions === 0) { additions = 1; }
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}
