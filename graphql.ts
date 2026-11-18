// graphql.ts — a small GraphQL parser + executor for the documents gh /
// github-mcp-server send (see the kit's checks-graphql.ts). No dependencies.

import {
  Store, VIEWER, gid, parseGid, mergeConflicts, squashMerge,
  resolveRef, parseCommit, getObject, flattenTree, diffTrees, mergeBase, isoOf, nowEpochSec,
} from './core.ts';
import type { Repo, Issue, Pull } from './core.ts';

// --------------------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@&|'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      if (src[j] === '.' || src[j] === 'e' || src[j] === 'E') {
        while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      }
      tokens.push({ kind: 'int', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// --------------------------------------------------------------------------- parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[];
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

export interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: { name: string; defaultValue?: ValueNode }[];
  selection: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private acceptPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return tok.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ operation: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type name
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
        throw new Error(`unexpected keyword ${keyword} in GraphQL document`);
      }
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value as string;
      const variables: OperationNode['variables'] = [];
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          this.expectPunct('$');
          const varName = this.expectName();
          this.expectPunct(':');
          this.parseType();
          let defaultValue: ValueNode | undefined;
          if (this.acceptPunct('=')) defaultValue = this.parseValue();
          variables.push({ name: varName, defaultValue });
          if (this.peek().kind === 'eof') throw new Error('unterminated variable definitions');
        }
      }
      // Directives: skip @name(args).
      while (this.peek().kind === 'punct' && this.peek().value === '@') {
        this.next();
        this.expectName();
        if (this.acceptPunct('(')) {
          let depth = 1;
          while (depth > 0) {
            const t = this.next();
            if (t.kind === 'punct' && t.value === '(') depth += 1;
            else if (t.kind === 'punct' && t.value === ')') depth -= 1;
          }
        }
      }
      operations.push({ operation: keyword, name, variables, selection: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      if (this.peek().kind === 'punct' && this.peek().value === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          out.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          out.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      out.push({ kind: 'field', field: this.parseField() });
    }
    return out;
  }

  private parseField(): FieldNode {
    let alias: string | null = null;
    let name = this.expectName();
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // Directives on a field: skip.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let selection: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

export function parseGraphQL(src: string): DocumentNode {
  return new Parser(lex(src)).parseDocument();
}

// --------------------------------------------------------------------------- values

export function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': return node.value;
    case 'string': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

// --------------------------------------------------------------------------- introspection

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  User: ['login'],
  Ref: ['name'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// --------------------------------------------------------------------------- executor

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

type Resolver = (parent: unknown, field: FieldNode, ctx: ExecContext) => unknown;

function repoGlobalId(repo: Repo): string {
  return gid('Repository', repo.id);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return gid('Issue', repo.id, issue.number);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return gid('PullRequest', repo.id, pull.number);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return gid('IssueComment', repo.id, issue.number, commentId);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function mergeableOf(_store: Store, repo: Repo, pull: Pull): string {
  const baseTip = resolveRef(repo, pull.baseRef);
  const headTip = resolveRef(repo, pull.headRef);
  if (!baseTip || !headTip) return 'UNKNOWN';
  return mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

function prFiles(store: Store, repo: Repo, pull: Pull, first: number | undefined): { path: string }[] {
  const baseTip = resolveRef(repo, pull.baseRef);
  const headTip = resolveRef(repo, pull.headRef);
  if (!baseTip || !headTip) return [];
  const mb = mergeBase(repo, baseTip, headTip);
  const baseTree = mb ? parseCommit(getObject(repo, mb)?.data ?? Buffer.alloc(0)).tree : null;
  const headTree = parseCommit(getObject(repo, headTip)?.data ?? Buffer.alloc(0)).tree;
  const diff = diffTrees(repo, baseTree, headTree);
  const paths = diff.filter((d) => d.status !== 'removed').map((d) => ({ path: d.path }));
  return first === undefined ? paths : paths.slice(0, first);
}

function issueConnection(repo: Repo, args: { first?: number; states?: string[]; orderBy?: { field: string; direction: string }; after?: string | null }): { nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  let items = [...repo.issues];
  if (args.states && args.states.length) {
    const wanted = new Set(args.states.map((s) => s.toLowerCase()));
    items = items.filter((i) => wanted.has(i.state));
  }
  const direction = args.orderBy?.direction ?? 'ASC';
  const field = args.orderBy?.field ?? 'CREATED_AT';
  void field;
  items.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  if (args.after !== undefined && args.after !== null) {
    const n = cursorNumber(String(args.after));
    if (n !== null) {
      const idx = items.findIndex((i) => i.number === n);
      if (idx >= 0) items = items.slice(idx + 1);
    }
  }
  const first = args.first ?? items.length;
  const page = items.slice(0, first);
  const hasNextPage = items.length > first;
  const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
  return { nodes: page, pageInfo: { hasNextPage, endCursor } };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: VIEWER.login }),
    repository: (_parent, field, ctx) => {
      const owner = argValue(field, 'owner', ctx.variables) as string | undefined;
      const name = argValue(field, 'name', ctx.variables) as string | undefined;
      if (owner !== VIEWER.login || !name) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? { __typename: 'Repository', repo } : null;
    },
    node: (_parent, field, ctx) => {
      const id = argValue(field, 'id', ctx.variables) as string | undefined;
      if (!id) return null;
      const parsed = parseGid(id);
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = [...ctx.store.repos.values()].find((r) => String(r.id) === parsed.parts[0]);
        return repo ? { __typename: 'Repository', repo } : null;
      }
      if (parsed.kind === 'Issue') {
        const repo = [...ctx.store.repos.values()].find((r) => String(r.id) === parsed.parts[0]);
        const issue = repo?.issues.find((i) => String(i.number) === parsed.parts[1]);
        return repo && issue ? { __typename: 'Issue', repo, issue } : null;
      }
      if (parsed.kind === 'PullRequest') {
        const repo = [...ctx.store.repos.values()].find((r) => String(r.id) === parsed.parts[0]);
        const pull = repo?.pulls.find((p) => String(p.number) === parsed.parts[1]);
        return repo && pull ? { __typename: 'PullRequest', repo, pull } : null;
      }
      return null;
    },
    __type: (_parent, field, ctx) => {
      const name = argValue(field, 'name', ctx.variables) as string | undefined;
      if (!name) return null;
      if (SCHEMA_FIELDS[name]) return { __typename: '__Type', name, kind: 'OBJECT', fields: SCHEMA_FIELDS[name], enumValues: null };
      if (SCHEMA_ENUMS[name]) return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: SCHEMA_ENUMS[name] };
      return null;
    },
    __schema: () => ({ __typename: '__Schema', queryType: { name: 'Query' } }),
  },
  Repository: {
    id: (parent) => repoGlobalId((parent as { repo: Repo }).repo),
    databaseId: (parent) => (parent as { repo: Repo }).repo.id,
    name: (parent) => (parent as { repo: Repo }).repo.name,
    nameWithOwner: (parent) => {
      const repo = (parent as { repo: Repo }).repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (parent) => ({ __typename: 'User', login: (parent as { repo: Repo }).repo.owner }),
    defaultBranchRef: (parent) => ({ __typename: 'Ref', name: (parent as { repo: Repo }).repo.defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, field, ctx) => {
      const repo = (parent as { repo: Repo }).repo;
      const number = argValue(field, 'number', ctx.variables) as number | undefined;
      const issue = repo.issues.find((i) => i.number === number);
      return issue ? { __typename: 'Issue', repo, issue } : null;
    },
    issues: (parent, field, ctx) => {
      const repo = (parent as { repo: Repo }).repo;
      const first = argValue(field, 'first', ctx.variables) as number | undefined;
      const states = argValue(field, 'states', ctx.variables) as string[] | undefined;
      const orderBy = argValue(field, 'orderBy', ctx.variables) as { field: string; direction: string } | undefined;
      const after = argValue(field, 'after', ctx.variables) as string | null | undefined;
      const conn = issueConnection(repo, { first, states, orderBy, after });
      return {
        __typename: 'IssueConnection',
        nodes: conn.nodes.map((issue) => ({ __typename: 'Issue', repo, issue })),
        pageInfo: { __typename: 'PageInfo', ...conn.pageInfo },
      };
    },
    pullRequests: (parent, field, ctx) => {
      const repo = (parent as { repo: Repo }).repo;
      const first = argValue(field, 'first', ctx.variables) as number | undefined;
      const pulls = first === undefined ? repo.pulls : repo.pulls.slice(0, first);
      return { __typename: 'PullRequestConnection', nodes: pulls.map((pull) => ({ __typename: 'PullRequest', repo, pull })) };
    },
    pullRequest: (parent, field, ctx) => {
      const repo = (parent as { repo: Repo }).repo;
      const number = argValue(field, 'number', ctx.variables) as number | undefined;
      const pull = repo.pulls.find((p) => p.number === number);
      return pull ? { __typename: 'PullRequest', repo, pull } : null;
    },
  },
  Issue: {
    id: (parent) => {
      const { repo, issue } = parent as { repo: Repo; issue: Issue };
      return issueGlobalId(repo, issue);
    },
    number: (parent) => (parent as { issue: Issue }).issue.number,
    title: (parent) => (parent as { issue: Issue }).issue.title,
    state: (parent) => (parent as { issue: Issue }).issue.state.toUpperCase(),
    body: (parent) => (parent as { issue: Issue }).issue.body,
  },
  IssueConnection: {
    nodes: (parent) => (parent as { nodes: unknown[] }).nodes,
    pageInfo: (parent) => (parent as { pageInfo: unknown }).pageInfo,
  },
  PageInfo: {
    hasNextPage: (parent) => (parent as { hasNextPage: boolean }).hasNextPage,
    endCursor: (parent) => (parent as { endCursor: string | null }).endCursor,
  },
  PullRequest: {
    id: (parent) => {
      const { repo, pull } = parent as { repo: Repo; pull: Pull };
      return pullGlobalId(repo, pull);
    },
    number: (parent) => (parent as { pull: Pull }).pull.number,
    title: (parent) => (parent as { pull: Pull }).pull.title,
    body: (parent) => (parent as { pull: Pull }).pull.body,
    headRefName: (parent) => (parent as { pull: Pull }).pull.headRef,
    baseRefName: (parent) => (parent as { pull: Pull }).pull.baseRef,
    mergeable: (parent, _field, ctx) => {
      const { repo, pull } = parent as { repo: Repo; pull: Pull };
      return mergeableOf(ctx.store, repo, pull);
    },
    state: (parent) => {
      const pull = (parent as { pull: Pull }).pull;
      if (pull.merged) return 'MERGED';
      return pull.state.toUpperCase();
    },
    merged: (parent) => (parent as { pull: Pull }).pull.merged,
    files: (parent, field, ctx) => {
      const { repo, pull } = parent as { repo: Repo; pull: Pull };
      const first = argValue(field, 'first', ctx.variables) as number | undefined;
      return { __typename: 'PullRequestConnection', nodes: prFiles(ctx.store, repo, pull, first).map((f) => ({ __typename: 'PullRequestChangedFile', ...f })) };
    },
  },
  PullRequestConnection: {
    nodes: (parent) => (parent as { nodes: unknown[] }).nodes,
  },
  PullRequestChangedFile: {
    path: (parent) => (parent as { path: string }).path,
  },
  User: {
    login: (parent) => (parent as { login: string }).login,
  },
  Ref: {
    name: (parent) => (parent as { name: string }).name,
  },
  __Type: {
    name: (parent) => (parent as { name: string }).name,
    kind: (parent) => (parent as { kind: string }).kind,
    fields: (parent) => {
      const fields = (parent as { fields: string[] | null }).fields;
      return fields ? fields.map((name) => ({ __typename: '__TypeField', name })) : null;
    },
    enumValues: (parent) => {
      const values = (parent as { enumValues: string[] | null }).enumValues;
      return values ? values.map((name) => ({ __typename: '__EnumValue', name })) : null;
    },
  },
  __TypeField: {
    name: (parent) => (parent as { name: string }).name,
  },
  __EnumValue: {
    name: (parent) => (parent as { name: string }).name,
  },
  __Schema: {
    queryType: (parent) => (parent as { queryType: unknown }).queryType,
  },
};

function typeNameOf(parent: unknown): string {
  if (parent && typeof parent === 'object' && '__typename' in (parent as Record<string, unknown>)) {
    return (parent as { __typename: string }).__typename;
  }
  return 'Query';
}

function executeSelection(parent: unknown, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = typeNameOf(parent);
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelection(parent, selection.selection, ctx));
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(selection.name);
      if (frag) Object.assign(out, executeSelection(parent, frag, ctx));
      continue;
    }
    const field = selection.field;
    const responseKey = field.alias ?? field.name;
    const resolvers = RESOLVERS[typeName];
    const resolver = resolvers?.[field.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(parent, field, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    if (value !== null && value !== undefined && field.selection.length > 0) {
      if (Array.isArray(value)) {
        out[responseKey] = value.map((item) => executeSelection(item, field.selection, ctx));
      } else if (typeof value === 'object') {
        out[responseKey] = executeSelection(value, field.selection, ctx);
      } else {
        out[responseKey] = value;
      }
    } else {
      out[responseKey] = value ?? null;
    }
  }
  return out;
}

// --------------------------------------------------------------------------- mutations

function findRepoByGlobalId(store: Store, globalId: string): Repo | undefined {
  const parsed = parseGid(globalId);
  if (!parsed || parsed.kind !== 'Repository') return undefined;
  return [...store.repos.values()].find((r) => String(r.id) === parsed.parts[0]);
}

function findIssueByGlobalId(store: Store, globalId: string): { repo: Repo; issue: Issue } | undefined {
  const parsed = parseGid(globalId);
  if (!parsed || parsed.kind !== 'Issue') return undefined;
  const repo = [...store.repos.values()].find((r) => String(r.id) === parsed.parts[0]);
  const issue = repo?.issues.find((i) => String(i.number) === parsed.parts[1]);
  return repo && issue ? { repo, issue } : undefined;
}

function findPullByGlobalId(store: Store, globalId: string): { repo: Repo; pull: Pull } | undefined {
  const parsed = parseGid(globalId);
  if (!parsed || parsed.kind !== 'PullRequest') return undefined;
  const repo = [...store.repos.values()].find((r) => String(r.id) === parsed.parts[0]);
  const pull = repo?.pulls.find((p) => String(p.number) === parsed.parts[1]);
  return repo && pull ? { repo, pull } : undefined;
}

const MUTATIONS: Record<string, Resolver> = {
  createIssue: (_parent, field, ctx) => {
    const input = argValue(field, 'input', ctx.variables) as { repositoryId?: string; title?: string; body?: string } | undefined;
    const repo = input?.repositoryId ? findRepoByGlobalId(ctx.store, input.repositoryId) : undefined;
    if (!repo || !input?.title) throw new Error('createIssue: unknown repository');
    const issue: Issue = {
      number: repo.nextIssue,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [],
      comments: [],
      createdSeq: repo.nextIssue,
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } };
  },
  closeIssue: (_parent, field, ctx) => {
    const input = argValue(field, 'input', ctx.variables) as { issueId?: string } | undefined;
    const found = input?.issueId ? findIssueByGlobalId(ctx.store, input.issueId) : undefined;
    if (!found) throw new Error('closeIssue: unknown issue');
    found.issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo: found.repo, issue: found.issue } };
  },
  createPullRequest: (_parent, field, ctx) => {
    const input = argValue(field, 'input', ctx.variables) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string } | undefined;
    const repo = input?.repositoryId ? findRepoByGlobalId(ctx.store, input.repositoryId) : undefined;
    if (!repo || !input?.title || !input.baseRefName || !input.headRefName) throw new Error('createPullRequest: unknown repository');
    const headTip = resolveRef(repo, `refs/heads/${input.headRefName}`);
    const baseTip = resolveRef(repo, `refs/heads/${input.baseRefName}`);
    if (!headTip || !baseTip) throw new Error('createPullRequest: unknown branch');
    const pull: Pull = {
      number: repo.nextPull,
      title: input.title,
      body: '',
      headRef: input.headRefName,
      baseRef: input.baseRefName,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      createdSeq: repo.nextPull,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
  },
  mergePullRequest: (_parent, field, ctx) => {
    const input = argValue(field, 'input', ctx.variables) as { pullRequestId?: string; mergeMethod?: string } | undefined;
    const found = input?.pullRequestId ? findPullByGlobalId(ctx.store, input.pullRequestId) : undefined;
    if (!found) throw new Error('mergePullRequest: unknown pull request');
    const sha = squashMerge(found.repo, found.pull);
    if (!sha) throw new Error('mergePullRequest: merge conflict');
    return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo: found.repo, pull: found.pull } };
  },
  addComment: (_parent, field, ctx) => {
    const input = argValue(field, 'input', ctx.variables) as { subjectId?: string; body?: string } | undefined;
    const found = input?.subjectId ? findIssueByGlobalId(ctx.store, input.subjectId) : undefined;
    if (!found || !input?.body) throw new Error('addComment: unknown subject');
    const id = found.repo.nextCommentId;
    found.repo.nextCommentId += 1;
    found.issue.comments.push({ id, body: input.body });
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'AddCommentEdge',
        node: { __typename: 'IssueComment', id: commentGlobalId(found.repo, found.issue, id), body: input.body },
      },
    };
  },
};

RESOLVERS.Mutation = MUTATIONS as Record<string, Resolver>;
// Payload object field passthroughs.
RESOLVERS.CreateIssuePayload = { issue: (p) => (p as { issue: unknown }).issue };
RESOLVERS.CloseIssuePayload = { issue: (p) => (p as { issue: unknown }).issue };
RESOLVERS.CreatePullRequestPayload = { pullRequest: (p) => (p as { pullRequest: unknown }).pullRequest };
RESOLVERS.MergePullRequestPayload = { pullRequest: (p) => (p as { pullRequest: unknown }).pullRequest };
RESOLVERS.AddCommentPayload = { commentEdge: (p) => (p as { commentEdge: unknown }).commentEdge };
RESOLVERS.AddCommentEdge = { node: (p) => (p as { node: unknown }).node };
RESOLVERS.IssueComment = {
  id: (p) => (p as { id: string }).id,
  body: (p) => (p as { body: string }).body,
};

// --------------------------------------------------------------------------- entry point

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

function executeOperation(store: Store, doc: DocumentNode, op: OperationNode, variables: Record<string, unknown>): GraphQLResult {
  const ctx: ExecContext = { store, variables: { ...variables }, fragments: doc.fragments, errors: [] };
  for (const varDef of op.variables) {
    if (ctx.variables[varDef.name] === undefined && varDef.defaultValue !== undefined) {
      ctx.variables[varDef.name] = resolveValue(varDef.defaultValue, ctx.variables);
    }
  }
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const root = { __typename: rootType };
  const data = executeSelection(root, op.selection, ctx);
  if (ctx.errors.length) return { data, errors: ctx.errors };
  return { data };
}

/**
 * Execute one GraphQL request body (single operation object, or a batch array).
 * Returns the response body object (or array) to send as JSON.
 */
export function executeGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  const runOne = (entry: unknown): GraphQLResult => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'GraphQL request must be an object with a query string' }] };
    }
    const query = (entry as { query?: unknown }).query;
    const variables = (entry as { variables?: unknown }).variables;
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'GraphQL request must include a query string' }] };
    }
    let doc: DocumentNode;
    try {
      doc = parseGraphQL(query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const operationName = (entry as { operationName?: unknown }).operationName;
    let op: OperationNode | undefined;
    if (typeof operationName === 'string') op = doc.operations.find((o) => o.name === operationName);
    else op = doc.operations[0];
    if (!op) return { data: null, errors: [{ message: `unknown operation ${String(operationName)}` }] };
    const vars = variables && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
    return executeOperation(store, doc, op, vars);
  };
  if (Array.isArray(body)) {
    if (body.length === 0) return { status: 400, body: { data: null, errors: [{ message: 'batched GraphQL request must not be empty' }] } };
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}

export { isoOf, nowEpochSec, flattenTree };
