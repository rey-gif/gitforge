// mcp.ts — Model Context Protocol endpoint: JSON-RPC 2.0 over Streamable HTTP.
// Serves both eras: modern 2026-07-28 via server/discover, legacy via initialize +
// notifications/initialized. Tools act on the same store as REST/GraphQL/git.

import { VIEWER, gid, squashMerge } from './core.ts';
import type { Store, Repo } from './core.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolOutcome {
  content: { type: 'text'; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

function toolText(payload: unknown): ToolOutcome {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolError(message: string): ToolOutcome {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: { number: number; title: string; body: string; state: string }): Record<string, unknown> {
  return {
    id: gid('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
  };
}

function pullJson(repo: Repo, pull: { number: number; title: string; body: string; headRef: string; baseRef: string; state: string; merged: boolean }): Record<string, unknown> {
  return {
    id: gid('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef },
    base: { ref: pull.baseRef },
  };
}

function runTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const str = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === 'string' ? value : undefined;
  };
  const num = (key: string): number | undefined => {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return undefined;
  };
  const findRepo = (): Repo | undefined => {
    const owner = str('owner') ?? VIEWER.login;
    const repo = str('repo');
    if (!repo) return undefined;
    return store.getRepo(owner, repo);
  };

  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      if (!repoName) return toolError('create_repo: "name" is required');
      const description = str('description') ?? '';
      const priv = args.private === true;
      const repo = store.createRepo(VIEWER.login, repoName, description, priv);
      if (!repo) return toolError(`create_repo: repository ${repoName} already exists`);
      return toolText(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo();
      if (!repo) return toolError('get_repo: repository not found');
      return toolText(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo();
      const title = str('title');
      if (!repo) return toolError('create_issue: repository not found');
      if (!title) return toolError('create_issue: "title" is required');
      const issue = {
        number: repo.nextIssue,
        title,
        body: str('body') ?? '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as { id: number; body: string }[],
        createdSeq: repo.nextIssue,
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      return toolText(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo();
      if (!repo) return toolError('list_issues: repository not found');
      const state = str('state') ?? 'open';
      const items = repo.issues.filter((i) => state === 'all' || i.state === state);
      return toolText(items.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const repo = findRepo();
      const title = str('title');
      const head = str('head');
      const base = str('base');
      if (!repo) return toolError('create_pull_request: repository not found');
      if (!title || !head || !base) return toolError('create_pull_request: "title", "head" and "base" are required');
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (!headTip || !baseTip) return toolError('create_pull_request: unknown branch');
      const pull = {
        number: repo.nextPull,
        title,
        body: str('body') ?? '',
        headRef: head,
        baseRef: base,
        state: 'open' as const,
        merged: false,
        mergedAt: null as string | null,
        mergeSha: null as string | null,
        createdSeq: repo.nextPull,
      };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      return toolText(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      // Handled in handleMcp (needs the squash path); unreachable here.
      return toolError('merge_pull_request: internal error');
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export interface McpRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpResponse {
  status: number;
  body: unknown;
}

/** Handle one POST /mcp body (already parsed JSON, or null when unparsable). */
export function handleMcp(store: Store, body: unknown, rawText: string): McpResponse {
  const errorReply = (id: unknown, code: number, message: string): McpResponse => ({
    status: 200,
    body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
  });

  if (body === null) {
    // Malformed JSON: HTTP 400 with JSON-RPC -32700. Recover the id if visible.
    let id: unknown = null;
    const match = /"id"\s*:\s*("[^"]*"|\d+)/.exec(rawText);
    if (match) {
      try {
        id = JSON.parse(match[1]);
      } catch {
        id = null;
      }
    }
    return { status: 400, body: { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = body as McpRequest;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params && typeof req.params === 'object' && !Array.isArray(req.params) ? req.params : {}) as Record<string, unknown>;

  // A notification (no id) gets no JSON-RPC response.
  const isNotification = req.id === undefined;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    const result = {
      protocolVersion: '2026-07-28',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    };
    return { status: 200, body: { jsonrpc: '2.0', id, result } };
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
      ? params.protocolVersion
      : '2025-11-25';
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: offered, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      },
    };
  }

  if (method === 'tools/list') {
    // Byte-identical across calls: built from the constant TOOLS array.
    return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return errorReply(id, -32602, `unknown tool ${name}`);
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length) return errorReply(id, -32602, `missing required argument(s): ${missing.join(', ')}`);
    if (name === 'merge_pull_request') {
      // Merge needs the real squash path (imported lazily to keep this module small is
      // unnecessary — do it inline via the store instead).
      const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const repo = store.getRepo(owner, repoName);
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.pull_number === 'string' && /^\d+$/.test(args.pull_number) ? Number(args.pull_number) : undefined;
      if (!repo) return { status: 200, body: { jsonrpc: '2.0', id, result: toolError('merge_pull_request: repository not found') } };
      if (number === undefined) return errorReply(id, -32602, 'missing required argument(s): pull_number');
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return { status: 200, body: { jsonrpc: '2.0', id, result: toolError('merge_pull_request: pull request not found') } };
      if (pull.merged || pull.state !== 'open') {
        return { status: 200, body: { jsonrpc: '2.0', id, result: toolError('merge_pull_request: pull request is already closed') } };
      }
      // Merge via core's squash path.
      const merged = squashMerge(repo, pull) !== null;
      if (!merged) {
        return { status: 200, body: { jsonrpc: '2.0', id, result: toolError('merge_pull_request: merge conflict') } };
      }
      const payload = { merged: true, number: pull.number, state: pull.state };
      return { status: 200, body: { jsonrpc: '2.0', id, result: toolText(payload) } };
    }
    const outcome = runTool(store, name, args);
    return { status: 200, body: { jsonrpc: '2.0', id, result: outcome } };
  }

  void isNotification;
  return errorReply(id, -32601, `method not found: ${method}`);
}
