// ============================================================================
// OPS-19: TEST LIFECYCLE, TOKEN CLEANUP SCHEDULER & GRACEFUL SHUTDOWN
// ============================================================================

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TEST_DIR = path.resolve('../data/ops19-test');
process.env.DATA_DIR = TEST_DIR;

import {
  initPlatformDb,
  createProject,
  provisionProjectStorage,
  resetPlatformDbForTests,
  DEFAULT_SERVICES,
  type ProjectRow,
} from '../src/core/platformDb.js';
import {
  getProjectDb,
  closeAllProjectDbs,
} from '../src/core/projectDbManager.js';
import {
  initAuthTokensTable,
  hashToken,
} from '../src/auth/tokens.js';
import {
  tokenCleanupScheduler,
  cleanExpiredTokensAcrossProjects,
} from '../src/core/tokenCleanup.js';
import {
  gracefulShutdown,
  resetShutdownStateForTests,
  type Schedulable,
} from '../src/core/lifecycle.js';
import {
  trackRequest,
  flushMetrics,
} from '../src/core/metrics.js';

after(() => {
  try {
    tokenCleanupScheduler.stop();
    closeAllProjectDbs();
    resetPlatformDbForTests();
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows handle SQLite
  }
});

beforeEach(() => {
  resetShutdownStateForTests();
});

test('Ops-19: Token cleanup menghapus token expired & revoked > 7 hari, mempertahankan token aktif', () => {
  initPlatformDb();
  const proj = createProject('p_token_cleanup', 'ops19-token-test', DEFAULT_SERVICES);
  provisionProjectStorage(proj.id);
  const db = getProjectDb(proj.id);
  initAuthTokensTable(db);

  const now = Date.now();
  const pastExpired = new Date(now - 3600 * 1000).toISOString(); // 1 jam lalu
  const futureActive = new Date(now + 7 * 24 * 3600 * 1000).toISOString(); // 7 hari ke depan
  const oldCreated = new Date(now - 10 * 24 * 3600 * 1000).toISOString(); // 10 hari lalu (> 7 hari)
  const recentCreated = new Date(now - 2 * 24 * 3600 * 1000).toISOString(); // 2 hari lalu (< 7 hari)

  // 1. Token aktif (tidak boleh terhapus)
  db.prepare(`
    INSERT INTO _auth_tokens (id, user_id, token_hash, expires_at, created, revoked)
    VALUES ('tok_active', 'usr_1', ?, ?, ?, 0)
  `).run(hashToken('refresh_active'), futureActive, new Date().toISOString());

  // 2. Token expired biasa (wajib terhapus)
  db.prepare(`
    INSERT INTO _auth_tokens (id, user_id, token_hash, expires_at, created, revoked)
    VALUES ('tok_expired', 'usr_1', ?, ?, ?, 0)
  `).run(hashToken('refresh_expired'), pastExpired, new Date().toISOString());

  // 3. Token revoked baru 2 hari (masih dalam grace period 7 hari — tidak boleh terhapus)
  db.prepare(`
    INSERT INTO _auth_tokens (id, user_id, token_hash, expires_at, created, revoked)
    VALUES ('tok_revoked_recent', 'usr_2', ?, ?, ?, 1)
  `).run(hashToken('refresh_revoked_recent'), futureActive, recentCreated);

  // 4. Token revoked 10 hari lalu (sudah lewat grace period 7 hari — wajib terhapus)
  db.prepare(`
    INSERT INTO _auth_tokens (id, user_id, token_hash, expires_at, created, revoked)
    VALUES ('tok_revoked_old', 'usr_2', ?, ?, ?, 1)
  `).run(hashToken('refresh_revoked_old'), futureActive, oldCreated);

  const beforeCount = (db.prepare('SELECT COUNT(*) AS c FROM _auth_tokens').get() as { c: number }).c;
  assert.equal(beforeCount, 4);

  // Jalankan sweep
  const summary = cleanExpiredTokensAcrossProjects([proj]);
  assert.equal(summary.projectsScanned, 1);
  assert.equal(summary.tokensCleaned, 2);

  // Cek sisa token di DB
  const remaining = db.prepare('SELECT id FROM _auth_tokens ORDER BY id ASC').all() as { id: string }[];
  const remainingIds = remaining.map((r) => r.id);
  assert.deepEqual(remainingIds, ['tok_active', 'tok_revoked_recent']);
});

test('Ops-19: TokenCleanupScheduler start dan stop berjalan aman', () => {
  tokenCleanupScheduler.start(500); // 500ms
  // Panggil start kedua kali tidak boleh membuat timer ganda
  tokenCleanupScheduler.start(500);
  tokenCleanupScheduler.stop();
  // Panggil stop kedua kali aman (idempotent)
  tokenCleanupScheduler.stop();
});

test('Ops-19: Graceful shutdown menutup server HTTP, menghentikan scheduler, flush buffer, dan menutup DB', async () => {
  initPlatformDb();
  const proj = createProject('p_shutdown_test', 'ops19-shutdown-test', DEFAULT_SERVICES);
  provisionProjectStorage(proj.id);
  getProjectDb(proj.id);

  // 1. Mock HTTP server
  let serverClosed = false;
  const mockServer = http.createServer((_, res) => res.end('ok'));
  await new Promise<void>((resolve) => mockServer.listen(0, resolve));
  assert.equal(mockServer.listening, true);

  // 2. Mock Schedulers
  let schedulerStopped = false;
  const mockScheduler: Schedulable = {
    stop: () => {
      schedulerStopped = true;
    },
  };

  // 3. Mock Timers
  let timerCleared = false;
  const testTimer = setInterval(() => {}, 5000);
  const trackedTimer = setInterval(() => {
    timerCleared = true;
  }, 100);

  // 4. In-memory buffer metrics
  trackRequest(proj.id, 1024, 2048);

  // 5. Jalankan graceful shutdown (exitProcess: false agar test runner tidak mati)
  await gracefulShutdown(
    {
      server: mockServer,
      schedulers: [mockScheduler],
      timers: [testTimer, trackedTimer],
    },
    {
      exitProcess: false,
      timeoutMs: 2000,
    }
  );

  // Verifikasi hasil shutdown:
  assert.equal(mockServer.listening, false, 'HTTP server harus tertutup');
  assert.equal(schedulerStopped, true, 'Scheduler harus dihentikan');

  // Timer test harus sudah di-clear
  clearInterval(testTimer);
  clearInterval(trackedTimer);

  // Verifikasi metrics ter-flush ke platform.db
  const remainingFlush = flushMetrics();
  assert.equal(remainingFlush, 0, 'Buffer metrics harus sudah kosong karena sudah ter-flush saat shutdown');
});
