import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Project Index — lightweight per-file symbol / metadata cache.
 *
 * Stored in `project_index`. Populated on demand (first agent turn) and
 * incrementally kept in sync as the agent mutates files. The goal is to
 * let the Agent Engine locate relevant files WITHOUT re-reading every
 * file in the project on every turn.
 *
 * Extraction is deliberately regex-based (Cloudflare Workers safe, fast,
 * no TS AST dependency). It captures a useful subset of symbols; it is
 * not a full parser.
 */

export type IndexedSymbols = {
  functions: string[];
  classes: string[];
  interfaces: string[];
  types: string[];
  imports: string[];
  exports: string[];
  routes: string[];
  api_endpoints: string[];
  db_tables: string[];
  env_vars: string[];
};

export type IndexRow = IndexedSymbols & {
  path: string;
  kind: "file" | "folder";
  language: string | null;
  size: number;
};

const CAP = 200; // hard cap per array

const uniqCap = (arr: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (!v) continue;
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= CAP) break;
  }
  return out;
};

const langFromPath = (p: string): string | null => {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return (
    { py: "python", js: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript", html: "html", css: "css", json: "json", md: "markdown", sql: "sql" }[ext] ??
    null
  );
};

const collect = (src: string, re: RegExp, group = 1): string[] => {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[group]) out.push(m[group]);
  }
  return out;
};

export function extractSymbols(path: string, content: string): IndexedSymbols {
  const lang = langFromPath(path);
  const empty: IndexedSymbols = {
    functions: [],
    classes: [],
    interfaces: [],
    types: [],
    imports: [],
    exports: [],
    routes: [],
    api_endpoints: [],
    db_tables: [],
    env_vars: [],
  };

  // env vars & db tables are worth extracting for any text-y file
  const env_vars = uniqCap([
    ...collect(content, /process\.env\.([A-Z0-9_]+)/g),
    ...collect(content, /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g),
  ]);
  const db_tables_from_client = collect(
    content,
    /\.from\(\s*["'`]([\w.]+)["'`]\s*\)/g,
  );

  if (lang === "sql") {
    return {
      ...empty,
      env_vars,
      db_tables: uniqCap([
        ...collect(content, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([\w.]+)/gi),
        ...db_tables_from_client,
      ]),
    };
  }

  if (lang === "typescript" || lang === "javascript") {
    const functions = uniqCap([
      ...collect(content, /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g),
      ...collect(content, /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s*)?\(/g),
      ...collect(content, /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/g),
    ]);
    const classes = uniqCap(collect(content, /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g));
    const interfaces = uniqCap(collect(content, /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g));
    const types = uniqCap(collect(content, /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/g));
    const imports = uniqCap(collect(content, /import\s+[^"']*["']([^"']+)["']/g));
    const exports = uniqCap([
      ...collect(content, /export\s+(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g),
      ...collect(content, /export\s*\{\s*([^}]+)\s*\}/g).flatMap((s) =>
        s.split(",").map((v) => v.split(" as ")[0].trim()),
      ),
    ]);
    const routes = uniqCap(collect(content, /createFileRoute\(\s*["']([^"']+)["']/g));
    // api endpoints: infer from the file path itself
    const api_endpoints: string[] = [];
    if (path.startsWith("src/routes/api/")) {
      const clean = path
        .replace(/^src\/routes\/api\//, "/api/")
        .replace(/\.(t|j)sx?$/, "")
        .replace(/\/index$/, "/");
      api_endpoints.push(clean);
    }

    return {
      functions,
      classes,
      interfaces,
      types,
      imports,
      exports,
      routes,
      api_endpoints,
      db_tables: uniqCap(db_tables_from_client),
      env_vars,
    };
  }

  return { ...empty, env_vars, db_tables: uniqCap(db_tables_from_client) };
}

const hashString = (s: string): string => {
  // Tiny non-crypto hash; only used to detect "no change" during reindex.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36);
};

type UpsertRow = IndexedSymbols & {
  project_id: string;
  user_id: string;
  path: string;
  kind: "file" | "folder";
  language: string | null;
  size: number;
  symbols_hash: string;
};

/** Upsert a single file's row. Safe to call on every write. */
export async function indexFile(
  supabase: SupabaseClient,
  opts: { projectId: string; userId: string; path: string; content: string; isFolder?: boolean },
): Promise<void> {
  const { projectId, userId, path, content, isFolder } = opts;
  if (isFolder) {
    await supabase
      .from("project_index")
      .upsert(
        {
          project_id: projectId,
          user_id: userId,
          path,
          kind: "folder",
          language: null,
          size: 0,
          symbols_hash: "",
        },
        { onConflict: "project_id,path" },
      );
    return;
  }
  const syms = extractSymbols(path, content);
  const row: UpsertRow = {
    project_id: projectId,
    user_id: userId,
    path,
    kind: "file",
    language: langFromPath(path),
    size: content.length,
    symbols_hash: hashString(content),
    ...syms,
  };
  await supabase.from("project_index").upsert(row, { onConflict: "project_id,path" });
}

export async function removeFromIndex(
  supabase: SupabaseClient,
  projectId: string,
  path: string,
): Promise<void> {
  await supabase.from("project_index").delete().eq("project_id", projectId).eq("path", path);
}

export async function removePrefixFromIndex(
  supabase: SupabaseClient,
  projectId: string,
  prefix: string,
): Promise<void> {
  const p = prefix.replace(/\/+$/, "");
  await supabase.from("project_index").delete().eq("project_id", projectId).eq("path", p);
  await supabase
    .from("project_index")
    .delete()
    .eq("project_id", projectId)
    .like("path", `${p.replace(/[\\%_]/g, (m) => `\\${m}`)}/%`);
}

/** Move a path (or prefix) in the index. */
export async function renameInIndex(
  supabase: SupabaseClient,
  projectId: string,
  from: string,
  to: string,
): Promise<void> {
  const f = from.replace(/\/+$/, "");
  const t = to.replace(/\/+$/, "");
  const { data } = await supabase
    .from("project_index")
    .select("id, path")
    .eq("project_id", projectId)
    .or(`path.eq.${f},path.like.${f.replace(/[\\%_]/g, (m) => `\\${m}`)}/%`);
  for (const row of data ?? []) {
    const np = row.path === f ? t : t + row.path.slice(f.length);
    await supabase.from("project_index").update({ path: np }).eq("id", row.id);
  }
}

/**
 * Full rebuild — reads every file row for the project and re-derives the
 * index. Only runs when the index is empty or explicitly requested.
 */
export async function indexProject(
  supabase: SupabaseClient,
  opts: { projectId: string; userId: string },
): Promise<{ indexed: number }> {
  const { projectId, userId } = opts;
  const { data: files } = await supabase
    .from("files")
    .select("path, content, is_folder")
    .eq("project_id", projectId);
  const rows = files ?? [];
  if (!rows.length) return { indexed: 0 };

  const upsertRows: UpsertRow[] = rows.map((f: { path: string; content: string; is_folder: boolean }) => {
    if (f.is_folder) {
      return {
        project_id: projectId,
        user_id: userId,
        path: f.path,
        kind: "folder" as const,
        language: null,
        size: 0,
        symbols_hash: "",
        functions: [],
        classes: [],
        interfaces: [],
        types: [],
        imports: [],
        exports: [],
        routes: [],
        api_endpoints: [],
        db_tables: [],
        env_vars: [],
      };
    }
    const syms = extractSymbols(f.path, f.content);
    return {
      project_id: projectId,
      user_id: userId,
      path: f.path,
      kind: "file" as const,
      language: langFromPath(f.path),
      size: f.content.length,
      symbols_hash: hashString(f.content),
      ...syms,
    };
  });

  // Batch upsert in chunks of 100
  for (let i = 0; i < upsertRows.length; i += 100) {
    await supabase
      .from("project_index")
      .upsert(upsertRows.slice(i, i + 100), { onConflict: "project_id,path" });
  }
  return { indexed: upsertRows.length };
}

export type IndexSearchHit = {
  path: string;
  language: string | null;
  functions: string[];
  classes: string[];
  exports: string[];
  routes: string[];
  api_endpoints: string[];
  db_tables: string[];
};

/**
 * Search the index. When `symbol` is provided, matches any file whose
 * functions / classes / exports / routes / api_endpoints / db_tables
 * arrays contain that symbol. When `query` is provided, matches on path
 * substring OR against symbol arrays (best-effort ILIKE).
 */
export async function searchIndex(
  supabase: SupabaseClient,
  opts: { projectId: string; query?: string; symbol?: string; limit?: number },
): Promise<IndexSearchHit[]> {
  const { projectId, query, symbol } = opts;
  const limit = Math.min(opts.limit ?? 25, 50);
  let q = supabase
    .from("project_index")
    .select("path, language, functions, classes, exports, routes, api_endpoints, db_tables")
    .eq("project_id", projectId)
    .eq("kind", "file")
    .limit(limit);

  if (symbol) {
    const s = symbol.trim();
    // Use contains on each array field via `or`.
    q = q.or(
      [
        `functions.cs.{${s}}`,
        `classes.cs.{${s}}`,
        `exports.cs.{${s}}`,
        `routes.cs.{${s}}`,
        `api_endpoints.cs.{${s}}`,
        `db_tables.cs.{${s}}`,
      ].join(","),
    );
  } else if (query) {
    q = q.ilike("path", `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }

  const { data } = await q;
  return (data ?? []) as IndexSearchHit[];
}

export async function isIndexEmpty(
  supabase: SupabaseClient,
  projectId: string,
): Promise<boolean> {
  const { count } = await supabase
    .from("project_index")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  return !count;
}
