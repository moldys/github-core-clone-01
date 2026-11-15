// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4, MCP, and the health probe.
// app.ts is the server; main.ts (the entry<->env lifecycle) stays as the starter ships it.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';
import { handleRest, sendJson } from './rest.ts';
import { runGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { ForgeStore, VIEWER_LOGIN } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 64 * 1024 * 1024;

let reqCounter = 0;

function requestId(): string {
  reqCounter += 1;
  return `req-${Date.now().toString(16)}-${reqCounter.toString(16)}`;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

function envToken(): string {
  const t = process.env.MAKEFUN_SHOP_TOKEN;
  return t && t.length > 0 ? t : 'dummy-token';
}

interface GitMatch {
  owner: string;
  repo: string;
  kind: 'refs' | 'upload-pack' | 'receive-pack';
  service?: string;
}

function matchGitPath(raw: string): GitMatch | null {
  let path: string;
  let service = '';
  try {
    const u = new URL(raw, 'http://entry');
    path = u.pathname;
    service = u.searchParams.get('service') ?? '';
  } catch {
    path = raw;
  }
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return null;
  const rawKind = m[3];
  const kind: GitMatch['kind'] = rawKind === 'info/refs' ? 'refs' : rawKind === 'git-upload-pack' ? 'upload-pack' : rawKind === 'git-receive-pack' ? 'receive-pack' : (rawKind as GitMatch['kind']);
  if (kind === 'refs') {
    return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), kind, service };
  }
  return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), kind };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new ForgeStore();
  const token = envToken();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    const rid = requestId();
    res.setHeader('X-GitHub-Request-Id', rid);

    const forbidden = (): void => {
      sendJson(res, 401, { message: 'Bad credentials' });
    };

    // health probe (no auth)
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    const isApi = path.startsWith('/api/v3') || path.startsWith('/api/graphql') || path === '/mcp' || path.startsWith('/mcp/');
    const git = matchGitPath(req.url ?? '/');

    if (isApi || git) {
      const tok = bearerToken(req);
      if (!tok || tok !== token) {
        forbidden();
        return;
      }
    }

    // git smart HTTP
    if (git) {
      if (git.kind === 'refs') {
        if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
        handleInfoRefs({ store, authorized: true }, req, res, git.owner, git.repo, git.service ?? '');
        return;
      }
      if (git.kind === 'upload-pack') {
        if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
        readBody(req).then(
          (body) => {
            try {
              handleUploadPack({ store, authorized: true }, req, res, git.owner, git.repo, body);
            } catch (e) {
              process.stderr.write(`[upload-pack error] ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
              sendJson(res, 500, { message: 'internal error' });
            }
          },
          () => sendJson(res, 400, { message: 'bad request' }),
        );
        return;
      }
      if (git.kind === 'receive-pack') {
        if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
        readBody(req).then(
          (body) => {
            try {
              handleReceivePack({ store, authorized: true }, req, res, git.owner, git.repo, body);
            } catch (e) {
              process.stderr.write(`[receive-pack error] ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
              sendJson(res, 500, { message: 'internal error' });
            }
          },
          () => sendJson(res, 400, { message: 'bad request' }),
        );
        return;
      }
    }

    // REST v3
    if (path.startsWith('/api/v3')) {
      if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const bodyPromise = (method === 'GET') ? Promise.resolve<Buffer | null>(null) : readBody(req).then((b) => b as Buffer | null, () => null);
        bodyPromise.then((body) => {
          try {
            const u = new URL(req.url ?? '/', 'http://entry');
            const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
            handleRest({ store, login: tokenOwner() }, method, u.pathname, u.search, body, res, baseUrl);
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
          }
        });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // GraphQL v4
    if (path === '/api/graphql') {
      if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
      readBody(req).then(
        (body) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return;
          }
          const { status, body: out } = runGraphQL(parsed, { store, login: tokenOwner() });
          sendJson(res, status, out);
        },
        () => sendJson(res, 400, { message: 'bad request' }),
      );
      return;
    }

    // MCP
    if (path === '/mcp' || path.startsWith('/mcp/')) {
      if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
      readBody(req).then(
        (body) => handleMcp({ store, login: tokenOwner() }, body, res),
        () => sendJson(res, 400, { message: 'bad request' }),
      );
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  });
}

/** The identity the token maps to: the scenario's viewer login (the suite's fixed token owner). */
function tokenOwner(): string {
  const login = process.env.MAKEFUN_SHOP_LOGIN;
  return login && login.length > 0 ? login : VIEWER_LOGIN;
}
