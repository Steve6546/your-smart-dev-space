/**
 * GitHub REST API helpers via the Lovable connector gateway.
 *
 * Server-only. All calls go through `https://connector-gateway.lovable.dev/github`
 * with the linked workspace GitHub connection. No provider tokens leak to the
 * client; every helper is invoked from a server function or agent tool.
 *
 * Implements a minimal subset of GitHub's Git Data API required for the
 * agent's bidirectional sync: read tree/blobs, and create commits by
 * building tree + commit + updating a ref.
 */

const GATEWAY_URL = "https://connector-gateway.lovable.dev/github";

export type GitHubRepo = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  owner: { login: string };
  updated_at: string;
};

export type GitHubTreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
  url?: string;
};

const requireKeys = () => {
  const lovable = process.env.LOVABLE_API_KEY;
  const gh = process.env.GITHUB_API_KEY;
  if (!lovable) throw new Error("LOVABLE_API_KEY missing");
  if (!gh) throw new Error("GITHUB_API_KEY missing — link GitHub connector first");
  return { lovable, gh };
};

async function gh<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { lovable, gh: ghKey } = requireKeys();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${lovable}`);
  headers.set("X-Connection-Api-Key", ghKey);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${GATEWAY_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[github] ${init.method ?? "GET"} ${path} → ${res.status}`, body.slice(0, 500));
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------- Read side ----------

export async function listRepos(perPage = 50): Promise<GitHubRepo[]> {
  return gh<GitHubRepo[]>(
    `/user/repos?per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`,
  );
}

export async function getBranch(
  owner: string,
  repo: string,
  branch: string,
): Promise<{ name: string; commit: { sha: string } }> {
  return gh(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
}

export async function getTree(
  owner: string,
  repo: string,
  sha: string,
): Promise<{ sha: string; tree: GitHubTreeEntry[]; truncated: boolean }> {
  return gh(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
}

export async function getBlob(
  owner: string,
  repo: string,
  sha: string,
): Promise<{ content: string; encoding: "base64" | "utf-8"; size: number }> {
  return gh(`/repos/${owner}/${repo}/git/blobs/${sha}`);
}

/** Decode a blob to a UTF-8 string. Returns null for oversize/binary blobs. */
export function decodeBlob(
  blob: { content: string; encoding: string; size: number },
  maxBytes = 1_000_000,
): string | null {
  if (blob.size > maxBytes) return null;
  const raw = blob.encoding === "base64"
    ? Buffer.from(blob.content, "base64").toString("utf8")
    : blob.content;
  // Rough binary sniff — reject anything with NUL bytes.
  if (raw.includes("\u0000")) return null;
  return raw;
}

// ---------- Write side (Git Data API) ----------

export async function createBlob(
  owner: string,
  repo: string,
  content: string,
): Promise<{ sha: string }> {
  return gh(`/repos/${owner}/${repo}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({
      content: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64",
    }),
  });
}

export async function createTree(
  owner: string,
  repo: string,
  baseTree: string,
  entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }>,
): Promise<{ sha: string }> {
  return gh(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTree, tree: entries }),
  });
}

export async function createCommit(
  owner: string,
  repo: string,
  args: { message: string; tree: string; parents: string[] },
): Promise<{ sha: string }> {
  return gh(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function updateRef(
  owner: string,
  repo: string,
  branch: string,
  sha: string,
  force = false,
): Promise<{ ref: string; object: { sha: string } }> {
  return gh(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha, force }),
  });
}

/**
 * Commit a batch of file changes on a branch:
 *   1. For each write: upload blob → collect { path, sha }.
 *   2. For each delete: emit tree entry with sha=null.
 *   3. Build tree on top of current branch HEAD, commit, fast-forward ref.
 * Returns the new commit SHA.
 */
export async function commitFiles(
  owner: string,
  repo: string,
  branch: string,
  message: string,
  writes: Array<{ path: string; content: string }>,
  deletes: string[] = [],
): Promise<{ sha: string }> {
  const head = await getBranch(owner, repo, branch);
  const parentSha = head.commit.sha;
  const blobShas = await Promise.all(
    writes.map(async (w) => {
      const b = await createBlob(owner, repo, w.content);
      return { path: w.path, mode: "100644" as const, type: "blob" as const, sha: b.sha };
    }),
  );
  const deleteEntries = deletes.map((p) => ({
    path: p,
    mode: "100644" as const,
    type: "blob" as const,
    sha: null,
  }));
  const tree = await createTree(owner, repo, parentSha, [...blobShas, ...deleteEntries]);
  const commit = await createCommit(owner, repo, {
    message,
    tree: tree.sha,
    parents: [parentSha],
  });
  await updateRef(owner, repo, branch, commit.sha);
  return { sha: commit.sha };
}
