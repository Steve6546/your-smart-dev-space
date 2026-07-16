# Project Index

A per-project symbol / metadata cache that lets the Agent Engine locate
relevant files without re-reading the whole project on every turn.

## Storage — `public.project_index`

One row per file (or folder). RLS: owners only.

| Column          | Notes                                                       |
|-----------------|-------------------------------------------------------------|
| `path`          | File path, unique per `project_id`                          |
| `kind`          | `file` or `folder`                                          |
| `language`      | Inferred from extension                                     |
| `size`          | Byte size at index time                                     |
| `functions`     | Function names (regex-extracted, capped at 200)             |
| `classes`       | Class names                                                 |
| `interfaces`    | TS `interface` names                                        |
| `types`         | TS `type` names                                             |
| `imports`       | Imported module specifiers                                  |
| `exports`       | Named exports                                               |
| `routes`        | `createFileRoute("...")` targets                            |
| `api_endpoints` | Derived from paths under `src/routes/api/`                  |
| `db_tables`     | `.from("table")` targets and `CREATE TABLE` in `.sql` files |
| `env_vars`      | `process.env.X`, `import.meta.env.VITE_X`                   |
| `symbols_hash`  | Non-crypto hash of file content — cheap "did it change?"    |

## Extractor — `src/lib/project-index.server.ts`

Regex-based, Worker-safe. Deliberately not a TypeScript AST parser:

- Fast enough to run on every write.
- No native dependencies (Cloudflare Workers runtime constraint).
- Trades exhaustiveness for reliability — captures enough to *locate* files;
  reading the file is still cheap.

Extraction is per-language. TypeScript/JavaScript get the widest coverage;
SQL gets `CREATE TABLE` only; everything else gets `env_vars` and any
`.from("table")` matches.

## Lifecycle

| Event                          | Action                                       |
|--------------------------------|----------------------------------------------|
| First turn on a project        | `indexProject()` if `project_index` is empty |
| `write_file` / `edit_file`     | `indexFile()` upsert for that path           |
| `create_folder`                | `indexFile()` upsert with `kind = folder`    |
| `delete_file`                  | `removeFromIndex()`                          |
| `delete_path`                  | `removePrefixFromIndex()` (path + subtree)   |
| `rename_file` / `move_path`    | `renameInIndex()` — path rewrite, no re-scan |

`indexProject()` is idempotent and safe to re-run; call
`rebuildProjectIndex` manually only when the extractor rules change.

## Query — `searchIndex()`

Two search modes:

- `symbol: "createFileRoute"` — matches any row whose `functions`,
  `classes`, `exports`, `routes`, `api_endpoints`, or `db_tables` array
  **contains** that symbol (PostgREST `cs` operator).
- `query: "auth"` — case-insensitive path substring match.

Results are compact (`{ path, language, functions, classes, exports,
routes, api_endpoints, db_tables }`) and capped to 50 rows.

The `index_search` tool exposes this to the agent; the pre-Locate stage
inside `chat.ts` calls it directly for each keyword.

## Non-goals

- Symbol references / call graph. Regex is not enough for that — use `grep`
  when a call-site search is needed.
- Cross-project search. Every row is scoped by `project_id`.
