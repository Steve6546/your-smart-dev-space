import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Github, Download, Upload, Link2, Unlink, RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  listUserRepos, getConnection, saveConnection, deleteConnection,
  importRepo, pushChanges, pullLatest,
} from "@/lib/github.functions";

/**
 * GitHub sync dialog. Two panes:
 *   - Connection: shows currently linked repo + Pull / Disconnect controls.
 *   - Repos:      lists workspace-visible repos and lets the user import one.
 * The workspace GitHub connector supplies the token; there is no per-user
 * OAuth flow here.
 */
export function GitHubDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="GitHub sync">
          <Github className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Github className="h-5 w-5" /> GitHub Sync
          </DialogTitle>
          <DialogDescription>
            Import a repository into this project, then push your changes back with a commit.
          </DialogDescription>
        </DialogHeader>
        <GitHubBody projectId={projectId} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function GitHubBody({ projectId, onClose: _onClose }: { projectId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const listReposFn = useServerFn(listUserRepos);
  const getConnFn = useServerFn(getConnection);
  const saveConnFn = useServerFn(saveConnection);
  const delConnFn = useServerFn(deleteConnection);
  const importFn = useServerFn(importRepo);
  const pushFn = useServerFn(pushChanges);
  const pullFn = useServerFn(pullLatest);

  const conn = useQuery({
    queryKey: ["github-conn", projectId],
    queryFn: () => getConnFn({ data: { projectId } }),
  });
  const repos = useQuery({
    queryKey: ["github-repos"],
    queryFn: () => listReposFn(),
  });

  const [commitMsg, setCommitMsg] = useState("Update from CodeMind");

  const importMut = useMutation({
    mutationFn: (v: { owner: string; repo: string; branch: string }) =>
      importFn({ data: { projectId, ...v, clear: false } }),
    onSuccess: (r) => {
      toast.success(`Imported ${r.imported} files${r.skipped ? ` (${r.skipped} skipped)` : ""}`);
      qc.invalidateQueries({ queryKey: ["files", projectId] });
      qc.invalidateQueries({ queryKey: ["github-conn", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pushMut = useMutation({
    mutationFn: () => pushFn({ data: { projectId, message: commitMsg || "Update from CodeMind" } }),
    onSuccess: (r) => toast.success(`Pushed ${r.pushed} files — ${r.sha.slice(0, 7)}`),
    onError: (e: Error) => toast.error(e.message),
  });

  const pullMut = useMutation({
    mutationFn: () => pullFn({ data: { projectId } }),
    onSuccess: (r) => {
      toast.success(r.upToDate ? "Already up to date" : `Pulled ${r.updated} files`);
      qc.invalidateQueries({ queryKey: ["files", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const disconnectMut = useMutation({
    mutationFn: () => delConnFn({ data: { projectId } }),
    onSuccess: () => {
      toast.success("Disconnected");
      qc.invalidateQueries({ queryKey: ["github-conn", projectId] });
    },
  });

  const saveMut = useMutation({
    mutationFn: (v: { owner: string; repo: string; branch: string }) =>
      saveConnFn({ data: { projectId, ...v } }),
    onSuccess: () => {
      toast.success("Linked");
      qc.invalidateQueries({ queryKey: ["github-conn", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Current connection */}
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-semibold uppercase text-muted-foreground">Linked repository</div>
          {conn.data && (
            <Badge variant="outline" className="gap-1 text-[10px]">
              <Link2 className="h-3 w-3" /> {conn.data.repo_owner}/{conn.data.repo_name}
            </Badge>
          )}
        </div>
        {conn.data ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm">
              <span className="font-mono">{conn.data.repo_owner}/{conn.data.repo_name}</span>
              <span className="ml-1 text-muted-foreground">· {conn.data.default_branch}</span>
              {conn.data.last_sha && (
                <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                  @ {conn.data.last_sha.slice(0, 7)}
                </span>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => pullMut.mutate()} disabled={pullMut.isPending}>
                {pullMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Pull
              </Button>
              <Button size="sm" variant="ghost" onClick={() => disconnectMut.mutate()}>
                <Unlink className="h-3.5 w-3.5" /> Unlink
              </Button>
            </div>
            <div className="mt-2 flex w-full items-center gap-2">
              <Input
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                placeholder="Commit message"
                className="h-8 text-sm"
              />
              <Button size="sm" onClick={() => pushMut.mutate()} disabled={pushMut.isPending}>
                {pushMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                Push all
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No repository linked yet. Import one below.</p>
        )}
      </div>

      {/* Repo picker */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <Label className="text-xs uppercase text-muted-foreground">Your repositories</Label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => repos.refetch()}
            disabled={repos.isFetching}
          >
            {repos.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <ScrollArea className="h-64 rounded-md border border-border">
          {repos.isLoading && (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          )}
          {repos.error && (
            <div className="p-4 text-sm text-destructive">
              {(repos.error as Error).message}
            </div>
          )}
          {repos.data?.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">No repositories visible to this GitHub connection.</div>
          )}
          <ul className="divide-y divide-border">
            {(repos.data ?? []).map((r) => (
              <li key={r.full_name} className="flex items-center gap-2 p-2 hover:bg-muted/40">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.full_name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {r.private ? "private" : "public"} · {r.default_branch}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    saveMut.mutate({ owner: r.owner, repo: r.name, branch: r.default_branch })
                  }
                >
                  <Link2 className="h-3.5 w-3.5" /> Link
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    importMut.mutate({ owner: r.owner, repo: r.name, branch: r.default_branch })
                  }
                  disabled={importMut.isPending}
                >
                  {importMut.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  Import
                </Button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </div>

      <DialogFooter>
        <p className="mr-auto text-[11px] text-muted-foreground">
          Auth: workspace GitHub connector. Commits use the connection's token.
        </p>
      </DialogFooter>
    </div>
  );
}
