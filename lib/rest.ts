// GitHub REST v3 surface under /api/v3.
// v2 rev: rebuilt via write_file in a fresh agent session.

import { ServerResponse } from 'node:http';
import { DEFAULT_BRANCH, fileDiff } from './store.ts';
import type { ForgeStore, Repo, Issue, PullRequest } from './store.ts';
import { hashObject } from './gitobj.ts';

export interface RestContext {
  store: ForgeStore;
  login: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function msg(message: string): Record<string, unknown> {
  return { message };
}

const SHA40 = /^[0-9a-f]{40}$/i;

function loginJson(login: string): Record<string, unknown> {
  return {
    login,
    id: 1000,
    node_id: `U_kg_${login}`,
    avatar_url: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    name: login,
    email: `${login}@example.invalid`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const issuesCount = repo.issues.size;
  let openIssues = 0;
  for (const i of repo.issues.values()) if (i.state === 'open') openIssues += 1;
  return {
    id: repo.dbId,
    node_id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: loginJson(repo.owner),
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    forks_url: `/api/v3/repos/${repo.fullName}/forks`,
    collaborators_url: `/api/v3/repos/${repo.fullName}/collaborators{/collaborator}`,
    teams_url: `/api/v3/repos/${repo.fullName}/teams`,
    hooks_url: `/api/v3/repos/${repo.fullName}/hooks`,
    issue_events_url: `/api/v3/repos/${repo.fullName}/issues/events{/number}`,
    events_url: `/api/v3/repos/${repo.fullName}/events`,
    assignees_url: `/api/v3/repos/${repo.fullName}/assignees{/user}`,
    branches_url: `/api/v3/repos/${repo.fullName}/branches{/branch}`,
    tags_url: `/api/v3/repos/${repo.fullName}/tags`,
    blobs_url: `/api/v3/repos/${repo.fullName}/git/blobs{/sha}`,
    git_tags_url: `/api/v3/repos/${repo.fullName}/git/tags{/sha}`,
    git_refs_url: `/api/v3/repos/${repo.fullName}/git/refs{/sha}`,
    trees_url: `/api/v3/repos/${repo.fullName}/git/trees{/sha}`,
    statuses_url: `/api/v3/repos/${repo.fullName}/statuses/{sha}`,
    languages_url: `/api/v3/repos/${repo.fullName}/languages`,
    stargazers_url: `/api/v3/repos/${repo.fullName}/stargazers`,
    contributors_url: `/api/v3/repos/${repo.fullName}/contributors`,
    subscribers_url: `/api/v3/repos/${repo.fullName}/subscribers`,
    subscription_url: `/api/v3/repos/${repo.fullName}/subscription`,
    commits_url: `/api/v3/repos/${repo.fullName}/commits{/sha}`,
    git_commits_url: `/api/v3/repos/${repo.fullName}/git/commits{/sha}`,
    comments_url: `/api/v3/repos/${repo.fullName}/comments{/number}`,
    issue_comment_url: `/api/v3/repos/${repo.fullName}/issues/comments{/number}`,
    contents_url: `/api/v3/repos/${repo.fullName}/contents/{+path}`,
    compare_url: `/api/v3/repos/${repo.fullName}/compare/{base}...{head}`,
    merges_url: `/api/v3/repos/${repo.fullName}/merges`,
    archive_url: `/api/v3/repos/${repo.fullName}/{archive_format}{/ref}`,
    downloads_url: `/api/v3/repos/${repo.fullName}/downloads`,
    issues_url: `/api/v3/repos/${repo.fullName}/issues{/number}`,
    pulls_url: `/api/v3/repos/${repo.fullName}/pulls{/number}`,
    milestones_url: `/api/v3/repos/${repo.fullName}/milestones{/number}`,
    notifications_url: `/api/v3/repos/${repo.fullName}/notifications{?since,all,participating}`,
    labels_url: `/api/v3/repos/${repo.fullName}/labels{/name}`,
    releases_url: `/api/v3/repos/${repo.fullName}/releases{/id}`,
    deployments_url: `/api/v3/repos/${repo.fullName}/deployments`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    svn_url: `https://github.com/${repo.fullName}`,
    homepage: null,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    open_issues_count: openIssues,
    license: null,
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, push: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    network_count: 0,
    subscribers_count: 0,
  };
}

function labelJson(name: string, color: string): Record<string, unknown> {
  return { id: 0, node_id: `LA_${name}`, url: '', name, color: color || 'ededed', default: false, description: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const labels = issue.labels.map((name) => {
    const l = repo.labels.get(name);
    return labelJson(name, l ? l.color : 'ededed');
  });
  return {
    id: issue.dbId,
    node_id: issue.id,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    labels_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: loginJson(repo.owner),
    labels,
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    pull_request: issue.isPullRequest ? { url: '', html_url: '', diff_url: '', patch_url: '' } : null,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_by: issue.state === 'closed' ? loginJson(repo.owner) : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headBranch = pr.head;
  const baseBranch = pr.base;
  return {
    id: pr.dbId,
    node_id: pr.id,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.fullName}/pulls/${pr.number}`,
    diff_url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}.diff`,
    patch_url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}.patch`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${pr.number}`,
    commits_url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}/comments`,
    review_comment_url: `/api/v3/repos/${repo.fullName}/pulls/comments{/number}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${pr.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.fullName}/statuses/${pr.headSha}`,
    number: pr.number,
    state: pr.state === 'merged' ? 'closed' : pr.state,
    locked: false,
    title: pr.title,
    user: loginJson(repo.owner),
    body: pr.body,
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.merged_at,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: {
      label: `${repo.owner}:${headBranch}`,
      ref: headBranch,
      sha: pr.headSha,
      user: loginJson(repo.owner),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${baseBranch}`,
      ref: baseBranch,
      sha: pr.baseSha,
      user: loginJson(repo.owner),
      repo: repoJson(repo),
    },
    _links: {
      self: { href: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}` },
      html: { href: `https://github.com/${repo.fullName}/pulls/${pr.number}` },
      issue: { href: `/api/v3/repos/${repo.fullName}/issues/${pr.number}` },
      comments: { href: `/api/v3/repos/${repo.fullName}/issues/${pr.number}/comments` },
      review_comments: { href: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}/comments` },
      commits: { href: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}/commits` },
      statuses: { href: `/api/v3/repos/${repo.fullName}/statuses/${pr.headSha}` },
    },
    author_association: 'OWNER',
    auto_merge: null,
    draft: false,
    merged: pr.merged,
    mergeable: true,
    rebaseable: true,
    mergeable_state: pr.merged ? 'merged' : 'clean',
    merged_by: pr.merged ? loginJson(repo.owner) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 1,
    deletions: 0,
    changed_files: 1,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const c = obj ? parseCommitRaw(obj.data) : { tree: '', parents: [], message: '', author: '', committer: '' };
  const author = parseIdent(c.author);
  const committer = parseIdent(c.committer);
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: { name: author.name, email: author.email, date: new Date((author.ts || 0) * 1000).toISOString() },
      committer: { name: committer.name, email: committer.email, date: new Date((committer.ts || 0) * 1000).toISOString() },
      message: c.message.replace(/\n$/, ''),
      tree: { sha: c.tree, url: `/api/v3/repos/${repo.fullName}/git/trees/${c.tree}` },
      url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${repo.fullName}/commits/${oid}`,
    html_url: `https://github.com/${repo.fullName}/commit/${oid}`,
    comments_url: `/api/v3/repos/${repo.fullName}/commits/${oid}/comments`,
    author: loginJson(repo.owner),
    committer: loginJson(repo.owner),
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.fullName}/commits/${p}`, html_url: `https://github.com/${repo.fullName}/commit/${p}` })),
    stats: { total: 0, additions: 0, deletions: 0 },
    files: [],
  };
}

function parseCommitRaw(data: Buffer): { tree: string; parents: string[]; message: string; author: string; committer: string } {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headerEnd = blank < 0 ? buf.length : blank;
  const header = buf.subarray(0, headerEnd).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (!line) continue;
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  return { tree, parents, message, author, committer };
}

function parseIdent(s: string): { name: string; email: string; ts: number } {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(s);
  if (m) return { name: m[1], email: m[2], ts: Number(m[3]) };
  return { name: s || '', email: '', ts: 0 };
}

function encodePath(path: string): string {
  return path.split('/').map((s) => encodeURIComponent(s)).join('/');
}

export function handleRest(ctx: RestContext, method: string, pathname: string, search: string, body: Buffer | null, res: ServerResponse, baseUrl = ''): void {
  const store = ctx.store;
  const segs = pathname.split('/').filter((s) => s !== '');
  // segs[0] === 'api', segs[1] === 'v3'
  const rest = segs.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
        commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/user/followers',
        following_url: '/api/v3/user/following{/target}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: 'https://github.com/hub',
        issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}{&repository_id,page,per_page,sort,order}',
        notifications_url: '/api/v3/notifications',
        organization_url: '/api/v3/orgs/{org}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        star_gazers_url: '/api/v3/user/starred',
        team_url: '/api/v3/teams',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    sendJson(res, 404, msg('Not Found'));
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') { sendJson(res, 404, msg('Not Found')); return; }
    sendJson(res, 200, { installed_version: '2.72.0', verifiable_password_authentication: true, github_services_sha: '', hooks: [], web: [], api: [], git: [], pages: [], importer: [] });
    return;
  }

  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, loginJson(ctx.login));
        return;
      }
      sendJson(res, 404, msg('Not Found'));
      return;
    }
    if (rest[1] === 'repos' && rest.length === 2) {
      if (method === 'GET') {
        const params = new URLSearchParams(search);
        const perPage = Math.max(1, Math.min(100, parseInt(params.get('per_page') ?? '30', 10) || 30));
        const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
        const all = store.listUserRepos(ctx.login);
        const start = (page - 1) * perPage;
        const items = all.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        if (start + perPage < all.length) {
          const next = `/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
          headers.link = `<${baseUrl}${next}>; rel="next"`;
        }
        sendJson(res, 200, items.map(repoJson), headers);
        return;
      }
      if (method === 'POST') {
        const b = parseJsonBody(body);
        if (!b) { sendJson(res, 400, msg('Problems parsing JSON')); return; }
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) { sendJson(res, 422, msg('Repository creation failed.')); return; }
        if (store.getRepo(ctx.login, name)) { sendJson(res, 422, msg(`Repository creation failed: repository ${name} already exists.`)); return; }
        const privateRepo = b.private === true;
        const description = typeof b.description === 'string' ? b.description : '';
        const repo = store.createRepo(ctx.login, name, privateRepo, description);
        sendJson(res, 201, repoJson(repo));
        return;
      }
      sendJson(res, 404, msg('Not Found'));
      return;
    }
    sendJson(res, 404, msg('Not Found'));
    return;
  }

  if (rest[0] === 'repos') {
    if (rest.length < 3) { sendJson(res, 404, msg('Not Found')); return; }
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const repo = store.getRepo(owner, name);
    if (!repo) { sendJson(res, 404, msg('Not Found')); return; }
    if (rest.length === 3) {
      if (method === 'GET') {
        if (owner !== ctx.login && repo.private) { sendJson(res, 401, msg('Bad credentials')); return; }
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const b = parseJsonBody(body);
        if (!b) { sendJson(res, 400, msg('Problems parsing JSON')); return; }
        if (typeof b.description === 'string') repo.description = b.description;
        repo.updated_at = new Date().toISOString();
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'content-length': '0' });
        res.end();
        return;
      }
      sendJson(res, 404, msg('Not Found'));
      return;
    }

    const what = rest[3];
    const restPath = rest.slice(4);

    if (what === 'branches') {
      if (restPath.length === 0 && method === 'GET') {
        const branches: Record<string, unknown>[] = [];
        for (const [ref, oid] of repo.refs) {
          if (ref.startsWith('refs/heads/')) {
            const branch = ref.slice('refs/heads/'.length);
            const commit = store.peelToCommit(repo, oid);
            branches.push({ name: branch, commit: { sha: commit, url: `/api/v3/repos/${repo.fullName}/commits/${commit}` } });
          }
        }
        branches.sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
        sendJson(res, 200, branches);
        return;
      }
      if (restPath.length === 1 && method === 'GET') {
        const branch = decodeURIComponent(restPath[0]);
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (!oid) { sendJson(res, 404, msg('Branch not found')); return; }
        const commit = store.peelToCommit(repo, oid);
        sendJson(res, 200, { name: branch, commit: { sha: commit, url: `/api/v3/repos/${repo.fullName}/commits/${commit}` } });
        return;
      }
      sendJson(res, 404, msg('Not Found'));
      return;
    }

    if (what === 'commits') {
      if (restPath.length === 0 && method === 'GET') {
        const params = new URLSearchParams(search);
        const sha = params.get('sha') ?? repo.defaultBranch;
        let tip = store.branchTip(repo, sha);
        if (!tip && SHA40.test(sha)) tip = sha;
        if (!tip) { sendJson(res, 404, msg('Commit not found')); return; }
        const history = store.commitHistory(repo, tip);
        sendJson(res, 200, history.map((oid) => commitJson(repo, oid)));
        return;
      }
      sendJson(res, 404, msg('Not Found'));
      return;
    }

    if (what === 'git' && restPath.length === 1 && restPath[0] === 'refs') {
      if (method === 'GET') {
        const refs: Record<string, unknown>[] = [];
        for (const [ref, oid] of repo.refs) {
          refs.push({ ref, node_id: ref, url: `/api/v3/repos/${repo.fullName}/git/refs/${encodePath(ref)}`, object: { type: 'commit', sha: oid, url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}` } });
        }
        sendJson(res, 200, refs);
        return;
      }
      if (method === 'POST') {
        const b = parseJsonBody(body);
        if (!b) { sendJson(res, 400, msg('Problems parsing JSON')); return; }
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !SHA40.test(sha)) { sendJson(res, 422, msg('Validation Failed')); return; }
        if (repo.refs.has(ref)) { sendJson(res, 422, msg('Reference already exists')); return; }
        if (!store.lookupObject(repo, sha)) { sendJson(res, 422, msg('Object does not exist')); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: ref, url: `/api/v3/repos/${repo.fullName}/git/refs/${encodePath(ref)}`, object: { type: 'commit', sha, url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
        return;
      }
      sendJson(res, 404, msg('Not Found'));
      return;
    }

    if (what === 'git' && restPath.length === 2 && restPath[0] === 'refs' && restPath[1] === 'heads') {
      // list heads
      if (method === 'GET') {
        const refs: Record<string, unknown>[] = [];
        for (const [ref, oid] of repo.refs) {
          if (ref.startsWith('refs/heads/')) {
            refs.push({ ref, node_id: ref, url: `/api/v3/repos/${repo.fullName}/git/refs/${encodePath(ref)}`, object: { type: 'commit', sha: oid, url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}` } });
          }
        }
        sendJson(res, 200, refs);
        return;
      }
      sendJson(res, 404, msg('Not Found'));
      return;
    }

    if (what === 'git' && restPath.length === 3 && restPath[0] === 'refs' && restPath[1] === 'heads') {
      const branch = decodeURIComponent(restPath[2]);
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) { sendJson(res, 404, msg('Not Found')); return; }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, node_id: `refs/heads/${branch}`, url: `/api/v3/repos/${repo.fullName}/git/refs/heads/${encodeURIComponent(branch)}`, object: { type: 'commit', sha: oid, url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}` } });
      return;
    }

    if (what === 'contents') {
      const filePath = restPath.map((s) => decodeURIComponent(s)).join('/');
      if (method === 'GET') {
        const params = new URLSearchParams(search);
        const ref = params.get('ref') ?? repo.defaultBranch;
        const tip = store.branchTip(repo, ref);
        if (!tip) { sendJson(res, 404, msg('Not Found')); return; }
        const tree = store.commitTree(repo, tip);
        const files = store.listTree(repo, tree);
        const hit = files.get(filePath);
        if (hit) {
          const obj = store.lookupObject(repo, hit.oid);
          if (!obj) { sendJson(res, 404, msg('Not Found')); return; }
          const content = obj.data.toString('base64');
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: obj.data.length,
            name: filePath.split('/').pop(),
            path: filePath,
            content,
            sha: hit.oid,
            url: `/api/v3/repos/${repo.fullName}/contents/${encodePath(filePath)}`,
            git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${hit.oid}`,
            html_url: `https://github.com/${repo.fullName}/blob/${ref}/${encodePath(filePath)}`,
            download_url: `https://raw.githubusercontent.com/${repo.fullName}/${ref}/${encodePath(filePath)}`,
            _links: { self: `/api/v3/repos/${repo.fullName}/contents/${encodePath(filePath)}`, git: `/api/v3/repos/${repo.fullName}/git/blobs/${hit.oid}`, html: `https://github.com/${repo.fullName}/blob/${ref}/${encodePath(filePath)}` },
          });
          return;
        }
        // directory listing
        const prefix = filePath ? `${filePath}/` : '';
        const entries: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        for (const [path, info] of files) {
          if (!path.startsWith(prefix)) continue;
          const rel = path.slice(prefix.length);
          const slash = rel.indexOf('/');
          if (slash >= 0) {
            const dir = rel.slice(0, slash);
            if (seen.has(dir)) continue;
            seen.add(dir);
            const dirPath = filePath ? `${filePath}/${dir}` : dir;
            entries.push({ type: 'dir', size: 0, name: dir, path: dirPath, sha: info.oid, url: `/api/v3/repos/${repo.fullName}/contents/${encodePath(dirPath)}`, git_url: `/api/v3/repos/${repo.fullName}/git/trees/${info.oid}`, html_url: `https://github.com/${repo.fullName}/tree/${ref}/${encodePath(dirPath)}`, download_url: null, _links: { self: `/api/v3/repos/${repo.fullName}/contents/${encodePath(dirPath)}`, git: `/api/v3/repos/${repo.fullName}/git/trees/${info.oid}`, html: `https://github.com/${repo.fullName}/tree/${ref}/${encodePath(dirPath)}` } });
          } else {
            entries.push({ type: 'file', encoding: 'base64', size: 0, name: rel, path, sha: info.oid, url: `/api/v3/repos/${repo.fullName}/contents/${encodePath(path)}`, git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${info.oid}`, html_url: `https://github.com/${repo.fullName}/blob/${ref}/${encodePath(path)}`, download_url: `https://raw.githubusercontent.com/${repo.fullName}/${ref}/${encodePath(path)}`, _links: { self: `/api/v3/repos/${repo.fullName}/contents/${encodePath(path)}`, git: `/api/v3/repos/${repo.fullName}/git/blobs/${info.oid}`, html: `https://github.com/${repo.fullName}/blob/${ref}/${encodePath(path)}` } });
          }
        }
        if (entries.length === 0 && !files.has(filePath)) { sendJson(res, 404, msg('Not Found')); return; }
        sendJson(res, 200, entries);
        return;
      }
      if (method === 'PUT') {
        const b = parseJsonBody(body);
        if (!b) { sendJson(res, 400, msg('Problems parsing JSON')); return; }
        const message = typeof b.message === 'string' && b.message ? b.message : 'commit';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendJson(res, 422, msg('Validation Failed')); return;
        }
        const branch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const sha = typeof b.sha === 'string' ? b.sha : undefined;
        const tip = store.branchTip(repo, branch);
        let currentSha: string | null = null;
        if (tip) {
          const tree = store.commitTree(repo, tip);
          const hit = store.getFileAtTree(repo, tree, filePath);
          if (hit) currentSha = hit.oid;
        }
        if (sha !== undefined && currentSha !== null && sha.toLowerCase() !== currentSha.toLowerCase()) {
          sendJson(res, 409, msg(`The blob SHA ${sha.toLowerCase()} does not match the current blob ${currentSha.toLowerCase()}`));
          return;
        }
        const changes = new Map<string, Buffer | null>();
        changes.set(filePath, content);
        const blobOid = hashObject('blob', content);
        const result = store.commitFiles(repo, branch, changes, message, `${ctx.login} <${ctx.login}@example.invalid>`);
        const wasCreate = currentSha === null;
        sendJson(res, wasCreate ? 201 : 200, {
          content: {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: filePath.split('/').pop(),
            path: filePath,
            content: contentB64,
            sha: blobOid,
            url: `/api/v3/repos/${repo.fullName}/contents/${encodePath(filePath)}`,
            git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`,
            html_url: `https://github.com/${repo.fullName}/blob/${branch}/${encodePath(filePath)}`,
            download_url: `https://raw.githubusercontent.com/${repo.fullName}/${branch}/${encodePath(filePath)}`,
            _links: { self: `/api/v3/repos/${repo.fullName}/contents/${encodePath(filePath)}`, git: `/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`, html: `https://github.com/${repo.fullName}/blob/${branch}/${encodePath(filePath)}` },
          },
          commit: { sha: result.commitSha, node_id: `C_${result.commitSha}`, url: `/api/v3/repos/${repo.fullName}/git/commits/${result.commitSha}`, html_url: `https://github.com/${repo.fullName}/commit/${result.commitSha}`, author: loginJson(ctx.login), committer: loginJson(ctx.login), message, tree: { sha: result.treeSha, url: `/api/v3/repos/${repo.fullName}/git/trees/${result.treeSha}` }, parents: tip ? [{ sha: tip }] : [], verification: { verified: false, reason: 'unsigned' } },
        });
        return;
      }
      if (method === 'DELETE') {
        const b = parseJsonBody(body);
        if (!b) { sendJson(res, 400, msg('Problems parsing JSON')); return; }
        const message = typeof b.message === 'string' && b.message ? b.message : 'delete';
        const sha = typeof b.sha === 'string' ? b.sha : undefined;
        const tip = store.branchTip(repo, repo.defaultBranch);
        if (!tip) { sendJson(res, 404, msg('Not Found')); return; }
        const tree = store.commitTree(repo, tip);
        const hit = store.getFileAtTree(repo, tree, filePath);
        if (!hit) { sendJson(res, 404, msg('Not Found')); return; }
        if (sha !== undefined && sha.toLowerCase() !== hit.oid.toLowerCase()) {
          sendJson(res, 409, msg('SHA does not match'));
          return;
        }
        const changes = new Map<string, Buffer | null>();
        changes.set(filePath, null);
        const result = store.commitFiles(repo, repo.defaultBranch, changes, message, `${ctx.login} <${ctx.login}@example.invalid>`);
        sendJson(res, 200, { content: null, commit: { sha: result.commitSha, node_id: `C_${result.commitSha}`, url: `/api/v3/repos/${repo.fullName}/git/commits/${result.commitSha}`, html_url: `https://github.com/${repo.fullName}/commit/${result.commitSha}`, author: loginJson(ctx.login), committer: loginJson(ctx.login), message, tree: { sha: result.treeSha, url: `/api/v3/repos/${repo.fullName}/git/trees/${result.treeSha}` }, parents: [{ sha: tip }], verification: { verified: false, reason: 'unsigned' } } });
        return;
      }
      sendJson(res, 404, msg('Not Found'));
      return;
    }

    if (what === 'labels') {
      if (restPath.length === 0 && method === 'POST') {
        const b = parseJsonBody(body);
        if (!b) { sendJson(res, 400, msg('Problems parsing JSON')); return; }
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name) { sendJson(res, 422, msg('Validation Failed')); return; }
        const color = typeof b.color === 'string' ? b.color : 'ededed';
        if (repo.labels.has(name)) { sendJson(res, 422, msg('Validation Failed')); return; }
        repo.labels.set(name, { name, color });
        sendJson(res, 201, labelJson(name, color));
        return;
      }
      if (restPath.length === 0 && method === 'GET') {
        const labels = [...repo.labels.values()].map((l) => labelJson(l.name, l.color));
        sendJson(res, 200, labels);
        return;
      }
      if (restPath.length === 1 && method === 'GET') {
        const name = decodeURIComponent(restPath[0]);
        const l = repo.labels.get(name);
        if (!l) { sendJson(res, 404, msg('Not Found')); return; }
        sendJson(res, 200, labelJson(l.name, l.color));
        return;
      }
      sendJson(res, 404, msg('Not Found'));
      return;
    }

    if (what === 'issues') {
      if (restPath.length === 0) {
        if (method === 'GET') {
          const params = new URLSearchParams(search);
          const state = params.get('state') ?? undefined;
          const sort = params.get('sort') ?? undefined;
          const direction = params.get('direction') ?? undefined;
          const perPage = Math.max(1, Math.min(100, parseInt(params.get('per_page') ?? '30', 10) || 30));
          const issues = store.listIssues(repo, state, sort, direction);
          sendJson(res, 200, issues.slice(0, perPage).map((i) => issueJson(repo, i)));
          return;
        }
        if (method === 'POST') {
          const b = parseJsonBody(body);
          if (!b) { sendJson(res, 400, msg('Problems parsing JSON')); return; }
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const labels: string[] = [];
          if (Array.isArray(b.labels)) {
            for (const l of b.labels) {
              const nm = typeof l === 'string' ? l : (typeof l === 'object' && l !== null && typeof (l as Record<string, unknown>).name === 'string' ? ((l as Record<string, unknown>).name as string) : '');
              if (!repo.labels.has(nm)) { sendJson(res, 422, msg(`Validation Failed: label ${JSON.stringify(nm)} does not exist`)); return; }
              labels.push(nm);
            }
          }
          if (!title) { sendJson(res, 422, msg('Validation Failed')); return; }
          const issue = store.createIssue(repo, title, bodyText, labels);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        sendJson(res, 404, msg('Not Found'));
        return;
      }
      if (restPath.length === 1) {
        const number = parseInt(restPath[0], 10);
        const issue = store.getIssue(repo, number);
        if (!issue) { sendJson(res, 404, msg('Not Found')); return; }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const b = parseJsonBody(body);
          if (!b) { sendJson(res, 400, msg('Problems parsing JSON')); return; }
          if (b.state === 'closed' || b.state === 'open') {
            store.setIssueState(repo, number, b.state);
          }
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        sendJson(res, 404, msg('Not Found'));
        return;
      }
      if (restPath.length === 2 && restPath[1] === 'comments') {
        const number = parseInt(restPath[0], 10);
        const issue = store.getIssue(repo, number);
        if (!issue) { sendJson(res, 404, msg('Not Found')); return; }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: `IC_${c.id}`, url: `/api/v3/repos/${repo.fullName}/issues/comments/${c.id}`, html_url: `https://github.com/${repo.fullName}/issues/${number}#issuecomment-${c.id}`, body: c.body, user: loginJson(repo.owner), created_at: c.created_at, updated_at: c.created_at, author_association: 'OWNER' })));
          return;
        }
        if (method === 'POST') {
          const b = parseJsonBody(body);
          if (!b) { sendJson(res, 400, msg('Problems parsing JSON')); return; }
          const commentBody = typeof b.body === 'string' ? b.body : '';
          if (!commentBody) { sendJson(res, 422, msg('Validation Failed')); return; }
          const c = store.addComment(repo, number, commentBody);
          if (!c) { sendJson(res, 404, msg('Not Found')); return; }
          sendJson(res, 201, { id: c.id, node_id: `IC_${c.id}`, url: `/api/v3/repos/${repo.fullName}/issues/comments/${c.id}`, html_url: `https://github.com/${repo.fullName}/issues/${number}#issuecomment-${c.id}`, body: c.body, user: loginJson(repo.owner), created_at: c.created_at, updated_at: c.created_at, author_association: 'OWNER' });
          return;
        }
        sendJson(res, 404, msg('Not Found'));
        return;
      }
      sendJson(res, 404, msg('Not Found'));
      return;
    }

    if (what === 'pulls') {
      if (restPath.length === 0) {
        if (method === 'GET') {
          const params = new URLSearchParams(search);
          const state = params.get('state') ?? 'open';
          const perPage = Math.max(1, Math.min(100, parseInt(params.get('per_page') ?? '30', 10) || 30));
          const pulls = store.listPulls(repo, state);
          sendJson(res, 200, pulls.slice(0, perPage).map((p) => pullJson(repo, p)));
          return;
        }
        if (method === 'POST') {
          const b = parseJsonBody(body);
          if (!b) { sendJson(res, 400, msg('Problems parsing JSON')); return; }
          const title = typeof b.title === 'string' ? b.title : '';
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' && b.base ? b.base : repo.defaultBranch;
          if (!head || !title) { sendJson(res, 422, msg('Validation Failed')); return; }
          const result = store.createPull(repo, title, bodyText, head, base);
          if (typeof result === 'string') { sendJson(res, 422, msg(result)); return; }
          sendJson(res, 201, pullJson(repo, result));
          return;
        }
        sendJson(res, 404, msg('Not Found'));
        return;
      }
      if (restPath.length === 1) {
        const number = parseInt(restPath[0], 10);
        const pr = store.getPull(repo, number);
        if (!pr) { sendJson(res, 404, msg('Not Found')); return; }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pr));
          return;
        }
        if (method === 'PATCH') {
          const b = parseJsonBody(body);
          if (!b) { sendJson(res, 400, msg('Problems parsing JSON')); return; }
          if (typeof b.title === 'string') pr.title = b.title;
          if (typeof b.body === 'string') pr.body = b.body;
          if (b.state === 'closed' && pr.state === 'open') { pr.state = 'closed'; pr.updated_at = new Date().toISOString(); }
          sendJson(res, 200, pullJson(repo, pr));
          return;
        }
        sendJson(res, 404, msg('Not Found'));
        return;
      }
      if (restPath.length === 2 && restPath[1] === 'files') {
        const number = parseInt(restPath[0], 10);
        const pr = store.getPull(repo, number);
        if (!pr) { sendJson(res, 404, msg('Not Found')); return; }
        if (method !== 'GET') { sendJson(res, 404, msg('Not Found')); return; }
        const headTip = store.branchTip(repo, pr.head) ?? pr.headSha;
        const baseTip = pr.baseSha;
        const headTree = store.commitTree(repo, headTip);
        const baseTree = store.commitTree(repo, baseTip);
        const diff = fileDiff(store, repo, baseTree, headTree);
        sendJson(res, 200, diff.map((f) => ({ sha: '', filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, blob_url: `https://github.com/${repo.fullName}/blob/HEAD/${encodePath(f.filename)}`, raw_url: `https://raw.githubusercontent.com/${repo.fullName}/HEAD/${encodePath(f.filename)}`, contents_url: `/api/v3/repos/${repo.fullName}/contents/${encodePath(f.filename)}?ref=HEAD`, patch: '' })));
        return;
      }
      if (restPath.length === 2 && restPath[1] === 'merge') {
        const number = parseInt(restPath[0], 10);
        if (method !== 'PUT') { sendJson(res, 404, msg('Not Found')); return; }
        const result = store.mergePull(repo, number);
        if (result.error === 'not_found') { sendJson(res, 404, msg('Not Found')); return; }
        if (result.error === 'conflict') { sendJson(res, 405, msg('Merge conflict')); return; }
        sendJson(res, 200, { sha: result.sha, merged: true, message: `Pull request #${number} merged` });
        return;
      }
      sendJson(res, 404, msg('Not Found'));
      return;
    }

    sendJson(res, 404, msg('Not Found'));
    return;
  }

  sendJson(res, 404, msg('Not Found'));
}

function parseJsonBody(body: Buffer | null): Record<string, unknown> | null {
  if (!body || body.length === 0) return null;
  try {
    const v = JSON.parse(body.toString('utf8'));
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}
