"use client";

// ============================================================================
// M15u: FUNCTIONS PAGE — editor + runner + badge schedule/triggers
//
// Layout:
//  - Daftar function: nama, badge (cron / trigger / callable),
//    toggle enabled, Run, Edit, Delete
//  - Modal editor: name (saat baru), code (textarea mono), timeout,
//    schedule (cron), triggers (collection + actions checkboxes)
//  - Run panel inline: body JSON input → result + logs
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  listFunctions,
  createFunction,
  updateFunction,
  deleteFunction,
  executeFunction,
  listCollectionsForFunctions,
  type StoredFunction,
  type FunctionTrigger,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { FunctionEditor } from "@/components/studio/FunctionEditor";
import { FunctionLogs } from "@/components/studio/FunctionLogs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import { useToasts, ToastHost } from "@/components/ui/toast";
import {
  Clock,
  GitFork,
  Play,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Plus,
  Globe,
  Database,
  Package,
  History,
  KeyRound,
  type LucideIcon,
} from "lucide-react";

const DEFAULT_CODE = `// req = { body, query, auth } for callable functions
// any return value → JSON response
return { hello: "world", from: req.auth?.email ?? "anon" };`;

export default function FunctionsPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [functions, setFunctions] = useState<StoredFunction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // editor state
  const [editing, setEditing] = useState<StoredFunction | null>(null); // existing
  const [creating, setCreating] = useState(false);
  const [collectionNames, setCollectionNames] = useState<string[]>([]);

  // run panel — per-function body agar tidak nyangkut antar function
  const [running, setRunning] = useState<string | null>(null); // nama function
  const [runBodies, setRunBodies] = useState<Record<string, string>>({});
  const [runResult, setRunResult] = useState<{ ok: boolean; result?: unknown; error?: string; logs: string[]; durationMs: number; timedOut?: boolean } | null>(null);
  const [executing, setExecuting] = useState(false);

  // panel detail (history/secrets) per function
  const [detailOpen, setDetailOpen] = useState<string | null>(null);

  // konfirmasi delete (menggantikan confirm() native)
  const [confirmDeleteFn, setConfirmDeleteFn] = useState<StoredFunction | null>(null);

  // toast (menggantikan notice statis)
  const { toasts, success: toastSuccess, error: toastError, dismiss } = useToasts();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [fns, cols] = await Promise.all([listFunctions(projectId), listCollectionsForFunctions(projectId)]);
      setFunctions(fns);
      setCollectionNames(cols.map((c) => c.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load functions");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleToggle(fn: StoredFunction) {
    setError("");
    try {
      await updateFunction(projectId, fn.name, { enabled: !fn.enabled });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update status");
    }
  }

  async function handleDelete(fn: StoredFunction) {
    setError("");
    try {
      await deleteFunction(projectId, fn.name);
      toastSuccess(`Function '${fn.name}' deleted.`);
      setConfirmDeleteFn(null);
      if (running === fn.name) {
        setRunning(null);
        setRunResult(null);
      }
      if (detailOpen === fn.name) setDetailOpen(null);
      load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to delete";
      toastError(msg);
      setError(msg);
    }
  }

  async function handleRun(fn: StoredFunction) {
    setError("");
    setRunning(fn.name);
    setRunResult(null);
    setExecuting(true);
    try {
      let body: unknown = {};
      try {
        body = JSON.parse((runBodies[fn.name] ?? "{}") || "{}");
      } catch {
        throw new Error("Invalid JSON body");
      }
      const result = await executeFunction(projectId, fn.name, body);
      setRunResult(result);
    } catch (e) {
      setRunResult({ ok: false, error: e instanceof Error ? e.message : "Execution failed", logs: [], durationMs: 0 });
    } finally {
      setExecuting(false);
    }
  }

  function badges(fn: StoredFunction) {
    const items: { icon: LucideIcon; label: string }[] = [];
    if (fn.schedule) items.push({ icon: Clock, label: fn.schedule });
    for (const t of fn.triggers) {
      items.push({ icon: GitFork, label: `${t.collection}:${t.actions.join("/")}` });
    }
    if (items.length === 0) items.push({ icon: Play, label: "callable" });
    return items;
  }

  function extraBadges(fn: StoredFunction) {
    const items: { icon: LucideIcon; label: string; title: string }[] = [];
    if (fn.schedule && fn.timezone && fn.timezone !== "UTC") {
      items.push({ icon: Clock, label: fn.timezone, title: `Schedule timezone: ${fn.timezone}` });
    }
    if (fn.dbAccess) {
      items.push({ icon: Database, label: "$db", title: "In-process database access enabled (admin-level)" });
    }
    if (fn.modules && fn.modules.length > 0) {
      items.push({ icon: Package, label: `$lib×${fn.modules.length}`, title: `Modules: ${fn.modules.join(", ")}` });
    }
    return items;
  }

  return (
    <>
      <Navbar projectId={projectId} />

      <div className="max-w-[1180px] mx-auto px-6 py-6 flex gap-6 items-start">
        {/* ─── PROJECT SIDEBAR ─── */}
        <ProjectSidebar projectId={projectId} />

        {/* ─── MAIN CONTENT ─── */}
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-center flex-wrap gap-2">
            <h2 className="text-2xl font-semibold tracking-tight">
              Functions <span className="text-muted-foreground text-base font-normal">({functions.length})</span>
            </h2>
            <Button
              onClick={() => {
                setCreating(true);
                setEditing(null);
              }}
              className="gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Function</span>
            </Button>
          </div>

          <p className="text-sm text-muted-foreground mt-1">
            Code runs in a sandbox: no <code>process</code>/<code>require</code>, enforced timeouts, captured console output.
          </p>

          {error && (
            <Card className="p-3 mt-3 border-destructive/50 bg-destructive/10 text-destructive text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </Card>
          )}

          {confirmDeleteFn && (
            <ConfirmDelete
              title={`Delete function '${confirmDeleteFn.name}'?`}
              description={
                confirmDeleteFn.triggers.length > 0 || confirmDeleteFn.schedule
                  ? "This function runs automatically (triggers/schedule). Deleting it stops all of those executions. Its secrets and execution history are also removed."
                  : "The function, its secrets, and its execution history will be permanently deleted."
              }
              confirmLabel="Delete Function"
              onConfirm={() => handleDelete(confirmDeleteFn)}
              onCancel={() => setConfirmDeleteFn(null)}
            />
          )}

      {/* Daftar functions */}
      <Card className="p-4 mt-4">
        {loading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : functions.length === 0 ? (
          <p className="text-muted-foreground">
            No functions yet. Click <strong>+ New Function</strong> to create your first one.
          </p>
        ) : (
          functions.map((fn) => (
            <div
              key={fn.id}
              className="py-3 border-b border-border flex flex-col gap-1.5 last:border-0"
            >
              <div className="flex items-center gap-2.5 flex-wrap">
                <strong className="text-sm">{fn.name}</strong>
                {badges(fn).map((b, i) => {
                  const Icon = b.icon;
                  return (
                    <Badge key={i} variant="secondary" className="text-xs gap-1">
                      <Icon className="w-3 h-3" />
                      <span>{b.label}</span>
                    </Badge>
                  );
                })}
                {extraBadges(fn).map((b, i) => {
                  const Icon = b.icon;
                  return (
                    <Badge key={`x${i}`} variant="purple" className="text-xs gap-1" title={b.title}>
                      <Icon className="w-3 h-3" />
                      <span>{b.label}</span>
                    </Badge>
                  );
                })}
                {fn.httpAllow.length > 0 && (
                  <Badge variant="blue" className="text-xs gap-1" title={`$http allowed: ${fn.httpAllow.join(", ")}`}>
                    <Globe className="w-3 h-3" />
                    <span>$http</span>
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground font-mono">
                  {fn.timeoutMs}ms · {fn.memoryMb}MB
                </span>
                <span className="flex-1" />
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <Checkbox
                    checked={fn.enabled}
                    onCheckedChange={() => handleToggle(fn)}
                  />
                  {fn.enabled ? "active" : "disabled"}
                </label>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setDetailOpen(detailOpen === fn.name ? null : fn.name)}
                  className="gap-1"
                  title="Execution history & secrets"
                >
                  {detailOpen === fn.name ? <KeyRound className="w-3 h-3" /> : <History className="w-3 h-3" />}
                  <span>{detailOpen === fn.name ? "Hide Details" : "Details"}</span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleRun(fn)}
                  disabled={executing}
                  className="gap-1"
                >
                  <Play className="w-3 h-3 fill-current" />
                  <span>Run</span>
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(fn);
                    setCreating(false);
                    setRunning(null);
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmDeleteFn(fn)}
                >
                  Delete
                </Button>
              </div>

              {/* Detail panel: execution history + secrets */}
              {detailOpen === fn.name && (
                <FunctionLogs projectId={projectId} functionName={fn.name} />
              )}

              {/* Run panel */}
              {running === fn.name && (
                <div className="bg-muted rounded-lg p-3 mt-2">
                  <Label className="text-xs">req.body (JSON)</Label>
                  <Textarea
                    rows={2}
                    value={runBodies[fn.name] ?? "{}"}
                    onChange={(e) =>
                      setRunBodies((prev) => ({ ...prev, [fn.name]: e.target.value }))
                    }
                    className="font-mono text-sm mt-1"
                  />
                  <div className="flex gap-2 mt-2">
                    <Button size="sm" onClick={() => handleRun(fn)} disabled={executing} className="gap-1">
                      <Play className="w-3 h-3 fill-current" />
                      <span>{executing ? "Running…" : "Run"}</span>
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => { setRunning(null); setRunResult(null); }}>
                      Close
                    </Button>
                  </div>
                  {runResult && (
                    <div className="mt-3 text-sm">
                      <div className="flex items-center gap-2">
                        {runResult.ok ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <XCircle className="w-4 h-4 text-destructive" />
                        )}
                        <strong className="font-mono">{runResult.durationMs}ms</strong>
                        {runResult.timedOut && (
                          <Badge variant="destructive" className="gap-1 text-xs">
                            <Clock className="w-3 h-3" />
                            <span>timeout</span>
                          </Badge>
                        )}
                      </div>
                      {runResult.error && (
                        <div className="text-destructive mt-1">{runResult.error}</div>
                      )}
                      {runResult.result !== undefined && runResult.result !== null && (
                        <pre className="bg-card p-2 rounded mt-2 overflow-x-auto text-xs">
                          {JSON.stringify(runResult.result, null, 2)}
                        </pre>
                      )}
                      {runResult.logs.length > 0 && (
                        <details className="mt-2">
                          <summary className="text-muted-foreground cursor-pointer text-xs">
                            console ({runResult.logs.length})
                          </summary>
                          <pre className="bg-card p-2 rounded mt-1 overflow-x-auto text-xs">
                            {runResult.logs.join("\n")}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </Card>

      {/* Editor modal */}
      {(creating || editing) && (
        <FunctionEditor
          projectId={projectId}
          existing={editing}
          collectionNames={collectionNames}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            toastSuccess("Function saved");
            load();
          }}
        />
      )}

      {/* Toast notifications (global) */}
      <ToastHost toasts={toasts} onDismiss={dismiss} />
        </div>
      </div>
    </>
  );
}

// ─── Editor modal (create & edit) ────────────────────────────────────────────

// ─── END OF PAGE ───