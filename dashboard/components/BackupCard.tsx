"use client";

// ============================================================================
// M32: BACKUP CARD — panel backup di halaman overview project
//
// Sebelumnya seluruh fitur M32 (config jadwal, trigger manual, list,
// download) hanya bisa via curl — dashboard tidak punya pintu sama sekali.
// Panel ini menampilkan: status jadwal, konfigurasi (daily/weekly/off +
// retention), tombol "Backup Now", dan daftar backup dengan download.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import {
  listBackups,
  setBackupConfig,
  resetBackupConfig,
  runBackup,
  downloadBackup,
  formatBytes,
  type BackupConfig,
  type BackupInfo,
} from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToasts, ToastHost } from "@/components/ui/toast";
import {
  Archive,
  Download,
  RefreshCw,
  CalendarClock,
  Database,
  Table2,
  Loader2,
  Pencil,
  X,
  Check,
} from "lucide-react";

const SCHEDULE_LABEL: Record<BackupConfig["schedule"], string> = {
  off: "Off (manual only)",
  daily: "Daily (00:00 UTC)",
  weekly: "Weekly (Sunday 00:00 UTC)",
};

// Timestamp backup berformat filename-safe: 2026-09-20T18-17-27-249Z
// (bukan ISO valid — ':' dan '.' diganti '-'). Parse manual; fallback tampilkan mentah.
function formatBackupTimestamp(ts: string): string {
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (m) {
    const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return ts;
}

export function BackupCard({ projectId }: { projectId: string }) {
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // edit config state
  const [editing, setEditing] = useState(false);
  const [editSchedule, setEditSchedule] = useState<BackupConfig["schedule"]>("off");
  const [editRetention, setEditRetention] = useState("7");
  const [savingConfig, setSavingConfig] = useState(false);

  const { toasts, success: toastSuccess, error: toastError, dismiss } = useToasts();

  const load = useCallback(async () => {
    try {
      const res = await listBackups(projectId);
      setConfig(res.config);
      setBackups(res.backups);
      setTotalSize(res.totalSize);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to load backups");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Refresh manual dari tombol — terpisah dari `load` supaya bisa memberi
  // spinner tanpa mengganggu state loading awal (yang memakai skeleton besar).
  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await listBackups(projectId);
      setConfig(res.config);
      setBackups(res.backups);
      setTotalSize(res.totalSize);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to load backups");
    } finally {
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refreshing]);

  useEffect(() => {
    load();
  }, [load]);

  function startEdit() {
    if (!config) return;
    setEditSchedule(config.schedule);
    setEditRetention(String(config.retention));
    setEditing(true);
  }

  async function handleSaveConfig() {
    const retention = parseInt(editRetention, 10);
    if (Number.isNaN(retention) || retention < 1 || retention > 30) {
      toastError("Retention must be between 1 and 30.");
      return;
    }
    setSavingConfig(true);
    try {
      await setBackupConfig(projectId, { schedule: editSchedule, retention });
      toastSuccess(
        editSchedule === "off"
          ? "Scheduled backups turned off."
          : `Backup schedule set to ${editSchedule} (keep last ${retention}).`
      );
      setEditing(false);
      load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to save config");
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleRun() {
    setRunning(true);
    try {
      const info = await runBackup(projectId);
      toastSuccess(`Backup created: ${info.filename} (${formatBytes(info.size)}, ${info.recordCount} records).`);
      load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Backup failed");
    } finally {
      setRunning(false);
    }
  }

  async function handleDownload(filename: string) {
    setDownloading(filename);
    try {
      await downloadBackup(projectId, filename);
      toastSuccess(`Downloading ${filename}`);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <Card className="p-6 mb-8">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-secondary flex items-center justify-center border border-border">
            <Archive className="w-4 h-4 text-muted-foreground" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">Backups</h2>
            <p className="text-xs text-muted-foreground">
              SQLite snapshots (VACUUM INTO) — point-in-time recovery for this project.
            </p>
          </div>
        </div>
        <Button onClick={handleRun} disabled={running} size="sm" className="gap-1.5">
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
          <span>{running ? "Creating…" : "Backup Now"}</span>
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading backups…</p>
      ) : (
        <>
          {/* Schedule config */}
          <div className="bg-muted rounded-lg p-3.5 mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <CalendarClock className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm text-foreground font-medium">Schedule</span>
              {config && (
                <Badge variant={config.schedule === "off" ? "secondary" : "green"} className="text-[11px]">
                  {SCHEDULE_LABEL[config.schedule]}
                </Badge>
              )}
              {config && config.schedule !== "off" && (
                <span className="text-xs text-muted-foreground">
                  · keeps last {config.retention} {config.retention === 1 ? "backup" : "backups"}
                </span>
              )}
              <span className="flex-1" />
              {!editing ? (
                <Button variant="ghost" size="sm" onClick={startEdit} className="gap-1.5">
                  <Pencil className="w-3.5 h-3.5" />
                  <span>Configure</span>
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)} className="gap-1.5">
                  <X className="w-3.5 h-3.5" />
                  <span>Cancel</span>
                </Button>
              )}
            </div>

            {editing && (
              <div className="flex items-end gap-3 mt-3 flex-wrap">
                <div className="space-y-1.5">
                  <Label htmlFor="bk-schedule" className="text-xs">Frequency</Label>
                  <select
                    id="bk-schedule"
                    value={editSchedule}
                    onChange={(e) => setEditSchedule(e.target.value as BackupConfig["schedule"])}
                    className="h-9 px-3 rounded-md bg-secondary border border-border text-sm text-foreground cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="off">Off</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="bk-retention" className="text-xs">Keep last N backups (1–30)</Label>
                  <Input
                    id="bk-retention"
                    type="number"
                    min={1}
                    max={30}
                    value={editRetention}
                    onChange={(e) => setEditRetention(e.target.value)}
                    className="h-9 w-28"
                  />
                </div>
                <Button size="sm" onClick={handleSaveConfig} disabled={savingConfig} className="gap-1.5">
                  {savingConfig ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>{savingConfig ? "Saving…" : "Save"}</span>
                </Button>
              </div>
            )}
          </div>

          {/* Backup list */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">
              {backups.length === 0
                ? "No backups yet"
                : `${backups.length} ${backups.length === 1 ? "backup" : "backups"} · ${formatBytes(totalSize)} total`}
            </span>
          <Button variant="ghost" size="sm" onClick={refresh} title="Refresh list" disabled={refreshing}>
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </Button>

          </div>

          {backups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No backups yet. Press <strong>Backup Now</strong> to create the first snapshot.
            </p>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {backups.map((b) => (
                <div
                  key={b.filename}
                  className="bg-muted border border-border rounded-md p-2.5 text-xs flex items-center gap-2 flex-wrap"
                >
                  <Database className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span className="font-mono text-foreground">{b.filename}</span>
                  <span className="text-muted-foreground">{formatBytes(b.size)}</span>
                  <span className="text-border">·</span>
                  <span className="text-muted-foreground flex items-center gap-1" title="Collections · Records">
                    <Table2 className="w-3 h-3" />
                    {b.collectionCount} · {b.recordCount} records
                  </span>
                  <span className="flex-1" />
                  <span className="text-muted-foreground text-[10px]">
                    {formatBackupTimestamp(b.timestamp)}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleDownload(b.filename)}
                    disabled={downloading === b.filename}
                    className="gap-1 h-7"
                  >
                    {downloading === b.filename ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Download className="w-3 h-3" />
                    )}
                    <span>Download</span>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </Card>
  );
}
