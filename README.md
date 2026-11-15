# github-core-clone-forge

A standalone, GitHub-compatible git forge in a single Node process. No dependencies
beyond Node built-ins (Node 22+, TypeScript run directly via `node --experimental-strip-types`).

## Surface

| Area | Route | Notes |
| --- | --- | --- |
| git smart HTTP | `/{owner}/{repo}.git/...` | upload-pack protocol v2 (ls-refs/fetch) with v0 fallback; receive-pack v0 with report-status / side-band-64k / delete-refs |
| REST v3 | `/api/v3` | repos, contents, labels, issues, pulls, merge, meta, user |
| GraphQL v4 | `/api/graphql` | introspection (Issue/PullRequest/Repository/SearchType), issue ordering, createPullRequest, multiple operations |
| MCP | `/mcp` | JSON-RPC 2.0 Streamable HTTP (2026-07-28): create_repo / get_repo / create_issue / list_issues / create_pull_request / merge_pull_request |
| health | `/healthz` | `{"ok":true}` |

Auth is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` on every API route; 401 without a token.
All REST replies are JSON and carry a non-empty `X-GitHub-Request-Id` header. Malformed JSON is
400; unknown routes are 404 JSON. Pushes are fast-forward only (non-fast-forward → `ng <ref> non-fast-forward`).

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` implements the make.fun entry<->env lifecycle: binds an ephemeral port, POSTs it to
`${MAKEFUN_ENV_URL}/register`, then polls `${MAKEFUN_ENV_URL}/done` and exits 0 when done.

## Local test

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:9999 MAKEFUN_SHOP_TOKEN=test ./scripts/smoke.sh
```

The smoke script boots the server with a dummy env, exercises REST, GraphQL, MCP, and real
`git clone`/`git push` against the local server, then reports pass/fail per check.
