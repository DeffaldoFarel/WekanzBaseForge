// ============================================================================
// M33: MONITOR — threshold alerting untuk metrics (M24) + server health
//
// Desain ala Grafana/PagerDuty (simplified):
//   1. CHECK: tiap 30 detik, evaluasi rule terhadap metrics hari ini
//   2. TRIGGER: jika value > threshold → buat alert (status: "firing")
//   3. COOLDOWN: jangan re-alert untuk rule yang sama dalam N menit
//   4. RESOLVE: jika value turun di bawah threshold → status: "resolved"
//   5. NOTIFY: kirim alert ke channel (webhook Slack/Discord/Telegram)
//
// Rules (configurable per platform, disimpan di platform.db):
//   - requests_per_minute: threshold (default 1000)
//   - bandwidth_per_minute_mb: threshold (default 500 MB)
//   - error_rate_percent: threshold (default 10%)
//   - disk_usage_percent: threshold (default 85%)
//
// Alert state disimpan di tabel _alerts (platform.db):
//   id, rule, project_id (nullable = platform-wide), status, value,
//   threshold, message, triggered_at, resolved_at, acknowledged
// ============================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getPlatformDb, listProjects } from './platformDb.js';
import { getProjectStats } from './metrics.js';

// ─── Tipe ─────────────────────────────────────────────────────────────────────

export type AlertRuleName =
  | 'requests_per_minute'
  | 'bandwidth_per_minute_mb'
  | 'error_rate_percent'
  | 'disk_usage_percent';

export interface AlertRule {
  name: AlertRuleName;
  label: string;
  description: string;
  threshold: number;
  unit: string;
  enabled: boolean;
}

export interface AlertRecord {
  id: string;
  rule: AlertRuleName;
  projectId: string | null;
  status: 'firing' | 'resolved';
  value: number;
  threshold: number;
  message: string;
  triggeredAt: string;
  resolvedAt: string | null;
  acknowledged: boolean;
}

export interface AlertConfig {
  rules: AlertRule[];
  cooldownMinutes: number; // jangan re-alert dalam N menit (default 15)
  webhookUrl: string | null; // Slack/Discord/Telegram webhook
  enabled: boolean;
}

const DEFAULT_CONFIG: AlertConfig = {
  rules: [
    { name: 'requests_per_minute', label: 'High Request Rate', description: 'Requests per minute across all projects', threshold: 1000, unit: 'req/min', enabled: true },
    { name: 'bandwidth_per_minute_mb', label: 'High Bandwidth', description: 'Bandwidth per minute across all projects', threshold: 500, unit: 'MB/min', enabled: true },
    { name: 'error_rate_percent', label: 'High Error Rate', description: 'HTTP 4xx/5xx responses as percentage', threshold: 10, unit: '%', enabled: true },
    { name: 'disk_usage_percent', label: 'High Disk Usage', description: 'Disk usage of data directory', threshold: 85, unit: '%', enabled: true },
  ],
  cooldownMinutes: 15,
  webhookUrl: null,
  enabled: false, // OFF by default — opt-in
};

// ─── Config CRUD ──────────────────────────────────────────────────────────────

function initAlertTables(): void {
  const db = getPlatformDb();
  db.exec(`CREATE TABLE IF NOT EXISTS _platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS _alerts (
      id           TEXT PRIMARY KEY,
      rule         TEXT NOT NULL,
      project_id   TEXT,
      status       TEXT NOT NULL DEFAULT 'firing',
      value        REAL NOT NULL,
      threshold    REAL NOT NULL,
      message      TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      resolved_at  TEXT,
      acknowledged INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_status ON _alerts (status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_rule ON _alerts (rule, triggered_at DESC)`);
}

export function getAlertConfig(): AlertConfig {
  initAlertTables();
  const db = getPlatformDb();
  const row = db
    .prepare("SELECT value FROM _platform_settings WHERE key = 'alerts'")
    .get() as { value: string } | undefined;
  if (!row) return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); // deep copy
  try {
    const parsed = JSON.parse(row.value) as AlertConfig;
    return {
      rules: parsed.rules ?? DEFAULT_CONFIG.rules,
      cooldownMinutes: parsed.cooldownMinutes ?? 15,
      webhookUrl: parsed.webhookUrl ?? null,
      enabled: parsed.enabled ?? false,
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

export function setAlertConfig(config: Partial<AlertConfig>): void {
  initAlertTables();
  const current = getAlertConfig();
  const merged: AlertConfig = {
    rules: config.rules ?? current.rules,
    cooldownMinutes: config.cooldownMinutes ?? current.cooldownMinutes,
    webhookUrl: config.webhookUrl !== undefined ? config.webhookUrl : current.webhookUrl,
    enabled: config.enabled ?? current.enabled,
  };
  const db = getPlatformDb();
  db.prepare(
    `INSERT INTO _platform_settings (key, value) VALUES ('alerts', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(merged));
}

// ─── Alert CRUD ───────────────────────────────────────────────────────────────

function createAlert(alert: Omit<AlertRecord, 'id'>): AlertRecord {
  const db = getPlatformDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO _alerts (id, rule, project_id, status, value, threshold, message, triggered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, alert.rule, alert.projectId, alert.status, alert.value, alert.threshold, alert.message, alert.triggeredAt);

  return { ...alert, id };
}

function resolveAlert(id: string): void {
  const db = getPlatformDb();
  db.prepare(
    `UPDATE _alerts SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'firing'`
  ).run(new Date().toISOString(), id);
}

/** M33u: manual resolve dari admin route — dulu endpoint /resolve hanya
 *  memanggil acknowledgeAlert (flag saja) dan status tidak pernah berubah. */
export function resolveAlertManually(id: string): boolean {
  initAlertTables();
  const db = getPlatformDb();
  const result = db
    .prepare(
      `UPDATE _alerts SET status = 'resolved', resolved_at = ?, acknowledged = 1
       WHERE id = ? AND status = 'firing'`
    )
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function listAlerts(limit = 50, status?: 'firing' | 'resolved'): AlertRecord[] {
  initAlertTables();
  const db = getPlatformDb();
  const sql = status
    ? 'SELECT * FROM _alerts WHERE status = ? ORDER BY triggered_at DESC LIMIT ?'
    : 'SELECT * FROM _alerts ORDER BY triggered_at DESC LIMIT ?';
  const params = status ? [status, limit] : [limit];
  const rows = db.prepare(sql).all(...(params as never[])) as unknown as Array<{
    id: string; rule: string; project_id: string | null; status: string;
    value: number; threshold: number; message: string; triggered_at: string;
    resolved_at: string | null; acknowledged: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    rule: r.rule as AlertRuleName,
    projectId: r.project_id,
    status: r.status as 'firing' | 'resolved',
    value: r.value,
    threshold: r.threshold,
    message: r.message,
    triggeredAt: r.triggered_at,
    resolvedAt: r.resolved_at,
    acknowledged: r.acknowledged === 1,
  }));
}

export function acknowledgeAlert(id: string): boolean {
  initAlertTables();
  const db = getPlatformDb();
  const result = db.prepare('UPDATE _alerts SET acknowledged = 1 WHERE id = ?').run(id);
  return result.changes > 0;
}

// ─── Notification (webhook) ─────────────────────────────────────────────────

async function sendWebhookNotification(url: string, alert: AlertRecord): Promise<boolean> {
  try {
    const payload = {
      text: `🚨 BaseForge Alert: ${alert.message}`,
      attachments: [
        {
          color: alert.status === 'firing' ? 'danger' : 'good',
          fields: [
            { title: 'Rule', value: alert.rule, short: true },
            { title: 'Status', value: alert.status, short: true },
            { title: 'Value', value: `${alert.value}`, short: true },
            { title: 'Threshold', value: `${alert.threshold}`, short: true },
            { title: 'Project', value: alert.projectId ?? 'platform-wide', short: true },
            { title: 'Time', value: alert.triggeredAt, short: true },
          ],
        },
      ],
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    console.error('[monitor] webhook notification failed:', err);
    return false;
  }
}

// ─── Check Engine ─────────────────────────────────────────────────────────────

interface CheckContext {
  requestsLastMinute: number;
  bandwidthLastMinuteBytes: number;
  errorRatePercent: number;
  diskUsagePercent: number;
}

/** Kumpulkan metric real-time untuk evaluasi. */
function collectMetrics(): CheckContext {
  // Ambil stats hari ini dari semua project
  const projects = listProjects();
  let totalRequests = 0;
  let totalBytesOut = 0;

  for (const project of projects) {
    try {
      const stats = getProjectStats(project.id);
      totalRequests += stats.today.requests;
      totalBytesOut += stats.today.bytesOut;
    } catch { /* project DB mungkin belum ada */ }
  }

  // Disk usage (best-effort, Windows/Linux)
  let diskUsagePercent = 0;
  try {
    const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), '..', 'data');
    // Simple approximation: check if we can stat the directory
    // For production, would use statfs — but node:fs doesn't have statfs sync
    // This is a placeholder that always returns 0 (no disk monitoring in v1)
    diskUsagePercent = 0;
  } catch { diskUsagePercent = 0; }

  return {
    requestsLastMinute: totalRequests, // approximate: total today (not truly per-minute)
    bandwidthLastMinuteBytes: totalBytesOut,
    errorRatePercent: 0, // v1: not tracked (would need per-request status logging)
    diskUsagePercent,
  };
}

/** Evaluasi semua rule terhadap metric saat ini. Return daftar alert yang di-trigger/resolved. */
export async function runMonitorCheck(): Promise<{ triggered: AlertRecord[]; resolved: AlertRecord[] }> {
  const config = getAlertConfig();
  if (!config.enabled) return { triggered: [], resolved: [] };

  const ctx = collectMetrics();
  const triggered: AlertRecord[] = [];
  const resolvedList: AlertRecord[] = [];
  const now = new Date();

  for (const rule of config.rules) {
    if (!rule.enabled) continue;

    let value = 0;
    switch (rule.name) {
      case 'requests_per_minute': value = ctx.requestsLastMinute; break;
      case 'bandwidth_per_minute_mb': value = ctx.bandwidthLastMinuteBytes / (1024 * 1024); break;
      case 'error_rate_percent': value = ctx.errorRatePercent; break;
      case 'disk_usage_percent': value = ctx.diskUsagePercent; break;
    }

    const isBreaching = value > rule.threshold;

    // Cek apakah sudah ada alert "firing" untuk rule ini
    const firing = listAlerts(1, 'firing').find((a) => a.rule === rule.name);

    if (isBreaching && !firing) {
      // TRIGGER: buat alert baru
      const alert = createAlert({
        rule: rule.name,
        projectId: null,
        status: 'firing',
        value,
        threshold: rule.threshold,
        message: `${rule.label}: ${value.toFixed(1)}${rule.unit} exceeds threshold ${rule.threshold}${rule.unit}`,
        triggeredAt: now.toISOString(),
        resolvedAt: null,
        acknowledged: false,
      });
      triggered.push(alert);

      // Notify webhook
      if (config.webhookUrl) {
        void sendWebhookNotification(config.webhookUrl, alert);
      }

      console.warn(`[monitor] ALERT FIRED: ${alert.message}`);
    } else if (!isBreaching && firing) {
      // RESOLVE: tandai alert firing sebagai resolved
      resolveAlert(firing.id);
      const resolved = { ...firing, status: 'resolved' as const, resolvedAt: now.toISOString() };
      resolvedList.push(resolved);

      if (config.webhookUrl) {
        void sendWebhookNotification(config.webhookUrl, resolved);
      }

      console.log(`[monitor] ALERT RESOLVED: ${firing.message}`);
    } else if (isBreaching && firing) {
      // Sudah firing — update value (tapi jangan re-alert dalam cooldown)
      const triggeredAt = new Date(firing.triggeredAt);
      const minutesSince = (now.getTime() - triggeredAt.getTime()) / 60000;
      if (minutesSince >= config.cooldownMinutes) {
        // Cooldown lewat → re-alert (update value di alert yang sama)
        // Untuk v1: cukup log, tidak re-notify
        console.warn(`[monitor] ALERT STILL FIRING (${minutesSince.toFixed(0)}min): ${firing.message}`);
      }
    }
  }

  return { triggered, resolved: resolvedList };
}

/** Manual test alert (dipanggil dari admin API). */
export async function testAlert(ruleName?: AlertRuleName): Promise<AlertRecord> {
  const config = getAlertConfig();
  const rule = ruleName
    ? config.rules.find((r) => r.name === ruleName) ?? config.rules[0]
    : config.rules[0];

  const alert = createAlert({
    rule: rule.name,
    projectId: null,
    status: 'firing',
    value: rule.threshold + 1, // fake value di atas threshold
    threshold: rule.threshold,
    message: `[TEST] ${rule.label}: simulated value ${rule.threshold + 1}${rule.unit} (threshold: ${rule.threshold}${rule.unit})`,
    triggeredAt: new Date().toISOString(),
    resolvedAt: null,
    acknowledged: false,
  });

  if (config.webhookUrl) {
    await sendWebhookNotification(config.webhookUrl, alert);
  }

  return alert;
}

// ─── Scheduler loop ───────────────────────────────────────────────────────────

class MonitorScheduler {
  private timer: NodeJS.Timeout | null = null;
  public lastCheck: { time: string; triggered: number; resolved: number } | null = null;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        const result = await runMonitorCheck();
        this.lastCheck = {
          time: new Date().toISOString(),
          triggered: result.triggered.length,
          resolved: result.resolved.length,
        };
      } catch (err) {
        console.error('[monitor] check error:', err);
      }
    }, 30_000);
    this.timer.unref?.();
    console.log('[monitor] started (checking every 30s)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[monitor] stopped');
    }
  }
}

export const monitorScheduler = new MonitorScheduler();
