// A minimal GraphQL v4 executor covering the documents the suite sends.
// Supports operations, variables, inline fragments, aliases, batching, and introspection.

import type { ForgeStore, Repo } from './store.ts';

export interface GraphQLBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct';
  value: string;
}

interface FieldAST {
  kind: 'field';
  alias?: string;
  name: string;
  args?: ArgAST[];
  selection?: SelAST[];
}

interface FragAST {
  kind: 'frag';
  typeCond?: string;
  selection: SelAST[];
}

type SelAST = FieldAST | FragAST;

interface ArgAST {
  name: string;
  value: AstValue;
}

type AstValue =
  | { kind: 'int' | 'float' | 'string'; value: string | number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: AstValue[] }
  | { kind: 'object'; fields: ArgAST[] };

interface OpAST {
  op: 'query' | 'mutation';
  name?: string;
  selection: SelAST[];
}

class Lexer {
  private pos = 0;
  private src: string;
  constructor(src: string) {
    this.src = src;
  }

  next(): Token | null {
    const src = this.src;
    while (this.pos < src.length) {
      const ch = src[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\uFEFF' || ch === ',') {
        this.pos++;
        continue;
      }
      break;
    }
    if (this.pos >= src.length) return null;
    const ch = src[this.pos];
    if (ch === '#' ) {
      while (this.pos < src.length && src[this.pos] !== '\n') this.pos++;
      return this.next();
    }
    if ('!$():=@[]{}&|'.includes(ch)) {
      this.pos++;
      return { kind: 'punct', value: ch };
    }
    if (ch === '"') {
      let out = '';
      this.pos++;
      while (this.pos < src.length) {
        const c = src[this.pos];
        if (c === '"') { this.pos++; break; }
        if (c === '\\') {
          this.pos++;
          const e = src[this.pos];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u') {
            const hex = src.slice(this.pos + 1, this.pos + 5);
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
          } else out += e;
          this.pos++;
        } else {
          out += c;
          this.pos++;
        }
      }
      return { kind: 'string', value: out };
    }
    if (/[0-9]/.test(ch)) {
      let num = '';
      let isFloat = false;
      while (this.pos < src.length && /[0-9]/.test(src[this.pos])) { num += src[this.pos]; this.pos++; }
      if (src[this.pos] === '.') { isFloat = true; num += '.'; this.pos++; while (this.pos < src.length && /[0-9]/.test(src[this.pos])) { num += src[this.pos]; this.pos++; } }
      return { kind: isFloat ? 'float' : 'int', value: num };
    }
    if (/[A-Za-z_]/.test(ch)) {
      let name = '';
      while (this.pos < src.length && /[A-Za-z0-9_]/.test(src[this.pos])) { name += src[this.pos]; this.pos++; }
      return { kind: 'name', value: name };
    }
    // punctuation like ... (three dots)
    if (src.startsWith('...', this.pos)) {
      this.pos += 3;
      return { kind: 'punct', value: '...' };
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${this.pos}`);
  }
}

class Parser {
  private toks: Token[] = [];
  private i = 0;
  constructor(src: string) {
    const lex = new Lexer(src);
    for (;;) {
      const t = lex.next();
      if (!t) break;
      this.toks.push(t);
    }
  }

  private peek(): Token | null {
    return this.toks[this.i] ?? null;
  }

  private take(): Token | null {
    const t = this.toks[this.i];
    if (t) this.i++;
    return t ?? null;
  }

  private expect(value: string): void {
    const t = this.take();
    if (!t || t.kind !== 'punct' || t.value !== value) throw new Error(`expected '${value}'`);
  }

  parseDocument(): OpAST[] {
    const ops: OpAST[] = [];
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        ops.push(this.parseOperation());
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.skipFragment();
      } else {
        throw new Error(`unexpected token ${t.value}`);
      }
    }
    return ops;
  }

  private skipFragment(): void {
    this.take(); // fragment
    this.take(); // name
    this.take(); // on
    this.take(); // type
    this.parseSelectionSet();
  }

  private parseOperation(): OpAST {
    const opTok = this.take()!;
    const op = opTok.value as 'query' | 'mutation';
    let name: string | undefined;
    const t = this.peek();
    if (t && t.kind === 'name' && t.value !== 'on') {
      name = this.take()!.value;
    }
    // variable definitions
    let t2 = this.peek();
    if (t2 && t2.kind === 'punct' && t2.value === '(') {
      this.skipVariableDefs();
    }
    t2 = this.peek();
    while (t2 && t2.kind === 'punct' && t2.value === '@') {
      this.skipDirective();
      t2 = this.peek();
    }
    const selection = this.parseSelectionSet();
    return { op, name, selection };
  }

  private skipVariableDefs(): void {
    this.expect('(');
    for (;;) {
      const t = this.peek();
      if (!t || (t.kind === 'punct' && t.value === ')')) break;
      this.take(); // $name
      this.take(); // :
      this.skipType();
    }
    this.expect(')');
  }

  private skipType(): void {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === '[') {
      this.take();
      this.skipType();
      this.expect(']');
    } else if (t && t.kind === 'name') {
      this.take();
    }
    const t2 = this.peek();
    if (t2 && t2.kind === 'punct' && t2.value === '!') this.take();
  }

  private skipDirective(): void {
    this.take(); // @
    this.take(); // name
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === '(') {
      this.skipArgs();
    }
  }

  private parseSelectionSet(): SelAST[] {
    this.expect('{');
    const sels: SelAST[] = [];
    for (;;) {
      const t = this.peek();
      if (!t) throw new Error('unterminated selection set');
      if (t.kind === 'punct' && t.value === '}') {
        this.take();
        break;
      }
      if (t.kind === 'punct' && t.value === '...') {
        this.take();
        const t2 = this.peek();
        if (t2 && t2.kind === 'name' && t2.value === 'on') {
          this.take();
          const typeName = this.take()!.value;
          const selection = this.parseSelectionSet();
          sels.push({ kind: 'frag', typeCond: typeName, selection });
        } else {
          this.take(); // fragment name
        }
        continue;
      }
      sels.push(this.parseField());
    }
    return sels;
  }

  private parseField(): FieldAST {
    let alias: string | undefined;
    const first = this.take()!;
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === ':') {
      this.take();
      alias = first.value;
      const nameTok = this.take()!;
      const field: FieldAST = { kind: 'field', alias, name: nameTok.value };
      let t2 = this.peek();
      if (t2 && t2.kind === 'punct' && t2.value === '(') field.args = this.skipArgs();
      t2 = this.peek();
      while (t2 && t2.kind === 'punct' && t2.value === '@') {
        this.skipDirective();
        t2 = this.peek();
      }
      t2 = this.peek();
      if (t2 && t2.kind === 'punct' && t2.value === '{') field.selection = this.parseSelectionSet();
      return field;
    }
    const field: FieldAST = { kind: 'field', name: first.value };
    let t2 = this.peek();
    if (t2 && t2.kind === 'punct' && t2.value === '(') field.args = this.skipArgs();
    t2 = this.peek();
    while (t2 && t2.kind === 'punct' && t2.value === '@') {
      this.skipDirective();
      t2 = this.peek();
    }
    t2 = this.peek();
    if (t2 && t2.kind === 'punct' && t2.value === '{') field.selection = this.parseSelectionSet();
    return field;
  }

  private skipArgs(): ArgAST[] {
    this.expect('(');
    const args: ArgAST[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || (t.kind === 'punct' && t.value === ')')) break;
      const name = this.take()!.value;
      this.expect(':');
      const value = this.parseValue();
      args.push({ name, value });
    }
    this.expect(')');
    return args;
  }

  private parseValue(): AstValue {
    const t = this.take();
    if (!t) throw new Error('expected value');
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'punct') {
      if (t.value === '$') {
        const name = this.take()!.value;
        return { kind: 'variable', name };
      }
      if (t.value === '[') {
        const items: AstValue[] = [];
        for (;;) {
          const t2 = this.peek();
          if (!t2 || (t2.kind === 'punct' && t2.value === ']')) break;
          items.push(this.parseValue());
        }
        this.expect(']');
        return { kind: 'list', items };
      }
      if (t.value === '{') {
        const fields: ArgAST[] = [];
        for (;;) {
          const t2 = this.peek();
          if (!t2 || (t2.kind === 'punct' && t2.value === '}')) break;
          const name = this.take()!.value;
          this.expect(':');
          const value = this.parseValue();
          fields.push({ name, value });
        }
        this.expect('}');
        return { kind: 'object', fields };
      }
      throw new Error('unexpected punctuation in value');
    }
    if (t.value === 'true') return { kind: 'bool', value: true };
    if (t.value === 'false') return { kind: 'bool', value: false };
    if (t.value === 'null') return { kind: 'null' };
    return { kind: 'enum', value: t.value };
  }
}

function evaluateValue(v: AstValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'int':
    case 'float':
    case 'string':
      return v.value;
    case 'bool':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'variable':
      return variables[v.name] ?? null;
    case 'list':
      return v.items.map((i) => evaluateValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = evaluateValue(f.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface Typed {
  t: string;
  v: unknown;
}

interface ExecCtx {
  store: ForgeStore;
  login: string;
}

type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const SCALAR = { t: 'SCALAR', v: null };

function wrap(t: string, v: unknown): Typed {
  return { t, v };
}

const resolvers: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_p, _args, ctx) => wrap('User', { login: ctx.login }),
    repository: (_p, args, ctx) => {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? wrap('Repository', repo) : null;
    },
    node: (_p, args, ctx) => {
      const id = args.id as string;
      if (typeof id !== 'string') return null;
      if (id.startsWith('repo:')) {
        const dbId = Number(id.slice(5));
        for (const repo of ctx.store.repos.values()) {
          if (repo.dbId === dbId) return wrap('Repository', repo);
        }
      }
      return null;
    },
    __type: (_p, args) => {
      const name = args.name as string;
      if (typeof name !== 'string') return null;
      if (typeFields[name] || typeEnumValues[name]) return wrap('__Type', { name, kind: typeEnumValues[name] ? 'ENUM' : 'OBJECT' });
      return null;
    },
  },
  User: {
    login: (v) => (v as { login: string }).login,
    id: (v) => (v as { id?: number }).id ?? 1000,
    name: (v) => (v as { name?: string }).name ?? '',
  },
  Repository: {
    id: (v) => (v as Repo).id,
    databaseId: (v) => (v as Repo).dbId,
    name: (v) => (v as Repo).name,
    nameWithOwner: (v) => (v as Repo).fullName,
    owner: (v) => wrap('User', { login: (v as Repo).owner }),
    defaultBranchRef: (v) => wrap('Ref', { name: (v as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (v, args) => {
      const repo = v as Repo;
      const number = args.number as number;
      const issue = repo.issues.get(number);
      return issue ? wrap('Issue', { repo, issue }) : null;
    },
    issues: (v, args, ctx) => {
      const repo = v as Repo;
      return wrap('IssueConnection', issueConnection(ctx.store, repo, args));
    },
    pullRequests: (v, args) => {
      const repo = v as Repo;
      const first = (args.first as number) ?? 30;
      const pulls = [...repo.pulls.values()].filter((p) => p.state === 'open').sort((a, b) => b.number - a.number).slice(0, first);
      return wrap('PullRequestConnection', { nodes: pulls.map((p) => ({ repo, pull: p })) });
    },
    pullRequest: (v, args) => {
      const repo = v as Repo;
      const number = args.number as number;
      const pull = repo.pulls.get(number);
      return pull ? wrap('PullRequest', { repo, pull }) : null;
    },
  },
  Ref: {
    name: (v) => (v as { name: string }).name,
  },
  Issue: {
    id: (v) => (v as { issue: import('./store.ts').Issue }).issue.id,
    number: (v) => (v as { issue: import('./store.ts').Issue }).issue.number,
    title: (v) => (v as { issue: import('./store.ts').Issue }).issue.title,
    state: (v) => ((v as { issue: import('./store.ts').Issue }).issue.state === 'closed' ? 'CLOSED' : 'OPEN'),
    body: (v) => (v as { issue: import('./store.ts').Issue }).issue.body,
  },
  IssueConnection: {
    nodes: (v) => (v as { nodes: unknown[] }).nodes,
    pageInfo: (v) => wrap('PageInfo', (v as { pageInfo: unknown }).pageInfo),
  },
  PageInfo: {
    hasNextPage: (v) => (v as { hasNextPage: boolean }).hasNextPage,
    endCursor: (v) => (v as { endCursor: string }).endCursor,
  },
  PullRequest: {
    id: (v) => (v as { pull: import('./store.ts').PullRequest }).pull.id,
    number: (v) => (v as { pull: import('./store.ts').PullRequest }).pull.number,
    state: (v) => {
      const p = (v as { pull: import('./store.ts').PullRequest }).pull;
      return p.state === 'merged' ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : 'OPEN';
    },
    merged: (v) => (v as { pull: import('./store.ts').PullRequest }).pull.merged,
    headRefName: (v) => (v as { pull: import('./store.ts').PullRequest }).pull.head,
    baseRefName: (v) => (v as { pull: import('./store.ts').PullRequest }).pull.base,
    mergeable: () => 'MERGEABLE',
    files: (v, args) => {
      const { repo, pull } = v as { repo: Repo; pull: import('./store.ts').PullRequest };
      const first = (args.first as number) ?? 10;
      const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
      const files = diffFiles(repo, pull.baseSha, headTip);
      return wrap('PullRequestChangedFileConnection', { nodes: files.slice(0, first).map((f) => ({ path: f })) });
    },
    merge_commit_sha: (v) => (v as { pull: import('./store.ts').PullRequest }).pull.merge_commit_sha,
  },
  PullRequestConnection: {
    nodes: (v) => (v as { nodes: unknown[] }).nodes,
  },
  PullRequestChangedFileConnection: {
    nodes: (v) => (v as { nodes: unknown[] }).nodes,
  },
  PullRequestChangedFile: {
    path: (v) => (v as { path: string }).path,
  },
  __Type: {
    kind: (v) => (v as { kind: string }).kind,
    name: (v) => (v as { name: string }).name,
    fields: (v) => {
      const name = (v as { name: string }).name;
      const list = (typeFields[name] ?? []).map((f) => ({ name: f }));
      return wrap('__TypeFieldList', list);
    },
    enumValues: (v) => {
      const name = (v as { name: string }).name;
      const list = (typeEnumValues[name] ?? []).map((f) => ({ name: f }));
      return wrap('__TypeEnumList', list);
    },
  },
  __TypeFieldList: {
    // handle arrays in executor
  },
  __TypeEnumList: {},
  __TypeField: {
    name: (v) => (v as { name: string }).name,
  },
  Mutation: {
    createIssue: (_p, args, ctx) => {
      const input = (args.input as Record<string, unknown>) ?? {};
      const repo = findRepoById(ctx.store, input.repositoryId as string);
      if (!repo) return null;
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return wrap('CreateIssuePayload', { repo, issue });
    },
    closeIssue: (_p, args, ctx) => {
      const input = (args.input as Record<string, unknown>) ?? {};
      const issueId = input.issueId as string;
      for (const repo of ctx.store.repos.values()) {
        for (const issue of repo.issues.values()) {
          if (issue.id === issueId) {
            issue.state = 'closed';
            issue.updated_at = new Date().toISOString();
            return wrap('CloseIssuePayload', { repo, issue });
          }
        }
      }
      return null;
    },
    createPullRequest: (_p, args, ctx) => {
      const input = (args.input as Record<string, unknown>) ?? {};
      const repo = findRepoById(ctx.store, input.repositoryId as string);
      if (!repo) return null;
      const base = String(input.baseRefName ?? repo.defaultBranch);
      const head = String(input.headRefName ?? '');
      const title = String(input.title ?? '');
      const result = ctx.store.createPull(repo, title, '', head, base);
      if (typeof result === 'string') return null;
      return wrap('CreatePullRequestPayload', { repo, pull: result });
    },
    mergePullRequest: (_p, args, ctx) => {
      const input = (args.input as Record<string, unknown>) ?? {};
      const pullId = input.pullRequestId as string;
      for (const repo of ctx.store.repos.values()) {
        for (const pull of repo.pulls.values()) {
          if (pull.id === pullId) {
            ctx.store.mergePull(repo, pull.number);
            return wrap('MergePullRequestPayload', { repo, pull });
          }
        }
      }
      return null;
    },
    addComment: (_p, args, ctx) => {
      const input = (args.input as Record<string, unknown>) ?? {};
      const subjectId = input.subjectId as string;
      const body = String(input.body ?? '');
      for (const repo of ctx.store.repos.values()) {
        for (const issue of repo.issues.values()) {
          if (issue.id === subjectId) {
            const comment = ctx.store.addComment(repo, issue.number, body);
            if (comment) return wrap('AddCommentPayload', { comment });
          }
        }
      }
      return null;
    },
  },
  CreateIssuePayload: {
    issue: (v) => wrap('Issue', v as { repo: Repo; issue: unknown }),
  },
  CloseIssuePayload: {
    issue: (v) => wrap('Issue', v as { repo: Repo; issue: unknown }),
  },
  CreatePullRequestPayload: {
    pullRequest: (v) => wrap('PullRequest', v as { repo: Repo; pull: unknown }),
  },
  MergePullRequestPayload: {
    pullRequest: (v) => wrap('PullRequest', v as { repo: Repo; pull: unknown }),
  },
  AddCommentPayload: {
    commentEdge: (v) => wrap('CommentEdge', { comment: (v as { comment: unknown }).comment, repo: null }),
  },
  CommentEdge: {
    node: (v) => wrap('Comment', v as { comment: unknown }),
  },
  Comment: {
    id: (v) => `c:${(v as { comment: { id: number } }).comment.id}`,
    body: (v) => (v as { comment: { body: string } }).comment.body,
  },
};

function findRepoById(store: ForgeStore, id: unknown): Repo | null {
  if (typeof id !== 'string' || !id.startsWith('repo:')) return null;
  const dbId = Number(id.slice(5));
  for (const repo of store.repos.values()) {
    if (repo.dbId === dbId) return repo;
  }
  return null;
}

function issueConnection(store: ForgeStore, repo: Repo, args: Record<string, unknown>): { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string } } {
  const first = (args.first as number) ?? 30;
  const states = args.states as string[] | undefined;
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const after = args.after as string | undefined;
  let issues = [...repo.issues.values()];
  if (Array.isArray(states)) {
    if (states.includes('OPEN') && !states.includes('CLOSED')) issues = issues.filter((i) => i.state === 'open');
    else if (states.includes('CLOSED') && !states.includes('OPEN')) issues = issues.filter((i) => i.state === 'closed');
  }
  const dir = orderBy?.direction === 'ASC' ? 1 : -1;
  if (orderBy?.field === 'CREATED_AT') {
    issues.sort((a, b) => (a.createdAt - b.createdAt) * dir || (a.number - b.number) * dir);
  } else {
    issues.sort((a, b) => (b.number - a.number) * dir);
  }
  const cursorIndex = after ? issues.findIndex((i) => i.id === after) : -1;
  const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  const slice = issues.slice(start, start + first);
  const hasNextPage = start + first < issues.length;
  const endCursor = slice.length ? slice[slice.length - 1].id : null;
  return {
    nodes: slice.map((issue) => ({ repo, issue })),
    pageInfo: { hasNextPage, endCursor: endCursor ?? '' },
  };
}

function diffFiles(repo: Repo, baseSha: string, headTip: string): string[] {
  const baseTree = getCommitTree(repo, baseSha);
  const headTree = getCommitTree(repo, headTip);
  const baseFiles = treeFiles(repo, baseTree);
  const headFiles = treeFiles(repo, headTree);
  const out = new Set<string>();
  for (const p of baseFiles.keys()) if (!headFiles.has(p)) out.add(p);
  for (const p of headFiles.keys()) {
    if (!baseFiles.has(p)) out.add(p);
    else if (baseFiles.get(p) !== headFiles.get(p)) out.add(p);
  }
  return [...out];
}

function getCommitTree(repo: Repo, sha: string): string {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return sha;
  const blank = obj.data.indexOf('\n\n');
  const header = obj.data.subarray(0, blank < 0 ? obj.data.length : blank).toString('utf8');
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) return line.slice(5);
  }
  return sha;
}

function treeFiles(repo: Repo, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    const data = obj.data;
    let off = 0;
    while (off < data.length) {
      const space = data.indexOf(0x20, off);
      const nul = data.indexOf(0x00, space + 1);
      const mode = data.subarray(off, space).toString('ascii');
      const name = data.subarray(space + 1, nul).toString('utf8');
      const entryOid = data.subarray(nul + 1, nul + 21).toString('hex');
      const path = prefix ? `${prefix}/${name}` : name;
      if (mode === '40000') walk(entryOid, path);
      else out.set(path, entryOid);
      off = nul + 21;
    }
  };
  walk(treeOid, '');
  return out;
}

const typeFields: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url', 'closed', 'closedAt'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'url', 'createdAt', 'updatedAt', 'mergeCommit', 'isDraft', 'author'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'startCursor', 'hasPreviousPage'],
  SearchType: [],
};

const typeEnumValues: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// selection execution
// ---------------------------------------------------------------------------

interface ExecResult {
  data: unknown;
  errors: { message: string }[];
}

function executeOp(op: OpAST, variables: Record<string, unknown>, ctx: ExecCtx): ExecResult {
  const errors: { message: string }[] = [];
  const rootType = op.op === 'query' ? 'Query' : 'Mutation';
  const data = executeSelectionSet(rootType, wrap(rootType, {}), op.selection, ctx, errors, variables);
  return { data, errors };
}

function executeSelectionSet(typeName: string, value: Typed, selections: SelAST[], ctx: ExecCtx, errors: { message: string }[], variables: Record<string, unknown>): unknown {
  const vals = unwrapList(value);
  if (Array.isArray(vals)) {
    const elemType = elementTypeOf(typeName);
    return vals.map((item) => {
      const isTyped = item !== null && typeof item === 'object' && 't' in (item as object) && 'v' in (item as object);
      const typed = isTyped ? (item as Typed) : wrap(elemType, item);
      return executeSelectionSet(typed.t, typed, selections, ctx, errors, variables);
    });
  }
  if (value.v === null || value.v === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'frag') {
      const sub = executeSelectionSet(typeName, value, sel.selection, ctx, errors, variables);
      if (typeof sub === 'object' && sub !== null && !Array.isArray(sub)) {
        Object.assign(out, sub);
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const fn = resolvers[typeName]?.[sel.name];
    if (!fn) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const a of sel.args ?? []) args[a.name] = evaluateValue(a.value, variables);
    let res: unknown;
    try {
      res = fn(value.v, args, ctx);
    } catch {
      errors.push({ message: `Internal error resolving "${sel.name}".` });
      continue;
    }
    if (sel.selection && res !== null && res !== undefined) {
      const typed = normalizeTyped(res, childType(typeName, sel.name));
      const sub = executeSelectionSet(typed.t, typed, sel.selection, ctx, errors, variables);
      if (errors.length && sub === null) {
        out[key] = null;
      } else {
        out[key] = sub;
      }
    } else {
      out[key] = unwrapScalar(res);
    }
  }
  return out;
}

const reflectVars: Record<string, unknown> = {};

function unwrapList(value: Typed): unknown {
  return value.v;
}

function normalizeTyped(res: unknown, fallbackType: string): Typed {
  if (res && typeof res === 'object' && 't' in (res as object) && 'v' in (res as object)) {
    return res as Typed;
  }
  return wrap(fallbackType, res);
}

function unwrapScalar(res: unknown): unknown {
  if (res && typeof res === 'object' && 't' in (res as object) && 'v' in (res as object)) {
    return (res as Typed).v;
  }
  return res;
}

function childType(parentType: string, field: string): string {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
    User: {},
    Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
    PullRequest: { files: 'PullRequestChangedFileConnection', mergeCommit: 'Commit' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
    __Type: { fields: '__TypeFieldList', enumValues: '__TypeEnumList', inputFields: '__TypeFieldList' },
    __TypeFieldList: { nodes: '__TypeField' },
    __TypeEnumList: { nodes: '__TypeField' },
  };
  return map[parentType]?.[field] ?? 'SCALAR';
}

function elementTypeOf(parentType: string): string {
  const map: Record<string, string> = {
    __TypeFieldList: '__TypeField',
    __TypeEnumList: '__TypeField',
    IssueConnection: 'Issue',
    PullRequestConnection: 'PullRequest',
    PullRequestChangedFileConnection: 'PullRequestChangedFile',
  };
  return map[parentType] ?? parentType;
}

export function runGraphQL(body: unknown, ctx: ExecCtx): { status: number; body: unknown } {
  let docs: Array<{ query: string; variables?: Record<string, unknown> }>;
  if (Array.isArray(body)) {
    docs = body.map((b) => (typeof b === 'object' && b !== null ? b as { query: string; variables?: Record<string, unknown> } : { query: '' }));
  } else if (body && typeof body === 'object') {
    const b = body as { query?: unknown; variables?: unknown; operationName?: unknown };
    docs = [{ query: typeof b.query === 'string' ? b.query : '', variables: typeof b.variables === 'object' && b.variables !== null ? (b.variables as Record<string, unknown>) : {} }];
  } else {
    docs = [{ query: '' }];
  }

  const responses = docs.map((doc) => {
    try {
      const parser = new Parser(doc.query);
      const ops = parser.parseDocument();
      if (ops.length === 0) throw new Error('no operation');
      const op = ops[0];
      const variables = doc.variables ?? {};
      const { data, errors } = executeOp(op, variables, ctx);
      if (errors.length) return { data, errors };
      return { data };
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  });

  if (Array.isArray(body)) {
    return { status: 200, body: responses };
  }
  return { status: 200, body: responses[0] };
}
