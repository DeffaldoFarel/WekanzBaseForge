// ============================================================================
// TOKEN CLEANUP SCHEDULER — Pembersihan token expired & revoked berkala
//
// Sesi login menerbitkan access token (JWT) dan refresh token (disimpan di
// tabel _auth_tokens per project). Setiap refresh atau logout mengubah status
// token (revoked = 1 atau digantikan pasangan baru). Tanpa pembersihan berkala,
// baris _auth_tokens akan menumpuk selamanya di SQLite tiap project.
//
// Scheduler ini menyapu seluruh project secara berkala (default: 1 jam):
// - Menghapus token yang sudah lewat tanggal expires_at
// - Menghapus token yang sudah di-revoke dan berumur > 7 hari (grace period)
// ============================================================================

import { listProjects, type ProjectRow } from './platformDb.js';
import { getProjectDb } from './projectDbManager.js';
import { cleanupExpiredTokens } from '../auth/tokens.js';

export interface TokenCleanupSummary {
  projectsScanned: number;
  tokensCleaned: number;
  durationMs: number;
}

/**
 * Menyapu dan menghapus token expired & revoked di semua project yang terdaftar.
 */
export function cleanExpiredTokensAcrossProjects(
  customProjects?: ProjectRow[]
): TokenCleanupSummary {
  const start = Date.now();
  let projects: ProjectRow[];
  try {
    projects = customProjects ?? listProjects();
  } catch {
    projects = [];
  }

  let tokensCleaned = 0;
  let projectsScanned = 0;

  for (const p of projects) {
    try {
      const db = getProjectDb(p.id);
      // Cek apakah tabel _auth_tokens ada pada project ini
      const tableExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_auth_tokens'")
        .get();
      if (!tableExists) continue;

      projectsScanned++;
      const cleaned = cleanupExpiredTokens(db);
      tokensCleaned += cleaned;
    } catch {
      // Abaikan bila project belum diinisialisasi atau file DB sedang tidak tersedia
    }
  }

  return {
    projectsScanned,
    tokensCleaned,
    durationMs: Date.now() - start,
  };
}

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 jam

export class TokenCleanupScheduler {
  private timer: NodeJS.Timeout | null = null;

  start(intervalMs = DEFAULT_CLEANUP_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        const summary = cleanExpiredTokensAcrossProjects();
        if (summary.tokensCleaned > 0) {
          console.log(
            `[token-cleanup] swept ${summary.tokensCleaned} expired tokens across ${summary.projectsScanned} projects (${summary.durationMs}ms)`
          );
        }
      } catch (err) {
        console.error('[token-cleanup] sweep failed:', err);
      }
    }, intervalMs);
    this.timer.unref?.();
    console.log(`[token-cleanup] started (running every ${Math.round(intervalMs / 60000)}m)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[token-cleanup] stopped');
    }
  }

  /** Jalankan sweep langsung (untuk test / manual invoke) */
  runNow(customProjects?: ProjectRow[]): TokenCleanupSummary {
    return cleanExpiredTokensAcrossProjects(customProjects);
  }
}

export const tokenCleanupScheduler = new TokenCleanupScheduler();
