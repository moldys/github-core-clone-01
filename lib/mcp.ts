// MCP server (JSON-RPC 2.0, Streamable HTTP, revision 2026-07-28) at /mcp.

import { ServerResponse } from 'node:http';
import type { ForgeStore } from './store.ts';

interface McpContext {
  store: ForgeStore;
  login: string;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

const PROTOCOL_VERSION = '2026-07-28';

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Optional description' },
        private: { type: 'boolean', description: 'Private repository flag' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get repository details.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        sort: { type: 'string' },
        direction: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

function jsonText(v: unknown): string {
  return JSON.stringify(v);
}

function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  const a = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');
  switch (name) {
    case 'create_repo': {
      const repoName = a('name');
      if (!repoName) return textResult(jsonText({ error: 'name is required' }), true);
      const exists = store.getRepo(ctx.login, repoName);
      if (exists) return textResult(jsonText({ error: 'repository already exists' }), true);
      const repo = store.createRepo(ctx.login, repoName, args.private === true, a('description'));
      return textResult(jsonText({ id: repo.id, name: repo.name, full_name: repo.fullName, private: repo.private }));
    }
    case 'get_repo': {
      const owner = a('owner');
      const name = a('repo');
      const repo = store.getRepo(owner, name);
      if (!repo) return textResult(jsonText({ error: 'repository not found' }), true);
      return textResult(jsonText({ id: repo.id, name: repo.name, full_name: repo.fullName, owner: repo.owner, private: repo.private, description: repo.description }));
    }
    case 'create_issue': {
      const owner = a('owner');
      const name = a('repo');
      const repo = store.getRepo(owner, name);
      if (!repo) return textResult(jsonText({ error: 'repository not found' }), true);
      const title = a('title');
      if (!title) return textResult(jsonText({ error: 'title is required' }), true);
      const labels = Array.isArray(args.labels) ? args.labels.filter((x): x is string => typeof x === 'string') : [];
      const issue = store.createIssue(repo, title, a('body'), labels);
      return textResult(jsonText({ id: issue.id, number: issue.number, title: issue.title, state: issue.state }));
    }
    case 'list_issues': {
      const owner = a('owner');
      const name = a('repo');
      const repo = store.getRepo(owner, name);
      if (!repo) return textResult(jsonText({ error: 'repository not found' }), true);
      const state = a('state') || undefined;
      const issues = store.listIssues(repo, state, undefined, undefined);
      return textResult(jsonText(issues.map((i) => ({ id: i.id, number: i.number, title: i.title, state: i.state }))));
    }
    case 'create_pull_request': {
      const owner = a('owner');
      const name = a('repo');
      const repo = store.getRepo(owner, name);
      if (!repo) return textResult(jsonText({ error: 'repository not found' }), true);
      const result = store.createPull(repo, a('title'), a('body'), a('head'), a('base') || repo.defaultBranch);
      if (typeof result === 'string') return textResult(jsonText({ error: result }), true);
      return textResult(jsonText({ id: result.id, number: result.number, title: result.title, state: result.state, head: result.head, base: result.base }));
    }
    case 'merge_pull_request': {
      const owner = a('owner');
      const name = a('repo');
      const repo = store.getRepo(owner, name);
      if (!repo) return textResult(jsonText({ error: 'repository not found' }), true);
      const number = Number(args.pull_number);
      if (!Number.isInteger(number)) return textResult(jsonText({ error: 'pull_number is required' }), true);
      const result = store.mergePull(repo, number);
      if (result.error === 'not_found') return textResult(jsonText({ error: 'pull request not found' }), true);
      if (result.error === 'conflict') return textResult(jsonText({ error: 'merge conflict' }), true);
      return textResult(jsonText({ merged: true, sha: result.sha }));
    }
    default:
      return textResult(jsonText({ error: `unknown tool: ${name}` }), true);
  }
}

export function handleMcp(ctx: McpContext, body: Buffer, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }

  const respond = (rpc: unknown): void => {
    const text = JSON.stringify(rpc);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  if (Array.isArray(parsed)) {
    const out: unknown[] = [];
    for (const item of parsed) {
      const r = handleOne(ctx, item);
      if (r) out.push(r);
    }
    respond(out);
    return;
  }

  const r = handleOne(ctx, parsed as RpcRequest);
  if (r) respond(r);
  else {
    res.writeHead(202, { 'content-length': '0' });
    res.end();
  }
}

function handleOne(ctx: McpContext, req: RpcRequest): RpcRequest | null {
  if (!req || typeof req !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const id = req.id !== undefined ? req.id : null;
  const method = req.method;
  if (!method) return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'github-core-clone-forge', version: '0.1.0' },
        instructions: 'GitHub-compatible forge API',
      },
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const params = req.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
    if (!name) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: tool name required' } };
    if (!TOOLS.some((t) => t.name === name)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    const result = callTool(ctx, name, args);
    return { jsonrpc: '2.0', id, result };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}
