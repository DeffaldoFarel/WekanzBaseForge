// ============================================================================
// LIFECYCLE & GRACEFUL SHUTDOWN — Penutupan server yang bersih & aman
//
// Menjamin saat proses menerima sinyal SIGTERM (systemd restart/stop, docker stop)
// atau SIGINT (Ctrl+C di terminal):
//   1. HTTP server berhenti menerima koneksi baru (server.close).
//   2. Seluruh background schedulers & timers dihentikan (scheduler, backup, monitor, cleanup).
//   3. Buffer in-memory di-flush ke disk (metrics, API key usage).
//   4. PRAGMA wal_checkpoint(PASSIVE) dijalankan dan semua koneksi DB ditutup.
//   5. Proses keluar dengan exit code 0 (dengan timeout pelindung jika macet).
// ============================================================================

import type http from 'node:http';
import { flushMetrics } from './metrics.js';
import { flushApiKeyUsage } from '../auth/apiKeys.js';
import { closeAllProjectDbs, getProjectDb } from './projectDbManager.js';
import { closePlatformDb } from './platformDb.js';

export interface Schedulable {
  stop: () => void;
}

export interface ShutdownResources {
  server?: http.Server;
  schedulers?: Schedulable[];
  timers?: (NodeJS.Timeout | undefined | null)[];
}

export interface ShutdownOptions {
  timeoutMs?: number;
  exitProcess?: boolean;
}

let isShuttingDown = false;

/**
 * Menjalankan urutan graceful shutdown secara teratur.
 */
export async function gracefulShutdown(
  resources: ShutdownResources = {},
  opts: ShutdownOptions = {}
): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const exitProcess = opts.exitProcess ?? true;

  console.log('\n[shutdown] Graceful shutdown initiated...');

  // Fallback force-exit jika proses shutdown terganjal IO macet
  let forceTimer: NodeJS.Timeout | null = null;
  if (exitProcess) {
    forceTimer = setTimeout(() => {
      console.error(`[shutdown] Timeout (${timeoutMs}ms) exceeded, forcing exit.`);
      process.exit(1);
    }, timeoutMs);
    forceTimer.unref?.();
  }

  try {
    // 1. Tutup HTTP server (tolak koneksi baru, biarkan in-flight request tuntas)
    if (resources.server && resources.server.listening) {
      await new Promise<void>((resolve) => {
        resources.server!.close((err) => {
          if (err) {
            console.error('[shutdown] error closing HTTP server:', err.message);
          } else {
            console.log('[shutdown] HTTP server closed');
          }
          resolve();
        });
      });
    }

    // 2. Hentikan seluruh scheduler & background interval
    if (resources.schedulers) {
      for (const s of resources.schedulers) {
        try {
          s.stop();
        } catch (e) {
          console.error('[shutdown] error stopping scheduler:', e);
        }
      }
    }

    if (resources.timers) {
      for (const t of resources.timers) {
        if (t) clearInterval(t);
      }
    }

    // 3. Flush semua buffer in-memory ke database SQLite
    try {
      const flushedMetrics = flushMetrics();
      if (flushedMetrics > 0) {
        console.log(`[shutdown] flushed ${flushedMetrics} metrics entries to platform.db`);
      }
    } catch (e) {
      console.error('[shutdown] error flushing metrics:', e);
    }

    try {
      const flushedKeys = flushApiKeyUsage((pid) => {
        try {
          return getProjectDb(pid);
        } catch {
          return null;
        }
      });
      if (flushedKeys > 0) {
        console.log(`[shutdown] flushed ${flushedKeys} API key usage entries`);
      }
    } catch (e) {
      console.error('[shutdown] error flushing api key usage:', e);
    }

    // 4. Tutup koneksi database project & platform
    try {
      closeAllProjectDbs();
      closePlatformDb();
      console.log('[shutdown] all database handles closed safely');
    } catch (e) {
      console.error('[shutdown] error closing databases:', e);
    }

    console.log('[shutdown] Graceful shutdown completed cleanly.');
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
    if (exitProcess) {
      process.exit(0);
    }
  }
}

/**
 * Daftarkan listener sinyal OS (SIGTERM & SIGINT).
 */
export function registerShutdownHandlers(
  server: http.Server,
  resources: Omit<ShutdownResources, 'server'> = {}
): void {
  const fullResources: ShutdownResources = { ...resources, server };

  const onSignal = (signal: string) => {
    console.log(`[shutdown] Received ${signal}`);
    void gracefulShutdown(fullResources, { exitProcess: true });
  };

  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
}

/** Reset flag untuk keperluan test */
export function resetShutdownStateForTests(): void {
  isShuttingDown = false;
}
