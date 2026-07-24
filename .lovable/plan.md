# خطة التنفيذ الشاملة — CodeMind v2

3 دفعات متسلسلة. كل دفعة قابلة للاختبار مستقلة قبل ما ننتقل للي بعدها.

---

## الدفعة 1 — GitHub Integration (bidirectional)

### قاعدة البيانات
- migration: `github_connections` (user_id, project_id, repo_owner, repo_name, default_branch, last_sha, sync_mode) + RLS + GRANT.

### Server functions (`src/lib/github.functions.ts` + `.server.ts`)
- `listUserRepos()` — يقرأ قائمة ريبوهات المستخدم عبر App User Connector (OAuth).
- `importRepo({ owner, repo, branch })` — يسحب tree كامل عبر GitHub API، يعبّي `files` table، يعمل full re-index.
- `pushChanges({ message, files? })` — يعمل commit + push للتغييرات المحلية عبر Git Data API (create tree/commit/update ref).
- `pullLatest()` — يجيب آخر changes من الريبو ويدمج.
- Fallback: workspace App connector للـ background sync.

### Agent tools جديدة في `src/routes/api/chat.ts`
- `github_list_repos`, `github_import`, `github_commit_push`, `github_read_file` (يقرأ من ريبو خارجي كمرجع بدون كتابة).

### UI
- Dialog جديد `GitHubDialog.tsx` في الـ workspace: زر "Connect GitHub" → list repos → import.
- Badge في header يوضح الريبو المربوط والفرع.

---

## الدفعة 2 — Task Cards + Self-Review UI

### Chat rendering
- كارت task جديد للـ tool calls في `ChatPanel.tsx`:
  - رأس: اسم الأداة + status (thinking/running/success/error) + مدة
  - جسم قابل للطي: الـ input + الـ output
  - عند خطأ: retry button + سبب الفشل
- Stage indicator يعرض المراحل (Understand → Locate → Plan → Apply → Verify) مع progress.

### Agent behavior
- عند فشل `verify`: يعرض تلقائياً "detected issues، retrying with fix..." ويعيد المحاولة مرة واحدة قبل rollback نهائي.
- ذاكرة طويلة الأمد: تلخيص محادثات قديمة في `project_memory` تلقائياً كل 20 رسالة (RAG lite على المفاتيح المهمة).

### Design polish
- toolkit UI جديد: أيقونات lucide لكل tool، لون status ثابت (thinking=blue, running=amber, success=green, error=red).
- شريط "Agent is thinking..." متحرك مع الـ stage الحالية.

---

## الدفعة 3 — Testing sandbox + Vision + Libraries

### Testing
- Agent tool: `run_tests` يشغّل vitest داخل edge (subset compatible tests فقط — الاختبارات النقية بدون DOM).
- Agent tool: `run_typecheck` يشغّل tsgo على الملفات المتأثرة.
- Agent tool: `run_lint` (eslint).

### Vision
- `ChatComposer.tsx`: زر رفع صورة + preview.
- تخزين في Supabase Storage bucket `chat-attachments`.
- الرسالة تُرسل مع image parts للنموذج (google/gemini يدعم vision).

### Libraries (تُثبَّت جاهزة، الوكيل يقررها)
- `@monaco-editor/react` (already) + language workers لـ python/rust/go/java.
- `react-syntax-highlighter` مع theme داكن للـ code blocks في الشات.
- `prism-themes` للألوان.
- `mermaid` للـ diagrams.

---

## Files & code volume expected
- الدفعة 1: ~7 ملفات جديدة، ~4 تعديلات، migration واحد.
- الدفعة 2: ~3 مكونات جديدة، تعديل chat.ts و ChatPanel.tsx.
- الدفعة 3: ~3 tools جديدة، composer update، storage bucket.

سأشتغل بأفضل ممارسة: ملفات صغيرة مركّزة، لا rewrite لأي ملف، tests لكل helper جديد.

---

## هل نمشي بالخطة؟
أرد بـ "نعم ابدأ" وأبدأ بالدفعة 1 (GitHub) فوراً، وبعد ما تنجح، أنتقل للـ 2 ثم 3.