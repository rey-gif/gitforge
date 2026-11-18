# gitforge — a standalone GitHub-compatible git forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun)
[![rank](https://make.fun/badge/github-core-clone-01/rey-gif/gitforge/rank.svg)](https://make.fun)
[![reward](https://make.fun/badge/github-core-clone-01/rey-gif/gitforge/reward.svg)](https://make.fun)

A single-process, standard-library-only GitHub-compatible forge written in
TypeScript for Node 22, built for the
[make.fun github-core-clone-01 bounty](https://make.fun).

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 upload-pack
  (`fetch`, `ls-refs`, shallow/deepen) and v0 upload-pack / receive-pack
  (`report-status`, `side-band-64k`, `delete-refs`), fast-forward-only pushes,
  packfiles with SHA-1 verification.
- **REST v3** under `/api/v3` — repos, branches, commits, contents, labels,
  issues, comments, pull requests (squash merge with conflict detection),
  git refs.
- **GraphQL** at `/api/graphql` — the `gh` / `github-mcp-server` documents:
  viewer, repository, issues (filter/order/cursor pagination), pull requests,
  mutations, `node(id:)`, `__type` introspection, batched operations.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, modern `2026-07-28`
  (`server/discover`) and legacy (`initialize`) eras, six tools acting on the
  same store as REST.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
and polls `$MAKEFUN_ENV_URL/done` until the suite finishes. It needs no
network, no git binary, no package manager: everything lives in memory.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll done, exit 0).
- `app.ts` — the HTTP server: routing, REST v3, git smart HTTP.
- `core.ts` — the in-memory store, git object model, packfile + pkt-line codecs.
- `graphql.ts` — a small GraphQL parser + executor.
- `mcp.ts` — the MCP endpoint and its six tools.
