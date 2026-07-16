# Agent Engine

CodeMind's agent turns are executed as a staged pipeline instead of a single
free-form `streamText` call. Each stage has a single responsibility and can
be developed / tested in isolation.

## Stages

| # | Stage           | Where                                                        | Mutates files? |
|---|-----------------|--------------------------------------------------------------|----------------|
| 1 | Receive         | `chat.ts` POST handler — persists the user's message         | no             |
| 2 | Understand      | `generateText` on gateway model → `{ goal, taskType, keywords }` | no         |
| 3 | Locate          | `searchIndex()` against `project_index` for each keyword     | no             |
| 4 | Read Context    | Agent stage — model calls `read_file` for chosen paths only  | no             |
| 5 | Plan            | `generateText` — drafts a short numbered plan                | no             |
| 6 | Apply Patch     | `streamText` + tools (`edit_file`, `write_file`, …)          | YES (only here)|
| 7 | Verify          | Model re-reads or `grep`s to confirm; retries on tool errors | no             |
| 8 | Save Result     | `onFinish` — persist snapshots, update index, memory, title  | no             |

Stages 2, 3, 5 run **before** the streaming apply phase and their outputs
are injected into the system prompt under `# Understanding`, `# Located
files`, and `# Plan`. Only stage 6 has access to mutating tools.

## Rules the engine enforces

- **No blind writes.** The model must `read_file` a target before editing it.
- **Index first.** The read-only tool set exposes `index_search` for cheap
  file discovery; the prompt tells the agent to prefer it over `grep` /
  `list_files`.
- **Auto-index.** Every successful mutating tool call updates the Project
  Index synchronously so subsequent stages see fresh symbol data.
- **Snapshotting.** Every write records a `file_snapshots` row keyed by the
  assistant message id, so a whole turn can be rolled back.
- **Retry once.** On a tool error the agent adjusts inputs and retries a
  single time before reporting.

## Failure modes handled

- The Understand / Plan stages catch `NoObjectGeneratedError` and fall back
  to raw text parsing, so a malformed structured reply cannot crash a turn.
- The Locate stage is best-effort — if the index is empty on the first turn
  it is bootstrapped via `indexProject()`; if queries yield nothing the
  system prompt tells the model to fall back to `list_files` / `grep`.
- The Save stage runs inside `onFinish` and is wrapped in `try/catch` so a
  persistence hiccup never breaks the streamed reply.
