# GitHub Sync

CodeMind projects can be linked to a GitHub repository for bidirectional sync.

## Authentication

The workspace GitHub connector is used for all API calls. There is no per-user OAuth;
every user in the workspace can push commits using the connection's token.

Calls are routed through the Lovable connector gateway:

```
https://connector-gateway.lovable.dev/github/<endpoint>
Authorization: Bearer $LOVABLE_API_KEY
X-Connection-Api-Key: $GITHUB_API_KEY
```

## UI

The GitHub icon in the workspace header opens **GitHubDialog**. From there you can:

- **List repos** — enumerates repos visible to the workspace connection.
- **Link** — attaches a repo to the project without importing files.
- **Import** — clones the repo tree into the `files` table and re-indexes.
- **Pull** — fetches new commits since `last_sha` and upserts changed files.
- **Push all** — commits all project files to the linked branch.

## Data model

```
public.github_connections (
  project_id  uuid  UNIQUE,
  repo_owner  text,
  repo_name   text,
  default_branch text,
  last_sha    text,
  sync_mode   text  -- 'manual' for now
)
```

RLS: owners only.

## Agent tools

The Agent Engine exposes these tools in the streaming chat:

| Tool | Purpose |
|---|---|
| `github_list_repos` | Enumerate visible repos. |
| `github_read_file` | Read a single file from ANY repo (no import). |
| `github_commit_push` | Commit selected paths (or all) to the linked repo. |

Push happens only when the user explicitly asks for it (commit / push / sync).

## Git Data API flow

Push uses GitHub's Git Data API:

1. `POST /git/blobs` — upload each file content as a base64 blob.
2. `POST /git/trees` with `base_tree = HEAD^{tree}` — build a new tree.
3. `POST /git/commits` — create a commit with the new tree.
4. `PATCH /git/refs/heads/<branch>` — fast-forward the branch ref.

Deletes are represented as tree entries with `sha: null`.

## Import filters

Import skips:

- `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `.turbo/`, `coverage/`,
  `target/`, `__pycache__/`, `venv/`, `.venv/`
- Binary/media/font/archive files (`.png`, `.mp4`, `.zip`, `.woff2`, …)
- Anything over 1 MB
- Anything containing NUL bytes (binary sniff)

## Failure modes

- **`GITHUB_API_KEY missing`** — connector not linked to project. Reopen dialog and re-link.
- **`GitHub API 404`** — repo/branch does not exist under the connection's token.
- **`GitHub API 409`** — non-fast-forward push. Pull first, resolve conflicts, retry.
- **`GitHub API 403`** — insufficient scope (private repo without `repo` scope). Reconnect
  the workspace connector with the right scopes.
