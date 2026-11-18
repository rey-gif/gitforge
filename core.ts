// core.ts — the forge's in-memory store, git object model, packfile + pkt-line codecs.
// Standard library only. No wall clock except MAKEFUN_TRIAL_NOW (else Date.now).
// Deterministic ids: a counter for request ids, content hashes for git objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const STRANGER = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' };

/** Seconds since epoch for server-made commits: MAKEFUN_TRIAL_NOW (ms) when set, else now. */
export function nowEpochSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n > 1e12 ? n / 1000 : n);
  }
  return Math.floor(Date.now() / 1000);
}

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

let reqCounter = 0;
export function nextRequestId(): string {
  reqCounter += 1;
  return `req-${reqCounter}`;
}

// --------------------------------------------------------------------------- git objects

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return Buffer.compare(Buffer.from(an, 'utf8'), Buffer.from(bn, 'utf8'));
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], epochSec: number, message: string): Buffer {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${ident}`, `committer ${ident}`, '', message.endsWith('\n') ? message : `${message}\n`];
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function buildTag(targetOid: string, tagName: string, epochSec: number, message: string): Buffer {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${epochSec} +0000`;
  return Buffer.from(`object ${targetOid}\ntype commit\ntag ${tagName}\ntagger ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
}

// --------------------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'end';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Decode pkt-lines from the front of `buf`. Stops at the first flush (returning the bytes
 * after it as `rest`, for the raw pack that follows a receive-pack command list) or at the
 * end of the buffer. Throws on malformed framing.
 */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line header ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(offset + 4) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  if (offset !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return { packets, rest: Buffer.alloc(0) };
}

export function pktLinesText(packets: Pkt[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

// --------------------------------------------------------------------------- packfiles

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Plain-object pack (no deltas): PACK v2 + entries + SHA-1 trailer. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2, 0);
  parts[2].writeUInt32BE(objects.length, 0);
  for (const obj of objects) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const head = Buffer.concat(parts);
  const trailer = createHash('sha1').update(head).digest();
  return Buffer.concat([head, trailer]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset];
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset];
    offset += 1;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos];
      pos += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos]; pos += 1; }
      if (op & 0x02) { offset |= delta[pos] << 8; pos += 1; }
      if (op & 0x04) { offset |= delta[pos] << 16; pos += 1; }
      if (op & 0x08) { offset |= delta[pos] << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos]; pos += 1; }
      if (op & 0x20) { size |= delta[pos] << 8; pos += 1; }
      if (op & 0x40) { size |= delta[pos] << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== tgtSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/**
 * Read a pack (plain objects and OFS/REF deltas). Returns objects keyed by oid.
 * `resolveBase` supplies thin-pack bases the client already holds.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  const resolve = (oid: string): GitObject => {
    const found = objects.get(oid) ?? resolveBase?.(oid);
    if (!found) throw new Error(`delta base ${oid} not available`);
    return found;
  };
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(pack, offset);
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    let base: GitObject | undefined;
    if (typeCode === 6) {
      const { baseOffset, next: after } = readOfsDeltaBase(pack, offset);
      base = byOffset.get(entryOffset - baseOffset);
      if (!base) throw new Error('ofs-delta base not found');
      offset = after;
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      base = resolve(baseOid);
      offset += 20;
    }
    const { data: raw, next: afterInflate } = inflateAt(pack, offset);
    offset = afterInflate;
    let obj: GitObject;
    if (typeCode === 6 || typeCode === 7) {
      if (!base) throw new Error('delta without base');
      obj = { type: base.type, data: applyDelta(base.data, raw) };
    } else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      if (raw.length !== size) throw new Error('object size mismatch');
      obj = { type, data: raw };
    }
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
    byOffset.set(entryOffset, obj);
  }
  return objects;
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return expected === actual;
}

// --------------------------------------------------------------------------- global ids

export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- store

export interface UserInfo {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, string>; // name -> color
  issues: Issue[];
  nextIssue: number;
  nextCommentId: number;
  pulls: Pull[];
  nextPull: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, priv: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      private: priv,
      defaultBranch: 'main',
      createdSeq: this.seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      nextIssue: 1,
      nextCommentId: 1,
      pulls: [],
      nextPull: 1,
    };
    this.nextRepoId += 1;
    this.seq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }
}

// --------------------------------------------------------------------------- repo git ops

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (ref === 'HEAD') return repo.refs.get(headRefName(repo));
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  // Bare branch names resolve against refs/heads/.
  if (!ref.startsWith('refs/')) return repo.refs.get(`refs/heads/${ref}`);
  return undefined;
}

export function makeCommit(repo: Repo, tree: string, parents: string[], message: string, epochSec?: number): string {
  const data = buildCommit(tree, parents, epochSec ?? nowEpochSec(), message);
  return putObject(repo, 'commit', data);
}

/** Flat path map of a tree: path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build nested trees from a flat path map; returns the root tree oid. */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** All commit oids reachable from `tip` (following parents), tip first. */
export function commitAncestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return commitAncestors(repo, tip).has(ancestor);
}

/** First common ancestor of a and b walking a's history newest-first. */
export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const bAncestors = commitAncestors(repo, b);
  const seen = new Set<string>();
  const queue = [a];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (bAncestors.has(oid)) return oid;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return undefined;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff of two trees (flat maps). */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): DiffEntry[] {
  const base = baseTree ? flattenTree(repo, baseTree) : new Map();
  const head = headTree ? flattenTree(repo, headTree) : new Map();
  const out: DiffEntry[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  out.sort((x, y) => (x.path < y.path ? -1 : 1));
  return out;
}

/** Commit oids reachable from a set of tips, minus those reachable from `exclude` tips. */
export function reachableCommits(repo: Repo, tips: string[], excludeTips: string[]): Set<string> {
  const excluded = new Set<string>();
  for (const tip of excludeTips) for (const oid of commitAncestors(repo, tip)) excluded.add(oid);
  const out = new Set<string>();
  for (const tip of tips) {
    for (const oid of commitAncestors(repo, tip)) if (!excluded.has(oid)) out.add(oid);
  }
  return out;
}

/** All objects reachable from `tips` (commits, their trees/blobs, tag targets). */
export function collectObjects(repo: Repo, tips: string[], excludeTips: string[] = []): Map<string, GitObject> {
  const excluded = new Set<string>();
  const excludeCommits = new Set<string>();
  for (const tip of excludeTips) for (const oid of commitAncestors(repo, tip)) excludeCommits.add(oid);
  const collectFrom = (oid: string, into: Map<string, GitObject>): void => {
    if (into.has(oid) || excluded.has(oid)) return;
    const obj = getObject(repo, oid);
    if (!obj) return;
    excluded.add(oid);
    into.set(oid, obj);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      collectFrom(view.tree, into);
      for (const parent of view.parents) {
        if (!excludeCommits.has(parent)) collectFrom(parent, into);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) collectFrom(entry.oid, into);
    } else if (obj.type === 'tag') {
      const target = obj.data.toString('utf8').split('\n').find((l) => l.startsWith('object '))?.slice(7).trim();
      if (target) collectFrom(target, into);
    }
  };
  const out = new Map<string, GitObject>();
  // Objects reachable from the exclude tips must not be sent: pre-mark them excluded.
  const markExcluded = (oid: string): void => {
    if (excluded.has(oid)) return;
    const obj = getObject(repo, oid);
    if (!obj) return;
    excluded.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      markExcluded(view.tree);
      for (const parent of view.parents) markExcluded(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) markExcluded(entry.oid);
    } else if (obj.type === 'tag') {
      const target = obj.data.toString('utf8').split('\n').find((l) => l.startsWith('object '))?.slice(7).trim();
      if (target) markExcluded(target);
    }
  };
  for (const tip of excludeTips) markExcluded(tip);
  excluded.clear();
  for (const tip of excludeTips) markExcluded(tip);
  for (const tip of tips) collectFrom(tip, out);
  return out;
}

export interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Compute what a fetch sends. `wants` are commit/tag oids, `haves` commits the client
 * holds, `shallowBoundaries` the client's current shallow set, `depth` the deepen limit.
 * Objects are plain (no deltas); shallow bookkeeping follows git's boundary rule: a
 * boundary is a commit whose parents are not all held after this fetch.
 */
export function fetchPlan(repo: Repo, wants: string[], haves: string[], shallowBoundaries: string[], depth: number | null): FetchPlan {
  // Commits the client holds before this fetch: haves' closure, not descending past
  // a shallow boundary (history stops there on the client).
  const heldBefore = new Set<string>();
  const walkHeld = (oid: string): void => {
    if (heldBefore.has(oid)) return;
    heldBefore.add(oid);
    if (shallowBoundaries.includes(oid)) return;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return;
    for (const parent of parseCommit(obj.data).parents) walkHeld(parent);
  };
  for (const have of haves) walkHeld(have);

  // Commits to include: from wants, within `depth` generations when limited.
  const included = new Set<string>();
  if (depth !== null) {
    let frontier = [...wants];
    for (let gen = 1; gen <= depth && frontier.length; gen += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        const obj = getObject(repo, oid);
        if (!obj) continue;
        if (obj.type === 'tag') {
          const target = obj.data.toString('utf8').split('\n').find((l) => l.startsWith('object '))?.slice(7).trim();
          if (target) next.push(target);
          continue;
        }
        if (obj.type !== 'commit') continue;
        // A want the client already holds still contributes its parents: deepen
        // extends history *past* the held tip by one generation per level.
        if (!included.has(oid) && !heldBefore.has(oid)) included.add(oid);
        for (const parent of parseCommit(obj.data).parents) next.push(parent);
      }
      frontier = next;
    }
  } else {
    for (const want of wants) {
      const obj = getObject(repo, want);
      if (obj?.type === 'tag') {
        const target = obj.data.toString('utf8').split('\n').find((l) => l.startsWith('object '))?.slice(7).trim();
        if (target) for (const oid of commitAncestors(repo, target)) if (!heldBefore.has(oid)) included.add(oid);
        continue;
      }
      for (const oid of commitAncestors(repo, want)) if (!heldBefore.has(oid)) included.add(oid);
    }
  }

  const heldAfter = new Set([...heldBefore, ...included]);
  // New shallow set: old boundaries still missing a parent, plus depth-limited
  // boundary commits (included commits with a parent outside heldAfter).
  const newShallow = new Set<string>();
  for (const boundary of shallowBoundaries) {
    const obj = getObject(repo, boundary);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0) { newShallow.add(boundary); continue; }
    if (!parents.every((p) => heldAfter.has(p))) newShallow.add(boundary);
  }
  if (depth !== null) {
    for (const oid of included) {
      const obj = getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0 && !parents.every((p) => heldAfter.has(p))) newShallow.add(oid);
      if (parents.length === 0) newShallow.add(oid);
    }
  }
  const shallow = [...newShallow];
  const unshallow = shallowBoundaries.filter((b) => !newShallow.has(b));

  // Objects: everything reachable from wants, minus everything reachable from haves'
  // closure (heldBefore) — but a depth-limited fetch must not send ancestors past the
  // depth even when the client does not hold them.
  let objects: Map<string, GitObject>;
  if (depth !== null) {
    objects = new Map<string, GitObject>();
    const seen = new Set<string>();
    const addFrom = (oid: string): void => {
      if (seen.has(oid) || heldBefore.has(oid)) return;
      const obj = getObject(repo, oid);
      if (!obj) return;
      seen.add(oid);
      objects.set(oid, obj);
      if (obj.type === 'commit') {
        addFrom(parseCommit(obj.data).tree);
        // Only descend into parents that are themselves included.
        for (const parent of parseCommit(obj.data).parents) if (included.has(parent)) addFrom(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) addFrom(entry.oid);
      } else if (obj.type === 'tag') {
        const target = obj.data.toString('utf8').split('\n').find((l) => l.startsWith('object '))?.slice(7).trim();
        if (target) addFrom(target);
      }
    };
    for (const want of wants) {
      const obj = getObject(repo, want);
      if (!obj) continue;
      if (obj.type === 'tag') { addFrom(want); continue; }
    }
    for (const oid of included) addFrom(oid);
  } else {
    objects = collectObjects(repo, wants, haves);
  }
  return { objects, shallow, unshallow };
}

/** Three-way file conflict check for merging `headTip` into `baseTip`. */
export function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const mb = mergeBase(repo, baseTip, headTip);
  const baseTree = mb ? parseCommit(getObject(repo, mb)?.data ?? Buffer.alloc(0)).tree : null;
  const headTree = parseCommit(getObject(repo, headTip)?.data ?? Buffer.alloc(0)).tree;
  const tipTree = parseCommit(getObject(repo, baseTip)?.data ?? Buffer.alloc(0)).tree;
  const baseFlat = baseTree ? flattenTree(repo, baseTree) : new Map();
  const headFlat = flattenTree(repo, headTree);
  const tipFlat = flattenTree(repo, tipTree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path)?.oid ?? null;
    const h = headFlat.get(path)?.oid ?? null;
    const t = tipFlat.get(path)?.oid ?? null;
    if (h !== b && t !== b && h !== t) return true;
  }
  return false;
}

/** Squash-merge a pull request: one commit with the head tree on the base tip. */
export function squashMerge(repo: Repo, pr: Pull): string | null {
  const baseTip = resolveRef(repo, pr.baseRef);
  const headTip = resolveRef(repo, pr.headRef);
  if (!baseTip || !headTip) return null;
  if (mergeConflicts(repo, baseTip, headTip)) return null;
  const headTree = parseCommit(getObject(repo, headTip)?.data ?? Buffer.alloc(0)).tree;
  const sha = makeCommit(repo, headTree, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = isoOf(nowEpochSec());
  pr.mergeSha = sha;
  return sha;
}
