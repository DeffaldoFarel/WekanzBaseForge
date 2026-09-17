// ============================================================================
// M15c: SCHEDULER — loop 30 detik + anti double-fire
//
// Singleton di proses server:
//   setInterval(30s):
//     untuk tiap function enabled dengan schedule:
//       cronMatches(schedule, now) && belum jalan di menit ini
//       → run sandbox dengan req = { scheduled: true, time }
//
// SEMANTIK (diakui jujur di jurnal):
// - At-most-once: satu menit = maksimal 1 run per function.
//   Restart di tengah menit TIDAK me-run ulang (miss = miss).
// - Interval 30s → tiap menit dicek 2x → tidak ada menit terlewat.
// ============================================================================

import { listFunctions, StoredFunction } from './functionsStore.js';
import { cronMatches, cronMatchesInTimezone } from './cronParser.js';
import { runFunctionCode, FunctionRunResult } from './functionRunner.js';
import type { DatabaseSync } from 'node:sqlite';

const CHECK_INTERVAL_MS = 30_000;

class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastRunMinute = new Map<string, string>(); // `${dbName}:${minuteKey}` -> run marker per function+menit
  private dbProviders: (() => DatabaseSync)[] = [];
  // Log run terakhir per function (observability + test)
  public lastRuns = new Map<string, { time: string; ok: boolean; error?: string; durationMs: number }>();

  // Dipanggil dari index.ts: provider untuk SETIAP project DB aktif
  start(dbProviders: (() => DatabaseSync)[]): void {
    if (this.timer) return; // sudah jalan
    this.dbProviders = dbProviders;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        console.error('[scheduler] tick error:', err);
      }
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.(); // jangan tahan proses saat shutdown
    console.log('[scheduler] started (checking every 30s)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[scheduler] stopped');
    }
  }

  private minuteKey(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private tick(): void {
    const now = new Date();
    const minuteKey = this.minuteKey(now);

    for (const provider of this.dbProviders) {
      let functions: StoredFunction[];
      try {
        functions = listFunctions(provider());
      } catch {
        continue; // DB project belum siap — coba menit depan
      }

      for (const fn of functions) {
        if (!fn.enabled || !fn.schedule) continue;

        // Anti double-fire: function+menit hanya sekali (lintas project aman
        // karena nama function unique per project dan provider diperulang)
        const runKey = `${fn.id}:${minuteKey}`;
        if (this.lastRunMinute.has(runKey)) continue;

        // M39: evaluasi cron dalam timezone function (default UTC)
        // fn.timezone = IANA name (e.g. "Asia/Jakarta") — Intl.DateTimeFormat
        // handle DST otomatis, tidak perlu hard-coded offset
        const matches = fn.timezone && fn.timezone !== 'UTC'
          ? cronMatchesInTimezone(fn.schedule, now, fn.timezone)
          : cronMatches(fn.schedule, now);
        if (!matches) continue;

        // Tandai SEBELUM run — kalau crash, tetap tidak diulang menit ini
        this.lastRunMinute.set(runKey, minuteKey);
        this.runScheduled(fn, now);

        // Cegah Map tumbuh tanpa batas: buang run key lama (> 2 menit)
        if (this.lastRunMinute.size > 1000) {
          for (const key of this.lastRunMinute.keys()) {
            if (!key.endsWith(minuteKey)) this.lastRunMinute.delete(key);
          }
        }
      }
    }
  }

  private runScheduled(fn: StoredFunction, now: Date): void {
    // M18a: isolated-vm runner ASYNC — run di-background (scheduler tidak
    // menunggu; anti double-fire sudah menandai SEBELUM run)
    void runFunctionCode(fn.code, {
      timeoutMs: fn.timeoutMs,
      maxLogs: 50,
      httpAllow: fn.httpAllow, // M25
      scheduledContext: { time: now.toISOString() },
    })
      .then((result: FunctionRunResult) => {
        this.lastRuns.set(fn.name, {
          time: now.toISOString(),
          ok: result.ok,
          error: result.error,
          durationMs: result.durationMs,
        });

        if (!result.ok) {
          console.error(`[cron:${fn.name}] FAILED (${result.durationMs}ms): ${result.error}`);
        } else if (result.logs.length > 0) {
          console.log(`[cron:${fn.name}] (${result.durationMs}ms) ${result.logs.join(' | ')}`);
        } else {
          console.log(`[cron:${fn.name}] ok (${result.durationMs}ms)`);
        }
      })
      .catch((err) => {
        console.error(`[cron:${fn.name}] unexpected error:`, err);
      });
  }

  // Untuk test: paksa tick manual (bukan menunggu 30s)
  forceTick(): void {
    this.tick();
  }

  // Untuk test: reset anti double-fire
  resetRunHistory(): void {
    this.lastRunMinute.clear();
    this.lastRuns.clear();
  }
}

export const scheduler = new Scheduler();
