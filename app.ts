// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL, MCP.
// One process, standard library only. main.ts owns the env lifecycle; this file is the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Store, VIEWER, ZERO_OID, nextRequestId, isOid,
  putObject, getObject, headRefName, resolveRef, makeCommit, parseTree, parseCommit,
  flattenTree, buildTreeFromFlat, isAncestor, mergeBase, diffTrees,
  mergeConflicts, squashMerge, hashObject, pktLine, pktFlush, pktDelim, decodePktLines, pktLinesText,
  writePack, readPack, verifyPackChecksum, fetchPlan, buildTree, buildCommit, nowEpochSec, isoOf,
} from './core.ts';
import type { Repo, Issue, Pull } from './core.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const STORE = new Store();
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1].trim() : null;
}

/** Authenticated when a Bearer token is present; exact match when MAKEFUN_SHOP_TOKEN is set. */
function isAuthed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (!token) return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendNoBody(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...headers });
  res.end();
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    sendJson(res, 400, { message: 'Invalid JSON body' });
    return null;
  } catch {
    sendJson(res, 400, { message: 'Invalid JSON body' });
    return null;
  }
}

interface UrlParts {
  pathname: string;
  segments: string[];
  query: URLSearchParams;
}

function parseUrl(req: IncomingMessage): UrlParts {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    const pathname = decodeURIComponent(url.pathname);
    const segments = pathname.split('/').filter((s) => s.length > 0);
    return { pathname, segments, query: url.searchParams };
  } catch {
    return { pathname: '/', segments: [], query: new URLSearchParams() };
  }
}

// --------------------------------------------------------------------------- JSON shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = resolveRef(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = resolveRef(repo, pull.baseRef) ?? ZERO_OID;
  return {
    id: repo.id * 1000000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
  };
}

function paginate<T>(items: T[], query: URLSearchParams, req: IncomingMessage, path: string): { page: T[]; link: string | null } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${path}`;
  const linkParts: string[] = [];
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (pageNum < totalPages) {
    linkParts.push(`<${base}?per_page=${perPage}&page=${pageNum + 1}>; rel="next"`);
    linkParts.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  }
  if (pageNum > 1) linkParts.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
  return { page, link: linkParts.length ? linkParts.join(', ') : null };
}

function getRepoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) {
    notFound(res, 'Not Found');
    return null;
  }
  const repo = STORE.getRepo(owner, name);
  if (!repo) {
    notFound(res, 'Not Found');
    return null;
  }
  return repo;
}

// --------------------------------------------------------------------------- contents

function resolveTreeTip(repo: Repo, ref: string | undefined): { tree: string | null; tip: string | null } {
  if (ref === undefined) {
    const tip = resolveRef(repo, headRefName(repo));
    if (!tip) return { tree: null, tip: null };
    return { tree: parseCommit(getObject(repo, tip)?.data ?? Buffer.alloc(0)).tree, tip };
  }
  // A branch name first, then a commit oid.
  const branchTip = resolveRef(repo, `refs/heads/${ref}`);
  if (branchTip) return { tree: parseCommit(getObject(repo, branchTip)?.data ?? Buffer.alloc(0)).tree, tip: branchTip };
  const obj = getObject(repo, ref);
  if (obj?.type === 'commit') return { tree: parseCommit(obj.data).tree, tip: ref };
  return { tree: null, tip: null };
}

/** Write one file on a branch; creates the branch from the default tip when missing. */
function putContentFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedSha: string | undefined,
): { status: number; commitSha: string; blobSha: string; message?: string } {
  const ref = `refs/heads/${branch}`;
  let tip = resolveRef(repo, ref);
  if (!tip) {
    // New branch starts at the default branch tip (or unborn when the repo is empty).
    tip = resolveRef(repo, headRefName(repo)) ?? null;
    if (tip) repo.refs.set(ref, tip);
  }
  const baseTree = tip ? parseCommit(getObject(repo, tip)?.data ?? Buffer.alloc(0)).tree : null;
  const flat = baseTree ? flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  const existing = flat.get(path);
  if (existing) {
    if (expectedSha !== undefined && expectedSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { status: 409, commitSha: '', blobSha: '', message: 'sha does not match the current file' };
    }
    if (expectedSha === undefined) {
      return { status: 409, commitSha: '', blobSha: '', message: 'sha is required to update a file' };
    }
  } else if (expectedSha !== undefined) {
    return { status: 409, commitSha: '', blobSha: '', message: 'sha does not match the current file' };
  }
  const blobSha = putObject(repo, 'blob', content);
  flat.set(path, { oid: blobSha, mode: '100644' });
  const tree = buildTreeFromFlat(repo, flat);
  const commitSha = makeCommit(repo, tree, tip ? [tip] : [], message);
  repo.refs.set(ref, commitSha);
  return { status: existing ? 200 : 201, commitSha, blobSha };
}

function deleteContentFile(
  repo: Repo,
  branch: string,
  path: string,
  message: string,
  expectedSha: string | undefined,
): { status: number; commitSha: string; message?: string } {
  const ref = `refs/heads/${branch}`;
  const tip = resolveRef(repo, ref);
  if (!tip) return { status: 404, commitSha: '', message: 'Not Found' };
  const baseTree = parseCommit(getObject(repo, tip)?.data ?? Buffer.alloc(0)).tree;
  const flat = flattenTree(repo, baseTree);
  const existing = flat.get(path);
  if (!existing) return { status: 404, commitSha: '', message: 'Not Found' };
  if (expectedSha !== undefined && expectedSha.toLowerCase() !== existing.oid.toLowerCase()) {
    return { status: 409, commitSha: '', message: 'sha does not match the current file' };
  }
  flat.delete(path);
  const tree = buildTreeFromFlat(repo, flat);
  const commitSha = makeCommit(repo, tree, [tip], message);
  repo.refs.set(ref, commitSha);
  return { status: 200, commitSha };
}

// --------------------------------------------------------------------------- REST routes

async function handleRest(req: IncomingMessage, res: ServerResponse, parts: UrlParts): Promise<boolean> {
  const method = req.method ?? 'GET';
  const seg = parts.segments; // ['api','v3', ...]
  const path = parts.pathname;

  // Public roots.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (!isAuthed(req)) {
    unauthorized(res);
    return true;
  }

  // GET /api/v3/user
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return true;
  }

  // GET/POST /api/v3/user/repos
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const { page, link } = paginate(STORE.listRepos(VIEWER.login), parts.query, req, path);
      sendJson(res, 200, page.map(repoJson), link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      const description = typeof body.description === 'string' ? body.description : '';
      const priv = body.private === true;
      const repo = STORE.createRepo(VIEWER.login, name, description, priv);
      if (!repo) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return true;
      }
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg[0] === 'api' && seg[1] === 'v3' && seg[2] === 'repos' && seg.length >= 5) {
    const owner = decodeURIComponent(seg[3]);
    const name = decodeURIComponent(seg[4]);
    const rest = seg.slice(5);
    return handleRepoRoute(req, res, parts, owner, name, rest);
  }

  notFound(res);
  return true;
}

async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: UrlParts,
  owner: string,
  name: string,
  rest: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const repo = getRepoOr404(res, owner, name);
  if (!repo) return true;

  // Repo CRUD: /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      STORE.deleteRepo(owner, name);
      sendNoBody(res, 204);
      return true;
    }
    notFound(res);
    return true;
  }

  const head = rest[0];

  // Branches
  if (head === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .sort()
      .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) as string } }));
    sendJson(res, 200, branches);
    return true;
  }
  if (head === 'branches' && rest.length === 2 && method === 'GET') {
    const branch = decodeURIComponent(rest[1]);
    const tip = resolveRef(repo, `refs/heads/${branch}`);
    if (!tip) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { name: branch, commit: { sha: tip } });
    return true;
  }

  // Commits
  if (head === 'commits' && method === 'GET') {
    const shaParam = parts.query.get('sha') ?? undefined;
    const { tip } = resolveTreeTip(repo, shaParam);
    const out: Record<string, unknown>[] = [];
    if (tip) {
      const seen = new Set<string>();
      const queue = [tip];
      while (queue.length) {
        const oid = queue.shift() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = getObject(repo, oid);
        if (!obj || obj.type !== 'commit') continue;
        const view = parseCommit(obj.data);
        out.push({ sha: oid, commit: { message: view.message.replace(/\n$/, ''), author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } } });
        for (const parent of view.parents) queue.push(parent);
      }
    }
    const { page } = paginate(out, parts.query, req, parts.pathname);
    sendJson(res, 200, page);
    return true;
  }

  // Contents
  if (head === 'contents') {
    const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (method === 'GET') {
      const ref = parts.query.get('ref') ?? undefined;
      const { tree } = resolveTreeTip(repo, ref);
      if (!tree) {
        notFound(res);
        return true;
      }
      const flat = flattenTree(repo, tree);
      if (filePath === '') {
        // Root directory listing.
        sendJson(res, 200, dirListing(repo, tree, ''));
        return true;
      }
      const file = flat.get(filePath);
      if (file) {
        const blob = getObject(repo, file.oid);
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: blob ? blob.data.toString('base64') : '',
          sha: file.oid,
          size: blob ? blob.data.length : 0,
          name: filePath.split('/').pop(),
          path: filePath,
        });
        return true;
      }
      // Directory?
      const prefix = `${filePath}/`;
      const hasChildren = [...flat.keys()].some((p) => p.startsWith(prefix));
      if (hasChildren) {
        sendJson(res, 200, dirListing(repo, tree, filePath));
        return true;
      }
      notFound(res);
      return true;
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const message = typeof body.message === 'string' ? body.message : 'Update file';
      const contentB64 = typeof body.content === 'string' ? body.content : '';
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        sendJson(res, 400, { message: 'content is not valid base64' });
        return true;
      }
      const result = putContentFile(repo, branch, filePath, content, message, sha);
      if (result.status === 409 || result.status === 404) {
        sendJson(res, result.status, { message: result.message ?? 'Conflict' });
        return true;
      }
      sendJson(res, result.status, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: result.blobSha, size: content.length, encoding: 'base64', type: 'file' },
        commit: { sha: result.commitSha },
      });
      return true;
    }
    if (method === 'DELETE') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const message = typeof body.message === 'string' ? body.message : 'Delete file';
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const sha = typeof body.sha === 'string' ? body.sha : undefined;
      const result = deleteContentFile(repo, branch, filePath, message, sha);
      if (result.status !== 200) {
        sendJson(res, result.status, { message: result.message ?? 'Not Found' });
        return true;
      }
      sendJson(res, 200, { commit: { sha: result.commitSha } });
      return true;
    }
    notFound(res);
    return true;
  }

  // Labels
  if (head === 'labels') {
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (!labelName) {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      repo.labels.set(labelName, color);
      sendJson(res, 201, { name: labelName, color });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.entries()].map(([labelName, color]) => ({ name: labelName, color })));
      return true;
    }
    notFound(res);
    return true;
  }

  // Git refs
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha)) {
        sendJson(res, 422, { message: 'ref and sha are required' });
        return true;
      }
      const obj = getObject(repo, sha);
      if (!obj || obj.type !== 'commit') {
        sendJson(res, 422, { message: 'sha is not a known commit' });
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
      return true;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
      const tip = resolveRef(repo, ref);
      if (!tip) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ref, object: { sha: tip, type: 'commit' } });
      return true;
    }
    notFound(res);
    return true;
  }

  // Issues
  if (head === 'issues') {
    return handleIssues(req, res, parts, repo, rest.slice(1));
  }

  // Pulls
  if (head === 'pulls') {
    return handlePulls(req, res, parts, repo, rest.slice(1));
  }

  notFound(res);
  return true;
}

function dirListing(repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const seen = new Map<string, { type: string; sha: string }>();
  const flat = flattenTree(repo, treeOid);
  for (const path of flat.keys()) {
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    const first = remainder.split('/')[0];
    if (remainder.includes('/')) {
      if (!seen.has(first)) {
        // Find the subtree oid by walking the tree.
        seen.set(first, { type: 'dir', sha: subtreeOid(repo, treeOid, dirPath === '' ? first : `${dirPath}/${first}`) });
      }
    } else {
      seen.set(first, { type: 'file', sha: flat.get(path)?.oid ?? '' });
    }
  }
  return [...seen.entries()].map(([name, entry]) => ({
    type: entry.type,
    name,
    path: dirPath === '' ? name : `${dirPath}/${name}`,
    sha: entry.sha,
  }));
}

function subtreeOid(repo: Repo, treeOid: string, dirPath: string): string {
  const parts = dirPath.split('/');
  let current = treeOid;
  for (const part of parts) {
    const obj = getObject(repo, current);
    if (!obj || obj.type !== 'tree') return ZERO_OID;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return ZERO_OID;
    current = entry.oid;
  }
  return current;
}

// --------------------------------------------------------------------------- issues & pulls

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  parts: UrlParts,
  repo: Repo,
  rest: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // POST /issues and GET /issues
  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const title = typeof body.title === 'string' ? body.title : '';
      const issueBody = typeof body.body === 'string' ? body.body : '';
      const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
      const labels: string[] = [];
      for (const raw of labelsRaw) {
        const labelName = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null && typeof (raw as { name?: unknown }).name === 'string' ? (raw as { name: string }).name : '';
        if (labelName && !repo.labels.has(labelName)) {
          sendJson(res, 422, { message: `Label '${labelName}' does not exist` });
          return true;
        }
        if (labelName) labels.push(labelName);
      }
      const issue: Issue = {
        number: repo.nextIssue,
        title,
        body: issueBody,
        state: 'open',
        labels,
        comments: [],
        createdSeq: repo.nextIssue,
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = parts.query.get('state') ?? 'open';
      const sort = parts.query.get('sort') ?? 'created';
      const direction = parts.query.get('direction') ?? 'desc';
      let items = [...repo.issues];
      if (state !== 'all') items = items.filter((i) => i.state === state);
      if (sort === 'created') items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page } = paginate(items, parts.query, req, parts.pathname);
      sendJson(res, 200, page.map((i) => issueJson(repo, i)));
      return true;
    }
    notFound(res);
    return true;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) {
    notFound(res);
    return true;
  }
  const issue = repo.issues.find((i) => i.number === number);

  // /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) {
      notFound(res);
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const commentBody = typeof body.body === 'string' ? body.body : '';
      const id = repo.nextCommentId;
      repo.nextCommentId += 1;
      issue.comments.push({ id, body: commentBody });
      sendJson(res, 201, { id, body: commentBody });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
      return true;
    }
    notFound(res);
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      if (!issue) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      if (!issue) {
        notFound(res);
        return true;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
  }

  notFound(res);
  return true;
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').filter((l) => l.length > 0).length;
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  parts: UrlParts,
  repo: Repo,
  rest: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const title = typeof body.title === 'string' ? body.title : '';
      const pullBody = typeof body.body === 'string' ? body.body : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      const headTip = resolveRef(repo, `refs/heads/${head}`);
      const baseTip = resolveRef(repo, `refs/heads/${base}`);
      if (!headTip || !baseTip) {
        sendJson(res, 422, { message: 'head or base branch is unknown' });
        return true;
      }
      const pull: Pull = {
        number: repo.nextPull,
        title,
        body: pullBody,
        headRef: head,
        baseRef: base,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeSha: null,
        createdSeq: repo.nextPull,
      };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = parts.query.get('state') ?? 'open';
      let items = [...repo.pulls];
      if (state === 'open') items = items.filter((p) => p.state === 'open');
      else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      const { page } = paginate(items, parts.query, req, parts.pathname);
      sendJson(res, 200, page.map((p) => pullJson(repo, p)));
      return true;
    }
    notFound(res);
    return true;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) {
    notFound(res);
    return true;
  }
  const pull = repo.pulls.find((p) => p.number === number);

  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET' || !pull) {
      notFound(res);
      return true;
    }
    const baseTip = resolveRef(repo, pull.baseRef);
    const headTip = resolveRef(repo, pull.headRef);
    if (!baseTip || !headTip) {
      notFound(res);
      return true;
    }
    const mb = mergeBase(repo, baseTip, headTip);
    const baseTree = mb ? parseCommit(getObject(repo, mb)?.data ?? Buffer.alloc(0)).tree : null;
    const headTree = parseCommit(getObject(repo, headTip)?.data ?? Buffer.alloc(0)).tree;
    const diff = diffTrees(repo, baseTree, headTree);
    const files = diff.map((entry) => {
      let additions = 0;
      let deletions = 0;
      if (entry.status === 'added' && entry.newOid) {
        additions = countLines(getObject(repo, entry.newOid)?.data.toString('utf8') ?? '');
      } else if (entry.status === 'removed' && entry.oldOid) {
        deletions = countLines(getObject(repo, entry.oldOid)?.data.toString('utf8') ?? '');
      } else if (entry.status === 'modified' && entry.oldOid && entry.newOid) {
        const oldLines = new Set((getObject(repo, entry.oldOid)?.data.toString('utf8') ?? '').split('\n'));
        const newLines = (getObject(repo, entry.newOid)?.data.toString('utf8') ?? '').split('\n');
        additions = newLines.filter((l) => l.length > 0 && !oldLines.has(l)).length;
        deletions = Math.max(0, countLines(getObject(repo, entry.oldOid)?.data.toString('utf8') ?? '') - countLines(getObject(repo, entry.newOid)?.data.toString('utf8') ?? ''));
        if (additions === 0) additions = 1;
      }
      const status = entry.status === 'added' ? 'added' : entry.status === 'removed' ? 'removed' : 'modified';
      return { filename: entry.path, status, additions, deletions, changes: additions + deletions };
    });
    sendJson(res, 200, files);
    return true;
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') {
      notFound(res);
      return true;
    }
    if (!pull) {
      notFound(res, 'Not Found');
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    if (pull.merged || pull.state !== 'open') {
      sendJson(res, 405, { message: 'Pull request is already merged or closed' });
      return true;
    }
    const baseTip = resolveRef(repo, pull.baseRef);
    const headTip = resolveRef(repo, pull.headRef);
    if (!baseTip || !headTip) {
      sendJson(res, 405, { message: 'Pull request cannot be merged' });
      return true;
    }
    if (mergeConflicts(repo, baseTip, headTip)) {
      sendJson(res, 405, { message: 'Merge conflict' });
      return true;
    }
    const sha = squashMerge(repo, pull);
    if (!sha) {
      sendJson(res, 405, { message: 'Merge conflict' });
      return true;
    }
    sendJson(res, 200, { sha, merged: true, message: `Pull request #${pull.number} merged` });
    return true;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      if (!pull) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
  }

  notFound(res);
  return true;
}

// --------------------------------------------------------------------------- git smart HTTP

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack no-progress ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/main';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta';

function refLinesV0(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const headTip = resolveRef(repo, headRefName(repo));
  const firstOid = headTip ?? ZERO_OID;
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  // HEAD first, carrying the capabilities after a NUL.
  lines.push(pktLine(`${firstOid} HEAD\0${caps}\n`));
  const peeled = new Map<string, string>();
  for (const [ref, oid] of refs) {
    const obj = getObject(repo, oid);
    if (obj?.type === 'tag') {
      const target = obj.data.toString('utf8').split('\n').find((l) => l.startsWith('object '))?.slice(7).trim();
      if (target) peeled.set(ref, target);
    }
    lines.push(pktLine(`${oid} ${ref}\n`));
  }
  for (const [ref, target] of peeled) lines.push(pktLine(`${target} ${ref}^{}\n`));
  return lines;
}

function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxChunk = 65515;
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxChunk));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

function tagTarget(repo: Repo, tagOid: string): string | null {
  const obj = getObject(repo, tagOid);
  if (!obj || obj.type !== 'tag') return null;
  const target = obj.data.toString('utf8').split('\n').find((l) => l.startsWith('object '))?.slice(7).trim();
  return target ?? null;
}

async function handleGit(req: IncomingMessage, res: ServerResponse, parts: UrlParts): Promise<boolean> {
  const method = req.method ?? 'GET';
  const seg = parts.segments;
  // /{owner}/{repo}.git/...
  if (seg.length < 2 || !seg[1].endsWith('.git')) return false;
  const owner = decodeURIComponent(seg[0]);
  const name = decodeURIComponent(seg[1].slice(0, -4));
  const rest = seg.slice(2);
  const service = parts.query.get('service') ?? '';
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

  if (!isAuthed(req)) {
    unauthorized(res);
    return true;
  }
  if (owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const repo = STORE.getRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // GET info/refs
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    if (service === 'git-upload-pack') {
      if (isV2) {
        const body = Buffer.concat([
          pktLine('# service=git-upload-pack\n'),
          pktLine('version 2\n'),
          pktLine('fetch=shallow\n'),
          pktLine('ls-refs=unborn\n'),
          pktLine('object-format=sha1\n'),
          pktLine('agent=github-core-clone-forge/1.0.0\n'),
          pktFlush(),
        ]);
        sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', body);
        return true;
      }
      const body = Buffer.concat([pktLine('# service=git-upload-pack\n'), ...refLinesV0(repo, UPLOAD_CAPS_V0), pktFlush()]);
      sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', body);
      return true;
    }
    if (service === 'git-receive-pack') {
      const body = Buffer.concat([pktLine('# service=git-receive-pack\n'), ...refLinesV0(repo, RECEIVE_CAPS_V0), pktFlush()]);
      sendBytes(res, 200, 'application/x-git-receive-pack-advertisement', body);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // POST git-upload-pack
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    const raw = await readBody(req);
    try {
      if (isV2) await handleUploadPackV2(repo, raw, res);
      else await handleUploadPackV0(repo, raw, res);
    } catch {
      sendBytes(res, 400, 'application/x-git-upload-pack-result', Buffer.alloc(0));
    }
    return true;
  }

  // POST git-receive-pack
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    const raw = await readBody(req);
    try {
      await handleReceivePack(repo, raw, res);
    } catch {
      sendBytes(res, 400, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    }
    return true;
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

function lsRefsReply(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean): Buffer[] {
  const lines: Buffer[] = [];
  const headTip = resolveRef(repo, headRefName(repo));
  const allRefs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  // With a prefix filter the server answers only matching refs — no HEAD line.
  if (prefixes.length === 0) {
    if (headTip) lines.push(pktLine(`${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    else lines.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
  }
  for (const [ref, oid] of allRefs) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    const obj = getObject(repo, oid);
    if (peel && obj?.type === 'tag') {
      const target = tagTarget(repo, oid);
      if (target) line += ` peeled:${target}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  return lines;
}

async function handleUploadPackV2(repo: Repo, raw: Buffer, res: ServerResponse): Promise<void> {
  const { packets } = decodePktLines(raw);
  // Data payloads only (delim/flush are control packets); strip the trailing newline.
  const lines = pktLinesText(packets).map((l) => l.replace(/\n$/, ''));
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length).trim() : '';
  // Lines after the command, minus the agent=/object-format= argument lines.
  const args = lines.slice(1).filter((l) => l.length > 0 && !l.startsWith('agent=') && !l.startsWith('object-format='));

  if (command === 'ls-refs') {
    const peel = args.includes('peel');
    const symrefs = args.includes('symrefs');
    const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
    const body = Buffer.concat([...lsRefsReply(repo, prefixes, peel, symrefs), pktFlush()]);
    sendBytes(res, 200, 'application/x-git-upload-pack-result', body);
    return;
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
    }
    const plan = fetchPlan(repo, wants, haves, shallow, depth);
    const pack = writePack([...plan.objects.values()].sort((a, b) => {
      const ao = hashObject(a.type, a.data);
      const bo = hashObject(b.type, b.data);
      return ao < bo ? -1 : 1;
    }));
    const out: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim()];
    if (plan.shallow.length || plan.unshallow.length) {
      out.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
      out.push(pktDelim());
    }
    out.push(pktLine('packfile\n'));
    out.push(...sidebandPackets(1, pack));
    out.push(pktFlush());
    sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    return;
  }

  throw new Error(`unknown v2 command ${command}`);
}

async function handleUploadPackV0(repo: Repo, raw: Buffer, res: ServerResponse): Promise<void> {
  const { packets } = decodePktLines(raw);
  const lines = pktLinesText(packets);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7).trim());
  }
  const plan = fetchPlan(repo, wants, haves, shallow, depth);
  const pack = writePack([...plan.objects.values()]);
  const out: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
  out.push(...sidebandPackets(1, pack));
  out.push(pktFlush());
  sendBytes(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

async function handleReceivePack(repo: Repo, raw: Buffer, res: ServerResponse): Promise<void> {
  const { packets, rest } = decodePktLines(raw);
  const lines = pktLinesText(packets);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const clean = nul >= 0 ? text.slice(0, nul) : text;
    const parts = clean.split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1]) && parts[2].startsWith('refs/')) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }

  let unpackOk = true;
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates && rest.length > 0) {
    if (!verifyPackChecksum(rest)) {
      unpackOk = false;
    } else {
      try {
        const objects = readPack(rest);
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch {
        unpackOk = false;
      }
    }
  } else if (hasUpdates && rest.length === 0) {
    unpackOk = false;
  }

  const report: string[] = [unpackOk ? 'unpack ok' : 'unpack index-pack failed'];
  if (unpackOk) {
    for (const cmd of commands) {
      if (cmd.newOid === ZERO_OID) {
        const current = repo.refs.get(cmd.ref);
        if (current === undefined) {
          report.push(`ng ${cmd.ref} remote ref does not exist`);
        } else if (current !== cmd.oldOid) {
          report.push(`ng ${cmd.ref} non-fast-forward`);
        } else {
          repo.refs.delete(cmd.ref);
          report.push(`ok ${cmd.ref}`);
        }
        continue;
      }
      const newObj = getObject(repo, cmd.newOid);
      if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
        report.push(`ng ${cmd.ref} unable to update`);
        continue;
      }
      const current = repo.refs.get(cmd.ref);
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) {
          report.push(`ng ${cmd.ref} already exists`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          report.push(`ok ${cmd.ref}`);
        }
        continue;
      }
      if (current !== cmd.oldOid) {
        report.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      if (newObj.type === 'commit' && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        report.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push(`ok ${cmd.ref}`);
    }
  } else {
    for (const cmd of commands) report.push(`ng ${cmd.ref} unpack failed`);
  }

  const reportText = `${report.join('\n')}\n`;
  const framed = Buffer.concat(reportText.split('\n').filter((l) => l.length > 0).map((l) => pktLine(`${l}\n`)));
  const body = Buffer.concat([...sidebandPackets(1, framed), pktFlush()]);
  sendBytes(res, 200, 'application/x-git-receive-pack-result', body);
}

// --------------------------------------------------------------------------- dispatch

/** Build the server. It binds nothing until the caller listens; main.ts listens on port 0. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const parts = parseUrl(req);
        const method = req.method ?? 'GET';
        const path = parts.pathname;

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // GraphQL
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown = null;
          let parseFailed = false;
          try {
            parsed = raw.length ? JSON.parse(raw.toString('utf8')) : null;
          } catch {
            parseFailed = true;
          }
          if (parseFailed) {
            sendJson(res, 400, { data: null, errors: [{ message: 'request body is not valid JSON' }] });
            return;
          }
          const result = executeGraphQL(STORE, parsed);
          sendJson(res, result.status, result.body);
          return;
        }

        // MCP
        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendNoBody(res, 200);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!isAuthed(req)) {
            res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
            res.end(JSON.stringify({ message: 'Requires authentication' }));
            return;
          }
          const raw = await readBody(req);
          const rawText = raw.toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = raw.length ? JSON.parse(rawText) : null;
          } catch {
            parsed = null;
          }
          const outcome = handleMcp(STORE, parsed, rawText);
          if (outcome.body === null) {
            sendNoBody(res, outcome.status);
            return;
          }
          sendJson(res, outcome.status, outcome.body);
          return;
        }

        // Git smart HTTP
        if (parts.segments.length >= 2 && parts.segments[1].endsWith('.git')) {
          const handled = await handleGit(req, res, parts);
          if (handled) return;
        }

        // REST v3
        if (parts.segments[0] === 'api' && parts.segments[1] === 'v3') {
          await handleRest(req, res, parts);
          return;
        }

        notFound(res);
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // Response already gone; nothing to do.
        }
      }
    })();
  });
}

export { STORE, nowEpochSec, isoOf, buildTree, buildCommit };
