"use client";

// ============================================================================
// M15u: FUNCTIONS PAGE — editor + runner + badge schedule/triggers
//
// Layout:
//  - Header: Pencarian & filter jenis fungsi (all / trigger / schedule / callable)
//  - Daftar functions berstruktur 2-baris konsisten:
//      Baris 1: Nama, trigger badges, toggle active, dan action cluster stabil (Run, Logs, Edit, Delete)
//      Baris 2: Runtime capabilities ($db, $lib, $http) dan batas sumber daya terformat (30s · 64 MB)
//  - Modal editor: name, code, timeout, schedule, triggers, dbAccess, modules
//  - Panel execution history & secrets via FunctionLogs
//  - Run panel inline: body JSON input → result + logs
// ============================================================================

import { useCallback, useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import {
  listFunctions,
  updateFunction,
  deleteFunction,
  executeFunction,
  listCollectionsForFunctions,
  type StoredFunction,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { FunctionEditor } from "@/components/studio/FunctionEditor";
import { FunctionLogs } from "@/components/studio/FunctionLogs";
import { ModuleManager } from "@/components/studio/ModuleManager";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import { LoadError, errorMessage } from "@/components/ui/load-error";
import { useToasts, ToastHost } from "@/components/ui/toast";
import {
  Clock,
  GitFork,
  Play,
  CheckCircle2,
  XCircle,
  Plus,
  Globe,
  Database,
  Package,
  History,
  KeyRound,
  Loader2,
  Search,
  Pencil,
  Trash2,
  type LucideIcon,
} from "lucide-react";

/** Format timeout milidetik menjadi teks yang manusiawi (e.g. 120s, 30s, 2m) */
function formatTimeout(ms: number): string {
  if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000}m (${ms / 1000}s)`;
  if (ms >= 1000) return `${ms / 1000}s`;
  return `${ms}ms`;
}

type FunctionFilterType = "all" | "triggers" | "schedules" | "callable";

export default function FunctionsPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [functions, setFunctions] = useState<StoredFunction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<FunctionFilterType>("all");

  // editor state
  const [editing, setEditing] = useState<StoredFunction | null>(null);
  const [creating, setCreating] = useState(false);
  const [collectionNames, setCollectionNames] = useState<string[]>([]);

  // run panel — per-function body agar tidak nyangkut antar function
  const [running, setRunning] = useState<string | null>(null);
  const [runBodies, setRunBodies] = useState<Record<string, string>>({});
  const [runResult, setRunResult] = useState<{
    ok: boolean;
    result?: unknown;
    error?: string;
    logs: string[];
    durationMs: number;
    timedOut?: boolean;
  } | null>(null);
  const [executing, setExecuting] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  // panel detail (history/secrets) per function
  const [detailOpen, setDetailOpen] = useState<string | null>(null);

  // konfirmasi delete
  const [confirmDeleteFn, setConfirmDeleteFn] = useState<StoredFunction | null>(null);

  // toast
  const { toasts, success: toastSuccess, error: toastError, dismiss } = useToasts();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [fns, cols] = await Promise.all([
        listFunctions(projectId),
        listCollectionsForFunctions(projectId),
      ]);
      setFunctions(fns);
      setCollectionNames(cols.map((c) => c.name));
    } catch (e) {
      setError(errorMessage(e, "Failed to load functions"));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleToggle(fn: StoredFunction) {
    if (toggling === fn.name) return;
    setError("");
    setToggling(fn.name);
    try {
      await updateFunction(projectId, fn.name, { enabled: !fn.enabled });
      setFunctions((prev) =>
        prev.map((f) => (f.name === fn.name ? { ...f, enabled: !fn.enabled } : f))
      );
      toastSuccess(`Function '${fn.name}' ${!fn.enabled ? "activated" : "disabled"}.`);
    } catch (e) {
      toastError(errorMessage(e, "Failed to update function status"));
    } finally {
      setToggling(null);
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
      void load();
    } catch (e) {
      toastError(errorMessage(e, "Failed to delete function"));
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
      setRunResult({
        ok: false,
        error: e instanceof Error ? e.message : "Execution failed",
        logs: [],
        durationMs: 0,
      });
    } finally {
      setExecuting(false);
    }
  }

  // Filter & Search functions
  const filteredFunctions = useMemo(() => {
    return functions.filter((fn) => {
      // Type Filter
      if (filterType === "triggers" && fn.triggers.length === 0) return false;
      if (filterType === "schedules" && !fn.schedule) return false;
      if (filterType === "callable" && (fn.triggers.length > 0 || fn.schedule)) return false;

      // Search Query
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase().trim();
      const matchesName = fn.name.toLowerCase().includes(q);
      const matchesTrigger = fn.triggers.some((t) => t.collection.toLowerCase().includes(q));
      const matchesSchedule = !!fn.schedule && fn.schedule.toLowerCase().includes(q);
      const matchesModules = !!fn.modules && fn.modules.some((m) => m.toLowerCase().includes(q));
      return matchesName || matchesTrigger || matchesSchedule || matchesModules;
    });
  }, [functions, searchQuery, filterType]);

  const counts = useMemo(() => {
    return {
      all: functions.length,
      triggers: functions.filter((f) => f.triggers.length > 0).length,
      schedules: functions.filter((f) => !!f.schedule).length,
      callable: functions.filter((f) => f.triggers.length === 0 && !f.schedule).length,
    };
  }, [functions]);

  return (
    <>
      <Navbar projectId={projectId} />

      <div className="max-w-[1180px] mx-auto px-6 py-6 flex gap-6 items-start">
        {/* ─── PROJECT SIDEBAR ─── */}
        <ProjectSidebar projectId={projectId} />

        {/* ─── MAIN CONTENT ─── */}
        <div className="flex-1 min-w-0">
          {/* Header Section */}
          <div className="flex justify-between items-center flex-wrap gap-3 mb-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Serverless Functions <span className="text-muted-foreground text-base font-normal">({functions.length})</span>
              </h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                Isolated JavaScript sandbox with database triggers, cron scheduler, and $db bindings.
              </p>
            </div>
            <Button
              onClick={() => {
                setCreating(true);
                setEditing(null);
              }}
              className="gap-1.5 h-9 text-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Function</span>
            </Button>
          </div>

          {error && <LoadError message={error} onRetry={load} className="mb-4" />}

          {/* Konfirmasi Hapus Function */}
          {confirmDeleteFn && (
            <div className="mb-4">
              <ConfirmDelete
                title={`Delete function '${confirmDeleteFn.name}'?`}
                description={
                  confirmDeleteFn.triggers.length > 0 || confirmDeleteFn.schedule
                    ? "This function runs automatically (triggers/schedule). Deleting it stops all executions. Its secrets and execution history will also be deleted."
                    : "The function, its secrets, and execution logs will be permanently deleted."
                }
                confirmLabel="Delete Function"
                onConfirm={() => void handleDelete(confirmDeleteFn)}
                onCancel={() => setConfirmDeleteFn(null)}
              />
            </div>
          )}

          {/* ─── Toolbar: Search + Filter Tabs ─── */}
          <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-2.5 mb-4">
            {/* Filter Pills */}
            <div className="inline-flex items-center gap-1 rounded-lg bg-secondary/60 p-1 border border-border text-xs">
              {(["all", "triggers", "schedules", "callable"] as const).map((t) => {
                const isActive = filterType === t;
                const count = counts[t];
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setFilterType(t)}
                    className={`px-3 py-1 rounded-md capitalize font-medium transition-colors flex items-center gap-1.5 ${
                      isActive
                        ? "bg-accent text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span>{t}</span>
                    <span className="text-[10px] opacity-70 font-mono">({count})</span>
                  </button>
                );
              })}
            </div>

            {/* Search Input */}
            <div className="relative flex-1 sm:max-w-xs">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search functions…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 pr-7 text-xs"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                >
                  &times;
                </button>
              )}
            </div>
          </div>

          {/* ─── Daftar Functions (Struktur 2-Baris Konsisten) ─── */}
          {loading ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">Loading functions…</Card>
          ) : filteredFunctions.length === 0 ? (
            searchQuery.trim() || filterType !== "all" ? (
              <Card className="p-10 text-center border-dashed">
                <p className="text-sm font-semibold text-foreground mb-1">No matching functions</p>
                <p className="text-xs text-muted-foreground mb-3">
                  No functions match your search criteria.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => {
                    setSearchQuery("");
                    setFilterType("all");
                  }}
                >
                  Reset filters
                </Button>
              </Card>
            ) : (
              <Card className="p-12 text-center border-dashed">
                <p className="text-base font-semibold text-foreground mb-1">No functions created yet</p>
                <p className="text-xs text-muted-foreground max-w-sm mx-auto mb-4">
                  Write serverless JavaScript code that executes on database triggers, cron timers, or direct API calls.
                </p>
                <Button
                  size="sm"
                  className="h-8 text-xs gap-1.5"
                  onClick={() => {
                    setCreating(true);
                    setEditing(null);
                  }}
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create First Function</span>
                </Button>
              </Card>
            )
          ) : (
            <div className="space-y-3">
              {filteredFunctions.map((fn) => (
                <Card
                  key={fn.id}
                  className="p-4 flex flex-col gap-3 hover:border-foreground/20 transition-colors bg-card/60"
                >
                  {/* BARIS 1: Identitas & Action Cluster Stabil (Selalu Sejajar) */}
                  <div className="flex items-start justify-between gap-3 flex-wrap sm:flex-nowrap">
                    {/* Kiri: Nama & Trigger Badges */}
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="font-mono font-semibold text-sm text-foreground truncate" title={fn.name}>
                        {fn.name}
                      </span>

                      {/* Cron Schedule Badge */}
                      {fn.schedule && (
                        <Badge variant="secondary" className="text-[11px] font-mono gap-1 py-0 px-2 h-5">
                          <Clock className="w-3 h-3 text-muted-foreground" />
                          <span>{fn.schedule}</span>
                        </Badge>
                      )}

                      {/* Database Trigger Badges */}
                      {fn.triggers.map((t, i) => (
                        <Badge key={i} variant="secondary" className="text-[11px] font-mono gap-1 py-0 px-2 h-5">
                          <GitFork className="w-3 h-3 text-muted-foreground" />
                          <span>{t.collection}:{t.actions.join("/")}</span>
                        </Badge>
                      ))}

                      {/* Callable Badge (bila tidak ada schedule / trigger) */}
                      {fn.triggers.length === 0 && !fn.schedule && (
                        <Badge variant="secondary" className="text-[11px] font-mono gap-1 py-0 px-2 h-5">
                          <Play className="w-3 h-3 text-emerald-400" />
                          <span>callable</span>
                        </Badge>
                      )}

                      {/* Timezone Badge jika bukan UTC */}
                      {fn.schedule && fn.timezone && fn.timezone !== "UTC" && (
                        <Badge variant="outline" className="text-[10px] gap-1 py-0 px-1.5 h-5 text-muted-foreground">
                          <span>{fn.timezone}</span>
                        </Badge>
                      )}
                    </div>

                    {/* Kanan: Aksi Selalu Terkunci Rapi di Kanan (Tidak Pernah Terlempar ke Bawah) */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {/* Active Toggle Switch */}
                      <label
                        className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border bg-secondary/40 ${
                          toggling === fn.name ? "opacity-60 cursor-wait" : "cursor-pointer hover:bg-secondary"
                        }`}
                      >
                        <Checkbox
                          checked={fn.enabled}
                          disabled={toggling === fn.name}
                          onCheckedChange={() => void handleToggle(fn)}
                        />
                        {toggling === fn.name ? (
                          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                        ) : (
                          <span className={fn.enabled ? "text-foreground font-medium text-[11px]" : "text-muted-foreground text-[11px]"}>
                            {fn.enabled ? "Active" : "Disabled"}
                          </span>
                        )}
                      </label>

                      {/* Run / Execute Button */}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleRun(fn)}
                        disabled={executing}
                        className="h-7 px-2.5 text-xs gap-1"
                        title="Execute function with test payload"
                      >
                        <Play className="w-3 h-3 fill-current text-emerald-400" />
                        <span>Run</span>
                      </Button>

                      {/* Logs & Secrets Button */}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setDetailOpen(detailOpen === fn.name ? null : fn.name)}
                        className="h-7 px-2.5 text-xs gap-1"
                        title="Execution history & secrets"
                      >
                        {detailOpen === fn.name ? <KeyRound className="w-3 h-3 text-brand" /> : <History className="w-3 h-3 text-muted-foreground" />}
                        <span>{detailOpen === fn.name ? "Hide Logs" : "Logs"}</span>
                      </Button>

                      {/* Edit Button */}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setEditing(fn);
                          setCreating(false);
                          setRunning(null);
                        }}
                        className="h-7 px-2.5 text-xs gap-1"
                      >
                        <Pencil className="w-3 h-3 text-muted-foreground" />
                        <span>Edit</span>
                      </Button>

                      {/* Delete Button */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setConfirmDeleteFn(fn)}
                        title="Delete function"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>

                  {/* BARIS 2: Metadata Kapabilitas & Sumber Daya Terformat Manusiawi */}
                  <div className="flex items-center justify-between gap-3 pt-2.5 border-t border-border/60 text-xs text-muted-foreground flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Database $db capability */}
                      {fn.dbAccess && (
                        <Badge variant="purple" className="text-[10px] font-mono gap-1 py-0 px-1.5" title="In-process $db access (admin privileges)">
                          <Database className="w-3 h-3" />
                          <span>$db enabled</span>
                        </Badge>
                      )}

                      {/* Shared modules $lib capability */}
                      {fn.modules && fn.modules.length > 0 && (
                        <Badge variant="purple" className="text-[10px] font-mono gap-1 py-0 px-1.5" title={`Modules: ${fn.modules.join(", ")}`}>
                          <Package className="w-3 h-3" />
                          <span>$lib×{fn.modules.length}</span>
                        </Badge>
                      )}

                      {/* $http outbound network capability */}
                      {fn.httpAllow.length > 0 && (
                        <Badge variant="blue" className="text-[10px] font-mono gap-1 py-0 px-1.5" title={`Allowed hosts: ${fn.httpAllow.join(", ")}`}>
                          <Globe className="w-3 h-3" />
                          <span>$http</span>
                        </Badge>
                      )}
                    </div>

                    {/* Humanized Execution Limits (120000ms → 120s) */}
                    <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                      <span>Timeout: <strong className="text-foreground font-medium">{formatTimeout(fn.timeoutMs)}</strong></span>
                      <span className="text-border">·</span>
                      <span>Memory: <strong className="text-foreground font-medium">{fn.memoryMb} MB</strong></span>
                    </div>
                  </div>

                  {/* Embedded Detail Panel (Execution History & Secrets) */}
                  {detailOpen === fn.name && (
                    <div className="mt-1 pt-3 border-t border-border">
                      <FunctionLogs projectId={projectId} functionName={fn.name} />
                    </div>
                  )}

                  {/* Embedded Run Panel */}
                  {running === fn.name && (
                    <div className="bg-muted/80 border border-border rounded-lg p-3.5 mt-1">
                      <div className="flex items-center justify-between mb-1.5">
                        <Label className="text-xs font-semibold text-foreground">Execute Function: {fn.name}</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">req.body (JSON)</span>
                      </div>
                      <Textarea
                        rows={2}
                        value={runBodies[fn.name] ?? "{}"}
                        onChange={(e) =>
                          setRunBodies((prev) => ({ ...prev, [fn.name]: e.target.value }))
                        }
                        className="font-mono text-xs mt-1"
                        placeholder="{}"
                      />
                      <div className="flex items-center gap-2 mt-2.5">
                        <Button
                          size="sm"
                          onClick={() => void handleRun(fn)}
                          disabled={executing}
                          className="h-7 px-3 text-xs gap-1.5"
                        >
                          {executing ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin" />
                              <span>Running…</span>
                            </>
                          ) : (
                            <>
                              <Play className="w-3 h-3 fill-current" />
                              <span>Execute</span>
                            </>
                          )}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2.5 text-xs"
                          onClick={() => {
                            setRunning(null);
                            setRunResult(null);
                          }}
                        >
                          Close
                        </Button>
                      </div>

                      {runResult && (
                        <div className="mt-3 text-xs pt-2 border-t border-border/60">
                          <div className="flex items-center gap-2 font-mono">
                            {runResult.ok ? (
                              <div className="flex items-center gap-1 text-emerald-400 font-semibold">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                <span>Success (200)</span>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1 text-destructive font-semibold">
                                <XCircle className="w-3.5 h-3.5" />
                                <span>Failed</span>
                              </div>
                            )}
                            <span className="text-muted-foreground">·</span>
                            <span className="text-muted-foreground">Duration: <strong>{runResult.durationMs}ms</strong></span>
                            {runResult.timedOut && (
                              <Badge variant="destructive" className="gap-1 text-[10px] h-4 py-0">
                                <Clock className="w-2.5 h-2.5" />
                                <span>Timed out</span>
                              </Badge>
                            )}
                          </div>

                          {runResult.error && (
                            <div className="text-destructive font-mono mt-1.5 p-2 bg-destructive/10 rounded border border-destructive/20">
                              {runResult.error}
                            </div>
                          )}

                          {runResult.result !== undefined && runResult.result !== null && (
                            <pre className="bg-card border border-border p-2.5 rounded mt-2 overflow-x-auto text-[11px] font-mono text-foreground">
                              {JSON.stringify(runResult.result, null, 2)}
                            </pre>
                          )}

                          {runResult.logs.length > 0 && (
                            <details className="mt-2 text-xs">
                              <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
                                Console Logs ({runResult.logs.length})
                              </summary>
                              <pre className="bg-card border border-border p-2.5 rounded mt-1 overflow-x-auto text-[11px] font-mono text-foreground">
                                {runResult.logs.join("\n")}
                              </pre>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}

          {/* M43: Shared modules ($lib) */}
          <div className="mt-6">
            <ModuleManager
              projectId={projectId}
              functions={functions}
              onChanged={load}
              onSuccess={toastSuccess}
              onError={toastError}
            />
          </div>

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
                toastSuccess("Function saved successfully.");
                void load();
              }}
            />
          )}

          {/* Toast notifications */}
          <ToastHost toasts={toasts} onDismiss={dismiss} />
        </div>
      </div>
    </>
  );
}
