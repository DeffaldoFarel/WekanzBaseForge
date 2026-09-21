"use client";

// ============================================================================
// M46/M42: EXECUTION LOGS + SECRETS PANEL — detail function di halaman Functions
//
// Panel expandable per-function:
//  - Riwayat eksekusi (callable/public/trigger/schedule) dengan pagination —
//    dulu hanya log run di sesi browser, eksekusi cron/trigger tak terlihat.
//  - Kelola secrets ($env): list metadata (nilai TIDAK PERNAH dikembalikan API),
//    set/overwrite, delete — dulu hanya bisa via curl.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import {
  listExecutionLogs,
  clearExecutionLogs,
  listSecrets,
  setSecret,
  deleteSecret,
  type ExecutionLogEntry,
  type SecretMeta,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import { useToasts, ToastHost } from "@/components/ui/toast";
import { LoadError } from "@/components/ui/load-error";
import {
  RefreshCw,
  History,
  KeyRound,
  Trash2,
  Plus,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react";

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function FunctionLogs({
  projectId,
  functionName,
}: {
  projectId: string;
  functionName: string;
}) {
  const [tab, setTab] = useState<"logs" | "secrets">("logs");

  // logs state
  const [entries, setEntries] = useState<ExecutionLogEntry[]>([]);
  const [page, setPage] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [logsError, setLogsError] = useState("");

  // secrets state
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [loadingSecrets, setLoadingSecrets] = useState(false);
  const [secretsError, setSecretsError] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [savingSecret, setSavingSecret] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDelSecret, setConfirmDelSecret] = useState<string | null>(null);

  const { toasts, success: toastSuccess, error: toastError, dismiss } = useToasts();

  const loadLogs = useCallback(
    async (p: number) => {
      setLoadingLogs(true);
      setLogsError("");
      try {
        const res = await listExecutionLogs(projectId, functionName, p);
        setEntries(res.items);
        setPage(res.page);
        setTotalItems(res.totalItems);
      } catch (e) {
        setLogsError(e instanceof Error ? e.message : "Failed to load logs");
      } finally {
        setLoadingLogs(false);
      }
    },
    [projectId, functionName]
  );

  const loadSecrets = useCallback(async () => {
    setLoadingSecrets(true);
    setSecretsError("");
    try {
      setSecrets(await listSecrets(projectId, functionName));
    } catch (e) {
      setSecretsError(e instanceof Error ? e.message : "Failed to load secrets");
    } finally {
      setLoadingSecrets(false);
    }
  }, [projectId, functionName]);

  useEffect(() => {
    loadLogs(1);
  }, [loadLogs]);

  const switchTab = (t: "logs" | "secrets") => {
    setTab(t);
    if (t === "secrets" && secrets.length === 0 && !loadingSecrets) loadSecrets();
  };

  const totalPages = Math.max(1, Math.ceil(totalItems / 20));

  async function handleClearLogs() {
    setConfirmClear(false);
    try {
      const res = await clearExecutionLogs(projectId, functionName);
      toastSuccess(`Cleared ${res.cleared} log entries.`);
      loadLogs(1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to clear logs";
      toastError(msg);
    }
  }

  async function handleAddSecret() {
    if (!newKey.trim() || !newValue.trim()) return;
    setSavingSecret(true);
    try {
      await setSecret(projectId, functionName, newKey.trim(), newValue);
      toastSuccess(`Secret "${newKey.trim()}" saved.`);
      setNewKey("");
      setNewValue("");
      loadSecrets();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save secret";
      setSecretsError(msg);
      toastError(msg);
    } finally {
      setSavingSecret(false);
    }
  }

  async function handleDeleteSecret(key: string) {
    setConfirmDelSecret(null);
    try {
      await deleteSecret(projectId, functionName, key);
      toastSuccess(`Secret "${key}" deleted.`);
      loadSecrets();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to delete secret";
      toastError(msg);
    }
  }

  return (
    <div className="bg-muted rounded-lg p-3 mt-2">
      {/* Tab switcher */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex items-center gap-1 bg-secondary p-1 rounded-lg border border-border">
          <button
            onClick={() => switchTab("logs")}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
              tab === "logs" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>History ({totalItems})</span>
          </button>
          <button
            onClick={() => switchTab("secrets")}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
              tab === "secrets" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>Secrets ($env)</span>
          </button>
        </div>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => (tab === "logs" ? loadLogs(page) : loadSecrets())}
          disabled={loadingLogs || loadingSecrets}
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingLogs || loadingSecrets ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {tab === "logs" ? (
        <div>
          {confirmClear && (
            <ConfirmDelete
              title={`Clear execution history for "${functionName}"?`}
              description="All stored execution log entries for this function will be permanently deleted. The function itself is not affected."
              confirmLabel="Clear History"
              onConfirm={handleClearLogs}
              onCancel={() => setConfirmClear(false)}
            />
          )}
          {loadingLogs ? (
            <p className="text-muted-foreground text-xs">Loading history…</p>
          ) : logsError ? (
            /* Eksklusif, bukan berdampingan: sebelumnya error tampil DI ATAS
               "No executions recorded yet", sehingga user membaca dua klaim
               yang bertentangan sekaligus. */
            <LoadError
              variant="inline"
              message={logsError}
              onRetry={() => loadLogs(page)}
              retrying={loadingLogs}
            />
          ) : entries.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No executions recorded yet. Runs, triggers, and scheduled executions will appear here.
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                {entries.map((e) => (
                  <div
                    key={e.id}
                    className="bg-card border border-border rounded-md p-2.5 text-xs"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      {e.ok ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
                      )}
                      <Badge variant="secondary" className="text-[10px] font-mono py-0">
                        {e.source}
                      </Badge>
                      <span className="font-mono text-muted-foreground">{e.durationMs}ms</span>
                      {e.memoryMb != null && (
                        <span className="font-mono text-muted-foreground text-[10px]">
                          {e.memoryMb}MB
                        </span>
                      )}
                      <span className="flex-1" />
                      <span className="text-muted-foreground text-[10px]">{fmtTime(e.created)}</span>
                    </div>
                    {e.error && (
                      <p className="text-destructive mt-1.5 break-words">{e.error}</p>
                    )}
                    {e.logs.length > 0 && (
                      <details className="mt-1.5">
                        <summary className="text-muted-foreground cursor-pointer">
                          console ({e.logs.length})
                        </summary>
                        <pre className="mt-1 overflow-x-auto text-[11px] whitespace-pre-wrap">
                          {e.logs.join("\n")}
                        </pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
                  <span>
                    Page {page} of {totalPages} · {totalItems} executions
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => loadLogs(page - 1)}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => loadLogs(page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex justify-end mt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 gap-1"
                  onClick={() => setConfirmClear(true)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear History</span>
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div>
          {loadingSecrets ? (
            <p className="text-muted-foreground text-xs">Loading secrets…</p>
          ) : (
            <>
              {confirmDelSecret && (
                <ConfirmDelete
                  title={`Delete secret "${confirmDelSecret}"?`}
                  description="The function will no longer see this key in $env after its next run. This cannot be undone."
                  confirmLabel="Delete Secret"
                  onConfirm={() => handleDeleteSecret(confirmDelSecret)}
                  onCancel={() => setConfirmDelSecret(null)}
                />
              )}
              {secretsError ? (
                /* "No secrets set" saat fetch gagal bisa membuat admin
                   menambah ulang secret yang sebenarnya sudah ada. */
                <LoadError
                  variant="inline"
                  message={secretsError}
                  onRetry={loadSecrets}
                  retrying={loadingSecrets}
                />
              ) : secrets.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  No secrets set. Add one below — the value is encrypted at rest and never
                  shown again by the API.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {secrets.map((s) => (
                    <div
                      key={s.key}
                      className="bg-card border border-border rounded-md p-2.5 text-xs flex items-center gap-2"
                    >
                      <KeyRound className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="font-mono font-medium">{s.key}</span>
                      <span className="text-muted-foreground text-[10px]">
                        updated {fmtTime(s.updated)}
                      </span>
                      <span className="flex-1" />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:bg-destructive/10"
                        onClick={() => setConfirmDelSecret(s.key)}
                        title="Delete secret"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {/* Add secret */}
              <div className="flex gap-2 mt-3 flex-wrap">
                <Input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="key (e.g. STRIPE_API_KEY)"
                  className="font-mono text-xs w-[200px]"
                />
                <Input
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder="value"
                  type="password"
                  className="font-mono text-xs flex-1 min-w-[160px]"
                />
                <Button
                  size="sm"
                  onClick={handleAddSecret}
                  disabled={savingSecret || !newKey.trim() || !newValue.trim()}
                  className="gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{savingSecret ? "Saving…" : "Save Secret"}</span>
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5">
                Saved once — then only the key metadata is readable. Saving an existing key
                overwrites it.
              </p>
            </>
          )}
        </div>
      )}

      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
