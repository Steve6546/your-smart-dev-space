/**
 * Server functions for GitHub integration:
 *   - listUserRepos          → browse workspace-visible repos
 *   - getConnection          → read the current project→repo link
 *   - saveConnection         → attach a project to owner/repo/branch
 *   - deleteConnection       → detach
 *   - importRepo             → snapshot repo tree → files table + re-index
 *   - pushChanges            → commit selected paths to the linked branch
 *   - pullLatest             → fetch new commits since last_sha into files table
 *
 * Every write path is authenticated (requireSupabaseAuth). GitHub credentials
 * come from the workspace connector — no per-user OAuth stored here.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const OwnerRepo = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
});

const langFromPath = (p: string): string => {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      py: "python", js: "javascript", ts: "typescript", tsx: "typescript",
      jsx: "javascript", html: "html", css: "css", scss: "scss", json: "json",
      md: "markdown", yml: "yaml", yaml: "yaml", sql: "sql", sh: "shell",
      rs: "rust", go: "go", java: "java", kt: "kotlin", rb: "ruby", php: "php",
    }[ext] ?? "plaintext"
  );
};

// Files to skip during import (binary/generated/heavy).
const SKIP_PATH = /(^|\/)(node_modules|\.git|dist|build|\.next|\.turbo|coverage|target|__pycache__|\.venv|venv)(\/|$)/;
const SKIP_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp",
  "mp3", "mp4", "webm", "wav", "ogg", "mov",
  "zip", "tar", "gz", "rar", "7z",
  "pdf", "doc", "docx", "xls", "xlsx",
  "woff", "woff2", "ttf", "otf", "eot",
  "lock", "wasm", "exe", "dll", "so", "dylib",
]);

const skip = (path: string): boolean => {
  if (SKIP_PATH.test(path)) return true;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SKIP_EXT.has(ext);
};

export const listUserRepos = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { listRepos } = await import("./github.server");
    const repos = await listRepos(100);
    return repos.map((r) => ({
      name: r.name,
      full_name: r.full_name,
      owner: r.owner.login,
      private: r.private,
      default_branch: r.default_branch,
      updated_at: r.updated_at,
    }));
  });

export const getConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { data: row } = await context.supabase
      .from("github_connections")
      .select("repo_owner, repo_name, default_branch, last_sha, sync_mode, updated_at")
      .eq("project_id", data.projectId)
      .maybeSingle();
    return row;
  });

export const saveConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      projectId: z.string().uuid(),
      owner: z.string().min(1).max(100),
      repo: z.string().min(1).max(100),
      branch: z.string().min(1).max(120).default("main"),
    }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("github_connections")
      .upsert(
        {
          user_id: context.userId,
          project_id: data.projectId,
          repo_owner: data.owner,
          repo_name: data.repo,
          default_branch: data.branch,
          sync_mode: "manual",
        },
        { onConflict: "project_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    await context.supabase
      .from("github_connections")
      .delete()
      .eq("project_id", data.projectId);
    return { ok: true };
  });

export const importRepo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      projectId: z.string().uuid(),
      owner: z.string().min(1).max(100),
      repo: z.string().min(1).max(100),
      branch: z.string().min(1).max(120).default("main"),
      clear: z.boolean().default(false),
    }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { getBranch, getTree, getBlob, decodeBlob } = await import("./github.server");
    const { indexProject } = await import("./project-index.server");

    // 1) Resolve HEAD, get recursive tree.
    const head = await getBranch(data.owner, data.repo, data.branch);
    const tree = await getTree(data.owner, data.repo, head.commit.sha);
    if (tree.truncated) {
      console.warn(`[github import] repo too large — tree was truncated`);
    }

    const blobs = tree.tree.filter((e) => e.type === "blob" && !skip(e.path));

    // 2) Optionally wipe existing files.
    if (data.clear) {
      await context.supabase.from("files").delete().eq("project_id", data.projectId);
    }

    // 3) Fetch blobs (bounded concurrency) and upsert into files.
    let imported = 0;
    let skipped = 0;
    const CONC = 8;
    for (let i = 0; i < blobs.length; i += CONC) {
      const slice = blobs.slice(i, i + CONC);
      const results = await Promise.all(
        slice.map(async (b) => {
          try {
            const blob = await getBlob(data.owner, data.repo, b.sha);
            const content = decodeBlob(blob);
            if (content === null) return { path: b.path, ok: false as const };
            return { path: b.path, ok: true as const, content };
          } catch (e) {
            console.error(`[github import] blob fail ${b.path}`, e);
            return { path: b.path, ok: false as const };
          }
        }),
      );
      const rows = results
        .filter((r): r is { path: string; ok: true; content: string } => r.ok)
        .map((r) => ({
          project_id: data.projectId,
          user_id: context.userId,
          path: r.path,
          content: r.content,
          language: langFromPath(r.path),
          is_folder: false,
        }));
      if (rows.length) {
        await context.supabase
          .from("files")
          .upsert(rows, { onConflict: "project_id,path" });
        imported += rows.length;
      }
      skipped += results.filter((r) => !r.ok).length;
    }

    // 4) Save connection + head SHA.
    await context.supabase
      .from("github_connections")
      .upsert(
        {
          user_id: context.userId,
          project_id: data.projectId,
          repo_owner: data.owner,
          repo_name: data.repo,
          default_branch: data.branch,
          last_sha: head.commit.sha,
          sync_mode: "manual",
        },
        { onConflict: "project_id" },
      );

    // 5) Full re-index.
    await indexProject(context.supabase, { projectId: data.projectId, userId: context.userId });

    return { imported, skipped, sha: head.commit.sha, truncated: tree.truncated };
  });

export const pushChanges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      projectId: z.string().uuid(),
      message: z.string().min(1).max(500),
      paths: z.array(z.string().max(500)).min(1).max(500).optional(),
    }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { commitFiles } = await import("./github.server");
    const { data: conn } = await context.supabase
      .from("github_connections")
      .select("repo_owner, repo_name, default_branch")
      .eq("project_id", data.projectId)
      .maybeSingle();
    if (!conn) throw new Error("No GitHub repo connected to this project");

    // Fetch files to push.
    let query = context.supabase
      .from("files")
      .select("path, content, is_folder")
      .eq("project_id", data.projectId)
      .eq("is_folder", false);
    if (data.paths?.length) query = query.in("path", data.paths);
    const { data: files, error } = await query;
    if (error) throw new Error(error.message);
    if (!files?.length) throw new Error("No files to push");

    const writes = files.map((f: { path: string; content: string }) => ({
      path: f.path,
      content: f.content,
    }));
    const commit = await commitFiles(
      conn.repo_owner,
      conn.repo_name,
      conn.default_branch,
      data.message,
      writes,
    );

    await context.supabase
      .from("github_connections")
      .update({ last_sha: commit.sha })
      .eq("project_id", data.projectId);

    return { sha: commit.sha, pushed: writes.length };
  });

export const pullLatest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const { getBranch, getTree, getBlob, decodeBlob } = await import("./github.server");
    const { indexFile } = await import("./project-index.server");
    const { data: conn } = await context.supabase
      .from("github_connections")
      .select("repo_owner, repo_name, default_branch, last_sha")
      .eq("project_id", data.projectId)
      .maybeSingle();
    if (!conn) throw new Error("No GitHub repo connected to this project");

    const head = await getBranch(conn.repo_owner, conn.repo_name, conn.default_branch);
    if (head.commit.sha === conn.last_sha) {
      return { updated: 0, sha: head.commit.sha, upToDate: true };
    }
    const tree = await getTree(conn.repo_owner, conn.repo_name, head.commit.sha);
    const blobs = tree.tree.filter((e) => e.type === "blob" && !skip(e.path));

    let updated = 0;
    const CONC = 8;
    for (let i = 0; i < blobs.length; i += CONC) {
      const slice = blobs.slice(i, i + CONC);
      await Promise.all(
        slice.map(async (b) => {
          try {
            const blob = await getBlob(conn.repo_owner, conn.repo_name, b.sha);
            const content = decodeBlob(blob);
            if (content === null) return;
            await context.supabase.from("files").upsert(
              {
                project_id: data.projectId,
                user_id: context.userId,
                path: b.path,
                content,
                language: langFromPath(b.path),
                is_folder: false,
              },
              { onConflict: "project_id,path" },
            );
            await indexFile(context.supabase, {
              projectId: data.projectId,
              userId: context.userId,
              path: b.path,
              content,
            });
            updated++;
          } catch (e) {
            console.error(`[github pull] ${b.path}`, e);
          }
        }),
      );
    }

    await context.supabase
      .from("github_connections")
      .update({ last_sha: head.commit.sha })
      .eq("project_id", data.projectId);

    return { updated, sha: head.commit.sha, upToDate: false };
  });
