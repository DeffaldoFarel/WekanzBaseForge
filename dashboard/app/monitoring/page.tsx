"use client";

// ============================================================================
// M33: MONITORING PAGE — platform-level health: alert rules + history
//
// Sebelumnya seluruh fitur M33 (rules threshold, webhook notifikasi,
// alert history, test/ack/resolve) hanya bisa via curl. Monitoring bersifat
// PLATFORM-wide (bukan per-project), jadi pantas jadi halaman top-level
// yang ditautkan dari Settings.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  getMonitoringSettings,
  updateMonitoringSettings,
  listAlerts,
  sendTestAlert,
  acknowledgeAlert,
  resolveAlert,
  type MonitoringSettings,
  type AlertRecord,
  type AlertRuleName,
} from "@/lib/api";
import { Navbar } from "@/components/Navbar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToasts, ToastHost } from "@/components/ui/toast";
import {
  Activity,
  AlertTriangle,
  Bell,
  BellRing,
  Check,
  CheckCircle2,
  ChevronLeft,
  Flame,
  Loader2,
  RefreshCw,
  Send,
  Siren,
} from "lucide-react";

type AlertTab = "firing" | "resolved" | "all";

export default function MonitoringPage() {
  const [settings, setSettings] = useState<MonitoringSettings | null>(null);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [tab, setTab] = useState<AlertTab>("firing");
  const [loading, setLoading] = useState(true);
  const [loadingAlerts, setLoadingAlerts] = useState(false);

  // edit state per rule: threshold + enabled (keyed by rule name)
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, { threshold: string; enabled: boolean }>>({});
  const [cooldownDraft, setCooldownDraft] = useState("15");
  const [webhookDraft, setWebhookDraft] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);
  const [testing, setTesting] = useState(false);
  const [actingOn, setActingOn] = useState<string | null>(null);

  const { toasts, success: toastSuccess, error: toastError, dismiss } = useToasts();

  const loadAlerts = useCallback(
    async (t: AlertTab) => {
      setLoadingAlerts(true);
      try {
        setAlerts(await listAlerts(t === "all" ? undefined : t));
      } catch {
        setAlerts([]);
      } finally {
        setLoadingAlerts(false);
      }
    },
    []
  );

  const load = useCallback(async () => {
    try {
      const s = await getMonitoringSettings();
      setSettings(s);
      setCooldownDraft(String(s.cooldownMinutes));
      setWebhookDraft(s.webhookUrl ?? "");
      const drafts: Record<string, { threshold: string; enabled: boolean }> = {};
      for (const r of s.rules) {
        drafts[r.name] = { threshold: String(r.threshold), enabled: r.enabled };
      }
      setRuleDrafts(drafts);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to load monitoring settings");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadAlerts(tab);
  }, [tab, loadAlerts]);

  async function handleToggleEnabled() {
    if (!settings) return;
    try {
      await updateMonitoringSettings({ enabled: !settings.enabled });
      toastSuccess(!settings.enabled ? "Monitoring enabled — checks run every 30s." : "Monitoring paused.");
      load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to update");
    }
  }

  async function handleSaveConfig() {
    const cooldown = parseInt(cooldownDraft, 10);
    if (Number.isNaN(cooldown) || cooldown < 1 || cooldown > 1440) {
      toastError("Cooldown must be between 1 and 1440 minutes.");
      return;
    }
    const rules: { name: AlertRuleName; threshold: number; enabled: boolean }[] = [];
    for (const r of settings?.rules ?? []) {
      const d = ruleDrafts[r.name];
      const t = parseFloat(d?.threshold ?? "");
      if (Number.isNaN(t) || t <= 0) {
        toastError(`Threshold for "${r.label}" must be a positive number.`);
        return;
      }
      rules.push({ name: r.name, threshold: t, enabled: d?.enabled ?? r.enabled });
    }
    if (webhookDraft.trim() && !/^https?:\/\//i.test(webhookDraft.trim())) {
      toastError("Notification webhook URL must start with http:// or https://");
      return;
    }
    setSavingConfig(true);
    try {
      await updateMonitoringSettings({
        rules,
        cooldownMinutes: cooldown,
        webhookUrl: webhookDraft.trim(),
      });
      toastSuccess("Monitoring configuration saved.");
      load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const alert = await sendTestAlert();
      toastSuccess(`Test alert created: ${alert.message}`);
      loadAlerts(tab);
      load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  async function handleAck(id: string) {
    setActingOn(id);
    try {
      await acknowledgeAlert(id);
      toastSuccess("Alert acknowledged.");
      loadAlerts(tab);
      load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed");
    } finally {
      setActingOn(null);
    }
  }

  async function handleResolve(id: string) {
    setActingOn(id);
    try {
      await resolveAlert(id);
      toastSuccess("Alert resolved.");
      loadAlerts(tab);
      load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed");
    } finally {
      setActingOn(null);
    }
  }

  return (
    <>
      <Navbar />

      <div className="max-w-[1000px] mx-auto px-6 py-6">
        {/* Header */}
        <div className="mb-6">
          <Link
            href="/settings"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Back to Settings</span>
          </Link>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2.5">
                <Activity className="w-6 h-6" />
                Platform Monitoring
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Threshold-based alerts across all projects — checked every 30 seconds, delivered to your webhook.
              </p>
            </div>
            {settings && (
              <div className="flex items-center gap-3">
                {settings.stats.unresolved > 0 && (
                  <Badge variant="destructive" className="gap-1.5">
                    <Siren className="w-3 h-3" />
                    <span>{settings.stats.unresolved} unresolved</span>
                  </Badge>
                )}
                <label className="flex items-center gap-2 text-sm cursor-pointer bg-secondary border border-border rounded-md px-3 py-1.5">
                  <Checkbox
                    checked={settings.enabled}
                    onCheckedChange={handleToggleEnabled}
                  />
                  <span>{settings.enabled ? "Monitoring ON" : "Monitoring OFF"}</span>
                </label>
              </div>
            )}
          </div>
        </div>

        {loading ? (
          <Card className="p-8 text-center text-muted-foreground text-sm">Loading monitoring…</Card>
        ) : !settings ? (
          <Card className="p-8 text-center text-muted-foreground text-sm">Failed to load monitoring settings.</Card>
        ) : (
          <>
            {/* Alert rules config */}
            <Card className="p-5 mb-6">
              <h3 className="text-base font-semibold mb-1 flex items-center gap-2">
                <Bell className="w-4 h-4 text-muted-foreground" />
                <span>Alert Rules</span>
              </h3>
              <p className="text-xs text-muted-foreground mb-4">
                An alert fires when a metric crosses its threshold. After firing, the same rule stays quiet for the cooldown period.
              </p>

              <div className="space-y-2.5">
                {settings.rules.map((r) => {
                  const draft = ruleDrafts[r.name];
                  return (
                    <div
                      key={r.name}
                      className="bg-muted rounded-lg p-3 flex items-center gap-3 flex-wrap"
                    >
                      <Checkbox
                        checked={draft?.enabled ?? r.enabled}
                        onCheckedChange={(c: boolean | "indeterminate") =>
                          setRuleDrafts((prev) => ({
                            ...prev,
                            [r.name]: { threshold: prev[r.name]?.threshold ?? String(r.threshold), enabled: c === true },
                          }))
                        }
                      />
                      <div className="min-w-[220px] flex-1">
                        <p className="text-sm font-medium text-foreground">{r.label}</p>
                        <p className="text-[11px] text-muted-foreground">{r.description}</p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">fires above</span>
                        <Input
                          type="number"
                          min={0}
                          step="any"
                          value={draft?.threshold ?? String(r.threshold)}
                          onChange={(e) =>
                            setRuleDrafts((prev) => ({
                              ...prev,
                              [r.name]: { threshold: e.target.value, enabled: prev[r.name]?.enabled ?? r.enabled },
                            }))
                          }
                          className="h-8 w-28 font-mono text-sm"
                        />
                        <span className="text-xs text-muted-foreground w-16">{r.unit}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-end gap-3 mt-4 flex-wrap">
                <div className="space-y-1.5">
                  <Label htmlFor="mon-cooldown" className="text-xs">Cooldown (minutes, 1–1440)</Label>
                  <Input
                    id="mon-cooldown"
                    type="number"
                    min={1}
                    max={1440}
                    value={cooldownDraft}
                    onChange={(e) => setCooldownDraft(e.target.value)}
                    className="h-9 w-32"
                  />
                </div>
                <div className="space-y-1.5 flex-1 min-w-[240px]">
                  <Label htmlFor="mon-webhook" className="text-xs">Notification webhook (Slack/Discord/Telegram — optional)</Label>
                  <Input
                    id="mon-webhook"
                    value={webhookDraft}
                    onChange={(e) => setWebhookDraft(e.target.value)}
                    placeholder="https://hooks.slack.com/services/…"
                    className="h-9 font-mono text-sm"
                  />
                </div>
                <Button onClick={handleSaveConfig} disabled={savingConfig} className="gap-1.5">
                  {savingConfig ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>{savingConfig ? "Saving…" : "Save Configuration"}</span>
                </Button>
                <Button variant="secondary" onClick={handleTest} disabled={testing} className="gap-1.5">
                  {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  <span>{testing ? "Sending…" : "Send Test Alert"}</span>
                </Button>
              </div>
            </Card>

            {/* Alert history */}
            <Card className="p-5">
              <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                <h3 className="text-base font-semibold flex items-center gap-2">
                  <BellRing className="w-4 h-4 text-muted-foreground" />
                  <span>Alert History</span>
                </h3>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 bg-secondary p-1 rounded-lg border border-border">
                    {(["firing", "resolved", "all"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTab(t)}
                        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors capitalize ${
                          tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => loadAlerts(tab)} disabled={loadingAlerts} title="Refresh">
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingAlerts ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              </div>

              {loadingAlerts ? (
                <p className="text-sm text-muted-foreground">Loading alerts…</p>
              ) : alerts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {tab === "firing"
                    ? "No firing alerts — everything is within thresholds. 🎉"
                    : "No alerts in this view yet."}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {alerts.map((a) => (
                    <div
                      key={a.id}
                      className="bg-muted border border-border rounded-md p-3 text-xs"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        {a.status === "firing" ? (
                          <Flame className="w-3.5 h-3.5 text-destructive shrink-0" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        )}
                        <Badge variant={a.status === "firing" ? "destructive" : "secondary"} className="text-[10px]">
                          {a.status}
                        </Badge>
                        {a.status === "firing" && a.acknowledged && (
                          <Badge variant="secondary" className="text-[10px]">acknowledged</Badge>
                        )}
                        <span className="text-foreground font-medium">{a.message}</span>
                        <span className="flex-1" />
                        <span className="text-muted-foreground text-[10px]">
                          {new Date(a.triggeredAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 text-muted-foreground flex-wrap">
                        <span className="font-mono">
                          value {a.value} / threshold {a.threshold}
                        </span>
                        {a.resolvedAt && (
                          <>
                            <span className="text-border">·</span>
                            <span>resolved {new Date(a.resolvedAt).toLocaleString()}</span>
                          </>
                        )}
                        <span className="flex-1" />
                        {a.status === "firing" && (
                          <div className="flex gap-1.5">
                            {!a.acknowledged && (
                              <Button
                                variant="secondary"
                                size="sm"
                                className="h-6 text-[11px]"
                                disabled={actingOn === a.id}
                                onClick={() => handleAck(a.id)}
                              >
                                Acknowledge
                              </Button>
                            )}
                            <Button
                              variant="secondary"
                              size="sm"
                              className="h-6 text-[11px]"
                              disabled={actingOn === a.id}
                              onClick={() => handleResolve(a.id)}
                            >
                              Resolve
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </div>

      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
