## Goal

Refactor the chat agent so it no longer jumps straight into `write_file` / `edit_file`. Instead it flows through a staged **Agent Engine** and consults a persistent **Project Index** to locate relevant files without reading the whole repo each turn.

## Part 1 — Project Index

**New table `project_index`** (migration, RLS + grants):
```
id uuid pk, project_id uuid, user_id uuid, path text,
kind text ('file'|'folder'), language text,
size int, updated_at timestamptz,
functions text[], classes text[], interfaces text[], types text[],
imports text[], exports text[], routes text[], api_endpoints text[],
db_tables text[], env_vars text[],
symbols_hash text,
unique(project_id, path)
```

**New file `src/lib/project-index.server.ts`**:
- `extractSymbols(path, content)` — lightweight regex extractors for TS/TSX/JS/JSX/SQL:
  - functions: `function X`, `const X = (…) =>`, `export function`
  - classes / interfaces / types / imports / exports
  - routes: `createFileRoute("...")`
  - api endpoints: paths under `src/routes/api/`
  - db tables: `from("<table>")`, `CREATE TABLE <name>`
  - env vars: `process.env.X`, `import.meta.env.VITE_X`
- `indexProject(projectId)` — full rebuild from `files` table (batched upsert)
- `indexFile(projectId, path, content)` — incremental single-file upsert
- `removeFromIndex(projectId, path)` — on delete
- `searchIndex(projectId, { query?, symbol?, kind? })` — returns compact rows

**New server fns in `src/lib/workspace.functions.ts`** (authenticated):
- `rebuildProjectIndex({ projectId })`
- `queryProjectIndex({ projectId, query, symbol })`

**Auto-update**: every mutating tool (`write_file`, `edit_file`, `delete_file`, `delete_path`, `rename_file`, `move_path`) calls `indexFile` / `removeFromIndex` after success. First chat turn triggers `indexProject` if the index is empty.

## Part 2 — Agent Engine (staged pipeline)

**New file `src/lib/agent-engine.server.ts`** — single entry point `runAgentTurn(ctx)`, with exported stage functions so each is testable in isolation:

```
1. receiveRequest(ctx)      // persist user msg, init task record
2. understandRequest(ctx)   // small LLM call → { goal, taskType, keywords }
3. locateFiles(ctx)         // queryProjectIndex(keywords) → candidate paths
4. readContext(ctx)         // read only candidate files (cap N, size)
5. createPlan(ctx)          // LLM call → { steps[], filesToEdit[], risks[] }
6. applyPatch(ctx)          // stream main LLM with tools restricted to edit ops
7. verify(ctx)              // typecheck + lint tool calls, retry ≤ 2
8. saveResult(ctx)          // update index, project_memory, chat_messages
```

Rules enforced in the engine:
- Stages 2/3/5 produce structured JSON (Zod-validated) but **no file writes**.
- Stage 6 is the only stage allowed to invoke mutating tools; earlier stages get a read-only tool subset.
- Each stage emits a `stage` event into the UI stream (data part) so the Task Panel can render progress: `understanding → locating → planning → applying → verifying → done`.

**Refactor `src/routes/api/chat.ts`**:
- Extract tool factory to `src/lib/agent-tools.server.ts` (unchanged behavior; adds `readOnly` split and `index_search` tool).
- POST handler validates + auths, then delegates to `runAgentTurn`. Streaming response comes from stage 6's `streamText` piped through `toUIMessageStreamResponse`, with earlier stages emitting data parts.

**New tool `index_search`** (read-only) exposed to all stages:
- Input: `{ query?: string, symbol?: string }`
- Returns: `[{ path, functions, classes, exports }]` from `project_index`.

## Part 3 — UI (minimal)

- `ChatPanel.tsx`: render new `stage` data parts as a compact stepper above the streaming message (Understanding → Locating → Planning → Applying → Verifying). No layout overhaul.

## Part 4 — Docs

Add:
- `docs/AGENT_ENGINE.md` — the 8 stages, contracts, retry rules.
- `docs/PROJECT_INDEX.md` — schema, extractors, incremental update contract.

## Technical notes

- Symbol extraction stays regex-based (no TS AST) to keep it Worker-safe and fast.
- All new tables get explicit `GRANT` + RLS `auth.uid() = user_id` policies.
- Index rows capped: `functions`/etc arrays truncated to 200 entries per file.
- Understand/Plan LLM calls use `Output.object` with **small** Zod schemas (no `.min/.max`) per gateway rules, wrapped in `NoObjectGeneratedError` fallback.
- Verify stage: for now runs project-scoped checks that we can do server-side (path-based lint of edited files: JSON parse, basic TS syntax via `esbuild.transform` if available; otherwise a no-op that returns "skipped"). E2B integration is out of scope for this task.

## Out of scope

- E2B sandbox execution (deferred).
- Full TS AST-based symbol extraction.
- Any redesign of the workspace layout beyond the stepper.

Proceeding will touch ~6 new files, 2 edited files, 1 migration.