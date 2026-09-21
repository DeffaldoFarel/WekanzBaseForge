"use client";

// ============================================================================
// M28: WEBHOOKS PAGE — kelola webhook project dari dashboard
//
// Sebelumnya seluruh fitur M28 (CRUD + test + delivery log) hanya bisa
// diakses via curl/API. Halaman ini menutup jarak itu:
//  - List webhook (nama, url, events, enabled, secret hint)
//  - Create/edit via panel inline (nama, URL, events, enabled)
//  - Secret penuh tampil SEKALI saat create (pola API key M26)
//  - Test delivery (fire-and-forget) + delivery log per webhook
//  - Toggle enable/disable instan, delete via ConfirmDelete
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  listWebhookDeliveries,
  getWebhook,
  listCollectionsForFunctions,
  type WebhookDef,
  type WebhookDelivery,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ConfirmDelete } from "@/components/ui/confirm-delete";
import { useToasts, ToastHost } from "@/components/ui/toast";
import { LoadError, errorMessage } from "@/components/ui/load-error";
import {
  Webhook,
  Plus,
  Play,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Copy,
  Check,
  Globe,
  ChevronDown,
  ChevronUp,
  X,
  Clock,
  Loader2,
} from "lucide-react";

const EVENT_ACTIONS = ["create", "update", "delete"] as const;

export default function WebhooksPage() {
  const params = useParams();
  const projectId = params.id as string;

  const [webhooks, setWebhooks] = useState<WebhookDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Timer terlacak: setTimeout yang tidak disimpan akan tetap jalan (dan
  // memanggil setState) walau komponen sudah unmount atau webhook-nya sudah
  // dihapus — React memperingatkan "update on unmounted component".
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const schedule = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timersRef.current.delete(t);
      fn();
    }, ms);
    timersRef.current.add(t);
  }, []);
  // Unmount: batalkan semua yang belum jalan.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // editor state
  const [editing, setEditing] = useState<WebhookDef | null>(null);
  const [creating, setCreating] = useState(false);
  const [collectionNames, setCollectionNames] = useState<string[]>([]);
  const [collectionsError, setCollectionsError] = useState("");

  // secret sekali-lihat setelah create
  const [freshSecret, setFreshSecret] = useState<{ name: string; secret: string } | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  // deliveries panel per webhook
  const [deliveriesOpen, setDeliveriesOpen] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesError, setDeliveriesError] = useState("");
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);

  // test send state
  const [testing, setTesting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  // delete confirm
  const [confirmDeleteHook, setConfirmDeleteHook] = useState<WebhookDef | null>(null);

  const { toasts, success: toastSuccess, error: toastError, dismiss } = useToasts();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setWebhooks(await listWebhooks(projectId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
    listCollectionsForFunctions(projectId)
      .then((cols) => {
        setCollectionNames(cols.map((c) => c.name));
        setCollectionsError("");
      })
      .catch((e) => {
        // Dulu `.catch(() => setCollectionNames([]))` — editor event lalu
        // menampilkan "No collections in this project yet", membuat admin
        // mengira project-nya memang kosong padahal request yang gagal.
        setCollectionNames([]);
        setCollectionsError(errorMessage(e, "Failed to load collections"));
      });
  }, [load, projectId]);

  async function loadDeliveries(hookId: string) {
    setLoadingDeliveries(true);
    setDeliveriesError("");
    try {
      setDeliveries(await listWebhookDeliveries(projectId, hookId));
    } catch (e) {
      // "No deliveries yet" pada webhook yang sebenarnya gagal dibaca akan
      // menuntun admin men-debug endpoint yang justru tidak bermasalah.
      setDeliveries([]);
      setDeliveriesError(errorMessage(e, "Failed to load delivery log"));
    } finally {
      setLoadingDeliveries(false);
    }
  }

  function toggleDeliveries(hookId: string) {
    if (deliveriesOpen === hookId) {
      setDeliveriesOpen(null);
      return;
    }
    setDeliveriesOpen(hookId);
    loadDeliveries(hookId);
  }

  async function handleToggle(hook: WebhookDef) {
    if (toggling === hook.id) return;
    setToggling(hook.id);
    try {
      await updateWebhook(projectId, hook.id, { enabled: !hook.enabled });
      load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to update webhook");
    } finally {
      setToggling(null);
    }
  }

  async function handleDelete(hook: WebhookDef) {
    setConfirmDeleteHook(null);
    try {
      await deleteWebhook(projectId, hook.id);
      toastSuccess(`Webhook '${hook.name}' deleted.`);
      if (deliveriesOpen === hook.id) setDeliveriesOpen(null);
      load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to delete webhook");
    }
  }

  async function handleTest(hook: WebhookDef) {
    setTesting(hook.id);
    try {
      await testWebhook(projectId, hook.id);
      toastSuccess(`Test delivery sent to '${hook.name}' — check the log below in a few seconds.`);
      // refresh deliveries kalau panelnya sedang terbuka
      if (deliveriesOpen === hook.id) {
        schedule(() => loadDeliveries(hook.id), 2500);
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to send test");
    } finally {
      setTesting(null);
    }
  }

  function copySecret() {
    if (!freshSecret) return;
    navigator.clipboard.writeText(freshSecret.secret);
    setSecretCopied(true);
    schedule(() => setSecretCopied(false), 1500);
  }

  return (
    <>
      <Navbar projectId={projectId} />

      <div className="flex min-h-[calc(100vh-61px)] px-5 py-5 gap-5 items-start w-full">
        <ProjectSidebar projectId={projectId} />

        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">
                Webhooks ({webhooks.length})
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                HTTP notifications when records change — signed with HMAC, retried 3× with backoff.
              </p>
            </div>
            <Button
              onClick={() => { setCreating(true); setEditing(null); }}
              className="gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>New Webhook</span>
            </Button>
          </div>

          {error && (
            <Card className="p-3 mb-4 border-destructive/50 bg-destructive/10 text-destructive text-sm flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </Card>
          )}

          {/* Secret sekali-lihat setelah create */}
          {freshSecret && (
            <Card className="p-4 mb-4 border-emerald-500/40 bg-emerald-500/10">
              <p className="text-sm text-emerald-400 font-medium flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4" />
                <span>Webhook '{freshSecret.name}' created — save this signing secret now. It won't be shown again.</span>
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-card border border-border rounded-md px-3 py-2 font-mono text-xs text-foreground break-all">
                  {freshSecret.secret}
                </code>
                <Button variant="secondary" size="sm" onClick={copySecret} className="gap-1.5 shrink-0">
                  {secretCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{secretCopied ? "Copied" : "Copy"}</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setFreshSecret(null)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                Verify each delivery with the <code>X-BaseForge-Signature</code> header (HMAC-SHA256 of the raw body).
              </p>
            </Card>
          )}

          {confirmDeleteHook && (
            <ConfirmDelete
              title={`Delete webhook '${confirmDeleteHook.name}'?`}
              description="This endpoint will stop receiving event notifications immediately. The delivery history is also removed. This cannot be undone."
              confirmLabel="Delete Webhook"
              onConfirm={() => handleDelete(confirmDeleteHook)}
              onCancel={() => setConfirmDeleteHook(null)}
            />
          )}

          {/* List */}
          {loading ? (
            <Card className="p-8 text-center text-muted-foreground text-sm">Loading webhooks…</Card>
          ) : webhooks.length === 0 ? (
            <Card className="p-8 text-center">
              <Webhook className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                No webhooks yet. Create one to notify your server when records are created, updated, or deleted.
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {webhooks.map((hook) => (
                <Card key={hook.id} className="p-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`font-medium ${hook.enabled ? "text-foreground" : "text-muted-foreground line-through"}`}>
                      {hook.name}
                    </span>
                    {!hook.enabled && (
                      <Badge variant="secondary" className="text-[10px]">disabled</Badge>
                    )}
                    {hook.events.map((e) => (
                      <Badge key={e} variant="secondary" className="text-[10px] font-mono">
                        {e}
                      </Badge>
                    ))}
                    <span className="flex-1" />
                    <label className={`flex items-center gap-1.5 text-sm ${toggling === hook.id ? "opacity-60 cursor-wait" : "cursor-pointer"}`}>
                      <Checkbox
                        checked={hook.enabled}
                        disabled={toggling === hook.id}
                        onCheckedChange={() => handleToggle(hook)}
                      />
                      {toggling === hook.id && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                      {hook.enabled ? "active" : "disabled"}
                    </label>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleTest(hook)}
                      disabled={testing === hook.id}
                      className="gap-1"
                      title="Send a test delivery (event: _test.create)"
                    >
                      <Play className="w-3 h-3 fill-current" />
                      <span>{testing === hook.id ? "Sending…" : "Test"}</span>
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => { setEditing(hook); setCreating(false); }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setConfirmDeleteHook(hook)}
                    >
                      Delete
                    </Button>
                  </div>

                  <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                    <Globe className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-mono break-all">{hook.url}</span>
                    {hook.secretHint && (
                      <>
                        <span className="text-border">·</span>
                        <span className="font-mono" title="Signing secret (masked)">secret: {hook.secretHint}</span>
                      </>
                    )}
                  </div>

                  {/* Deliveries toggle */}
                  <button
                    onClick={() => toggleDeliveries(hook.id)}
                    className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {deliveriesOpen === hook.id ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                    <span>Delivery log</span>
                  </button>

                  {deliveriesOpen === hook.id && (
                    <div className="bg-muted rounded-lg p-3 mt-2">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-muted-foreground">Last {deliveries.length} deliveries</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => loadDeliveries(hook.id)}
                          disabled={loadingDeliveries}
                          title="Refresh deliveries"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${loadingDeliveries ? "animate-spin" : ""}`} />
                        </Button>
                      </div>
                      {loadingDeliveries ? (
                        <p className="text-muted-foreground text-xs">Loading…</p>
                      ) : deliveriesError ? (
                        <LoadError
                          variant="inline"
                          message={deliveriesError}
                          onRetry={() => loadDeliveries(hook.id)}
                          retrying={loadingDeliveries}
                        />
                      ) : deliveries.length === 0 ? (
                        <p className="text-muted-foreground text-xs">
                          No deliveries yet. Trigger a matching event (or press Test) and it will appear here.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {deliveries.map((d) => (
                            <div
                              key={d.id}
                              className="bg-card border border-border rounded-md p-2.5 text-xs flex items-center gap-2 flex-wrap"
                            >
                              {d.ok ? (
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                              ) : (
                                <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
                              )}
                              <Badge variant="secondary" className="text-[10px] font-mono py-0">{d.event}</Badge>
                              <span className="font-mono text-muted-foreground">
                                {d.statusCode ?? "—"}
                              </span>
                              <span className="font-mono text-muted-foreground">{d.durationMs}ms</span>
                              {d.attempt > 1 && (
                                <span className="text-amber-400 text-[10px]">attempt {d.attempt}</span>
                              )}
                              <span className="flex-1" />
                              <span className="text-muted-foreground text-[10px] flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {new Date(d.deliveredAt).toLocaleString()}
                              </span>
                              {d.error && (
                                <p className="w-full text-destructive mt-1 break-words">{d.error}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}

          {/* Editor panel */}
          {(creating || editing) && (
            <WebhookEditor
              projectId={projectId}
              existing={editing}
              collectionNames={collectionNames}
              collectionsError={collectionsError}
              onClose={() => { setCreating(false); setEditing(null); }}
              onSaved={(hook, isNew) => {
                setCreating(false);
                setEditing(null);
                if (isNew && hook.secret) {
                  setFreshSecret({ name: hook.name, secret: hook.secret });
                } else {
                  toastSuccess(`Webhook '${hook.name}' saved.`);
                }
                load();
              }}
            />
          )}
        </div>
      </div>

      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </>
  );
}

// ─── Editor panel (create & edit) ───────────────────────────────────────────

function WebhookEditor({
  projectId,
  existing,
  collectionNames,
  collectionsError,
  onClose,
  onSaved,
}: {
  projectId: string;
  existing: WebhookDef | null;
  collectionNames: string[];
  /** Diteruskan agar editor tidak menyebut project "kosong" saat fetch gagal. */
  collectionsError?: string;
  onClose: () => void;
  onSaved: (hook: WebhookDef, isNew: boolean) => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [listenAll, setListenAll] = useState(existing ? existing.events.includes("*") : true);
  const [selectedEvents, setSelectedEvents] = useState<string[]>(
    existing && !existing.events.includes("*") ? existing.events : []
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  function toggleEvent(ev: string) {
    setSelectedEvents((prev) =>
      prev.includes(ev) ? prev.filter((x) => x !== ev) : [...prev, ev]
    );
  }

  async function handleSave() {
    setErr("");
    if (!name.trim()) { setErr("Name is required"); return; }
    if (!url.trim()) { setErr("URL is required"); return; }
    if (!/^https?:\/\//i.test(url.trim())) { setErr("URL must start with http:// or https://"); return; }
    const events = listenAll ? ["*"] : selectedEvents;
    if (events.length === 0) { setErr("Pick at least one event (or listen to all)"); return; }

    setSaving(true);
    try {
      const payload = { name: name.trim(), url: url.trim(), events };
      const hook = existing
        ? await updateWebhook(projectId, existing.id, payload)
        : await createWebhook(projectId, payload);
      onSaved(hook, !existing);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5 mt-6 border-accent">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-foreground">
          {existing ? `Edit Webhook: ${existing.name}` : "New Webhook"}
        </h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      {err && (
        <p className="text-destructive text-sm mb-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{err}</span>
        </p>
      )}

      <div className="space-y-4">
        <div className="flex gap-4 flex-wrap">
          <div className="flex-1 min-w-[180px] space-y-2">
            <Label htmlFor="wh-name">Name *</Label>
            <Input
              id="wh-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. notify-order-service"
              maxLength={64}
            />
          </div>
          <div className="flex-[2] min-w-[240px] space-y-2">
            <Label htmlFor="wh-url">Endpoint URL *</Label>
            <Input
              id="wh-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.com/hooks/baseforge"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Must be a public http(s) URL — private/loopback hosts are blocked in production mode.
            </p>
          </div>
        </div>

        {/* Events */}
        <div className="space-y-2">
          <Label>Events *</Label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={listenAll}
              onCheckedChange={(c: boolean | "indeterminate") => setListenAll(c === true)}
            />
            <span className="font-mono">* — listen to all events in every collection</span>
          </label>

          {!listenAll && (
            <div className="space-y-2 pt-1">
              {collectionsError ? (
                /* Tanpa ini, gagal-muat tampil sebagai "project belum punya
                   collection" — admin bisa membuat collection duplikat. */
                <LoadError variant="inline" message={collectionsError} />
              ) : collectionNames.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No collections in this project yet. Create one first, or listen to all events.
                </p>
              ) : (
                collectionNames.map((col) => (
                  <div key={col} className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-sm text-foreground w-40 truncate">{col}</span>
                    {EVENT_ACTIONS.map((action) => {
                      const ev = `${col}.${action}`;
                      return (
                        <label key={ev} className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <Checkbox
                            checked={selectedEvents.includes(ev)}
                            onCheckedChange={() => toggleEvent(ev)}
                          />
                          <span className="font-mono">{action}</span>
                        </label>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <Button onClick={handleSave} disabled={saving} className="gap-1.5">
            <span>{saving ? "Saving…" : existing ? "Save Changes" : "Create Webhook"}</span>
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}
