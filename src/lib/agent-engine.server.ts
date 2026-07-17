/**
 * Agent Engine — pure, testable stage functions for the CodeMind agent.
 *
 * The stages in the pipeline are:
 *   1. receive    (handled inline in the chat route: persist user msg)
 *   2. understand → understandRequest()
 *   3. locate     → locateFiles()
 *   4. read       (executed by the streaming agent, no pure helper needed)
 *   5. plan       → createPlan()
 *   6. apply      (executed by tool calls inside streamText)
 *   7. verify     → verifyPatches()
 *   8. save       → applyRollback() if verify failed
 *
 * Each function is deliberately small, side-effect free (except for the DB
 * calls in locate/rollback), and exported individually so unit tests can
 * drive each stage in isolation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText, NoObjectGeneratedError, type LanguageModel } from "ai";
import { z } from "zod";
import { searchIndex, type IndexSearchHit } from "@/lib/project-index.server";

// ---------- Understanding ------------------------------------------------

export const UnderstandingSchema = z.object({
  goal: z.string(),
  taskType: z.string(),
  keywords: z.array(z.string()),
});
export type Understanding = z.infer<typeof UnderstandingSchema>;

export async function understandRequest(
  model: LanguageModel,
  userText: string,
): Promise<Understanding> {
  const fallback: Understanding = {
    goal: userText.slice(0, 200),
    taskType: "unknown",
    keywords: [],
  };
  if (!userText.trim()) return fallback;
  try {
    const { text } = await generateText({
      model,
      prompt: `Return ONLY a compact JSON object matching {"goal": string, "taskType": one of ("fix" | "feature" | "refactor" | "explain" | "review" | "other"), "keywords": string[]} describing this developer request. keywords are file names, function names, or module names likely to be involved (max 8, no filler words). Mirror the user's language for goal/taskType text.\n\nRequest:\n${userText}`,
    });
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    return UnderstandingSchema.parse(JSON.parse(jsonMatch[0]));
  } catch (e) {
    if (!NoObjectGeneratedError.isInstance(e)) console.error("understand stage failed", e);
    return fallback;
  }
}

// ---------- Locate -------------------------------------------------------

export type LocatedFile = {
  path: string;
  functions: string[];
  classes: string[];
  exports: string[];
};

export async function locateFiles(
  supabase: SupabaseClient,
  projectId: string,
  keywords: string[],
  limitPerKeyword = 10,
  maxTotal = 15,
): Promise<LocatedFile[]> {
  const seen = new Map<string, LocatedFile>();
  for (const kw of keywords.slice(0, 6)) {
    if (!kw.trim()) continue;
    let hits: IndexSearchHit[] = [];
    try {
      const [bySymbol, byPath] = await Promise.all([
        searchIndex(supabase, { projectId, symbol: kw, limit: limitPerKeyword }),
        searchIndex(supabase, { projectId, query: kw, limit: limitPerKeyword }),
      ]);
      hits = [...bySymbol, ...byPath];
    } catch (e) {
      console.error("locate stage: searchIndex failed", e);
    }
    for (const h of hits) {
      if (seen.has(h.path)) continue;
      seen.set(h.path, {
        path: h.path,
        functions: h.functions.slice(0, 8),
        classes: h.classes.slice(0, 8),
        exports: h.exports.slice(0, 8),
      });
      if (seen.size >= maxTotal) return Array.from(seen.values());
    }
  }
  return Array.from(seen.values());
}

export function formatLocatedBlock(files: LocatedFile[]): string {
  if (!files.length) return "  (index returned no candidates — use list_files / grep if needed)";
  return files
    .map((s) => {
      const bits = [
        s.functions.length ? `functions: ${s.functions.join(", ")}` : "",
        s.classes.length ? `classes: ${s.classes.join(", ")}` : "",
        s.exports.length ? `exports: ${s.exports.join(", ")}` : "",
      ].filter(Boolean);
      return `  - ${s.path}${bits.length ? ` (${bits.join("; ")})` : ""}`;
    })
    .join("\n");
}

// ---------- Plan ---------------------------------------------------------

export async function createPlan(
  model: LanguageModel,
  args: { userText: string; understanding: Understanding; locatedBlock: string },
): Promise<string> {
  try {
    const { text } = await generateText({
      model,
      prompt: `You are drafting a short internal execution plan for another AI agent that will make the actual code changes next.

Request:
${args.userText || "(empty)"}

Understood as: ${args.understanding.taskType} — ${args.understanding.goal}
Candidate files (from Project Index):
${args.locatedBlock}

Write a compact plan with:
1. Files to edit (or "none")
2. Ordered steps (numbered, one line each, max 5 steps)
3. Risks / things to double-check (max 3 bullets)

Do NOT include code. Keep the whole plan under 200 words. Mirror the user's language.`,
    });
    return text.trim().slice(0, 3000);
  } catch (e) {
    console.error("plan stage failed", e);
    return "";
  }
}

// ---------- Verify -------------------------------------------------------

export type VerifyIssue = { path: string; kind: "json" | "brackets" | "size"; message: string };
export type VerifyResult = { ok: boolean; issues: VerifyIssue[]; checked: number };

/**
 * Lightweight structural verification for content the agent wrote in a turn.
 * Runs inside the Cloudflare Worker — no external toolchain — so it is
 * intentionally conservative:
 *
 *   - JSON files must parse.
 *   - TS/TSX/JS/JSX/CSS files must have balanced brackets/braces/parens
 *     (ignoring the interior of strings and comments).
 *   - Non-empty writes must not have collapsed to whitespace-only content.
 *
 * A negative result is a strong hint the patch corrupted the file; the
 * caller (chat route) uses it to trigger the automatic rollback path.
 */
export function verifyPatches(
  files: Array<{ path: string; content: string }>,
): VerifyResult {
  const issues: VerifyIssue[] = [];
  for (const f of files) {
    if (f.content.length > 0 && f.content.trim().length === 0) {
      issues.push({ path: f.path, kind: "size", message: "File collapsed to whitespace" });
      continue;
    }
    const ext = f.path.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "json") {
      try {
        JSON.parse(f.content);
      } catch (e) {
        issues.push({
          path: f.path,
          kind: "json",
          message: `Invalid JSON: ${(e as Error).message}`,
        });
      }
      continue;
    }
    if (["ts", "tsx", "js", "jsx", "css", "scss"].includes(ext)) {
      const bracketErr = checkBrackets(f.content);
      if (bracketErr) {
        issues.push({ path: f.path, kind: "brackets", message: bracketErr });
      }
    }
  }
  return { ok: issues.length === 0, issues, checked: files.length };
}

/** Balanced-brackets pass that skips string/comment/regex-ish interiors. */
export function checkBrackets(src: string): string | null {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    // Line comment
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Strings: ", ', `
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          // template expression — recurse until matching '}'
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            i++;
          }
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push(c);
    } else if (c === ")" || c === "]" || c === "}") {
      const expected = pairs[c];
      const top = stack.pop();
      if (top !== expected) {
        return `Unbalanced '${c}' near offset ${i} (expected match for '${top ?? "?"}')`;
      }
    }
    i++;
  }
  if (stack.length > 0) {
    return `Unclosed '${stack[stack.length - 1]}' — ${stack.length} open bracket(s) at EOF`;
  }
  return null;
}

// ---------- Rollback -----------------------------------------------------

export type SnapshotLike = {
  path: string;
  prior_content: string | null;
  prior_existed: boolean;
  action: string;
};

/**
 * Restores every path in `snapshots` to its pre-turn state. Used when the
 * verify stage reports issues, or when the caller decides to abort a turn.
 * Runs the reverse of the mutations tracked during the streamed apply
 * stage.
 */
export async function applyRollback(
  supabase: SupabaseClient,
  opts: { projectId: string; userId: string; snapshots: SnapshotLike[] },
): Promise<{ restored: number }> {
  const { projectId, userId, snapshots } = opts;
  // Rollback in reverse order so intermediate states unwind cleanly.
  const ordered = [...snapshots].reverse();
  const seen = new Set<string>();
  let restored = 0;
  for (const s of ordered) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    if (!s.prior_existed) {
      await supabase.from("files").delete().eq("project_id", projectId).eq("path", s.path);
      restored++;
      continue;
    }
    const { data: existing } = await supabase
      .from("files")
      .select("id")
      .eq("project_id", projectId)
      .eq("path", s.path)
      .maybeSingle();
    if (existing) {
      await supabase
        .from("files")
        .update({ content: s.prior_content ?? "" })
        .eq("id", existing.id);
    } else {
      const ext = s.path.split(".").pop()?.toLowerCase() ?? "";
      const language =
        { py: "python", js: "javascript", ts: "typescript", tsx: "typescript", jsx: "javascript", html: "html", css: "css", json: "json", md: "markdown" }[ext] ?? "plaintext";
      await supabase.from("files").insert({
        project_id: projectId,
        user_id: userId,
        path: s.path,
        content: s.prior_content ?? "",
        language,
        is_folder: false,
      });
    }
    restored++;
  }
  return { restored };
}
