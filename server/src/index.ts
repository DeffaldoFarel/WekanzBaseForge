// ============================================================================
// WekanzBaseForge — Entry Point
//
// M00: Platform Shell
//  - HTTP server dari node:http (tanpa framework!)
//  - Router buatan sendiri
//  - Admin auth sederhana (env var + in-memory token)
//  - Project registry di platform.db
// ============================================================================

import http from 'node:http';
import { initPlatformDb } from './core/platformDb.js';
import { createAdminRouter } from './api/adminRoutes.js';
import { createDatabaseRouter } from './api/databaseRoutes.js';
import { createProjectAuthRouter } from './api/authRoutes.js';
import { createPublicRouter } from './api/publicRoutes.js';
import { createUserAdminRouter } from './api/userAdminRoutes.js';
import { createStorageRouter } from './api/storageRoutes.js';
import { createRealtimeRouter } from './api/realtimeRoutes.js';
import { createFunctionRouter } from './api/functionRoutes.js';
import { createOAuthRouter } from './api/oauthRoutes.js';
import { createEmailRouter } from './api/emailRoutes.js';
import { createStatsRouter } from './api/statsRoutes.js';
import { createApiKeyRouter } from './api/apiKeyRoutes.js';
import { createMfaRouter } from './api/mfaRoutes.js';
import { createWebhookRouter } from './api/webhookRoutes.js';
import { createStorageAdminRouter } from './api/storageAdminRoutes.js';
import { createBackupRouter } from './api/backupRoutes.js';
import { createMonitorRouter } from './api/monitorRoutes.js';
import { backupScheduler } from './core/backupScheduler.js';
import { monitorScheduler } from './core/monitor.js';
import { startMetricsFlusher } from './core/metrics.js';
import { flushApiKeyUsage } from './auth/apiKeys.js';
import { scheduler } from './core/scheduler.js';
import { Router, type Middleware } from './core/router.js';

const PORT = parseInt(process.env.PORT ?? '5100', 10);

// ─── Middleware logger sederhana ─────────────────────────────────────────────
// Mencatat setiap request yang masuk + berapa lama diproses.
const loggerMiddleware: Middleware = (req, res) => {
  const start = Date.now();
  res.raw.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} → ${res.raw.statusCode} (${duration}ms)`);
  });
  return true;
};

// ─── Middleware CORS (agar dashboard di port lain bisa mengakses) ────────────
// Saat development, dashboard Next.js jalan di :3000 dan server di :5100.
// Browser menolak lintas-origin kecuali server mengizinkan — itulah CORS.
const corsMiddleware: Middleware = (req, res) => {
  res.raw.setHeader('Access-Control-Allow-Origin', '*'); // dev only!
  res.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Browser mengirim OPTIONS "preflight" sebelum request non-sederhana
  if (req.method === 'OPTIONS') {
    res.status(204).json(null);
    return false; // berhenti di sini
  }
  return true;
};

async function main(): Promise<void> {
  // Inisialisasi database platform
  initPlatformDb();
  console.log('📦 Platform DB ready');

  // Susun router: gabungkan routes platform (M00) + database admin (M05u)
  // + project auth (M09u) + public records + rules admin (M11)
  const router = new Router();
  router.use(loggerMiddleware);
  router.use(corsMiddleware);
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createPublicRouter());
  router.merge(createUserAdminRouter()); // M10u: user management + rules
  router.merge(createStorageRouter()); // M14: file serving
  router.merge(createRealtimeRouter()); // M13: SSE realtime
  router.merge(createFunctionRouter()); // M15a: callable functions
  router.merge(createOAuthRouter()); // M10: OAuth2 login (Google/GitHub)
  router.merge(createEmailRouter()); // M23: email verification + password reset
  router.merge(createStatsRouter()); // M24: request & bandwidth stats
  router.merge(createApiKeyRouter()); // M26: per-project API keys (admin CRUD)
  router.merge(createMfaRouter()); // M27: MFA/TOTP (enroll, challenge, admin reset)
  router.merge(createWebhookRouter()); // M28: webhooks (CRUD + test + deliveries)
  router.merge(createStorageAdminRouter()); // M30: storage backend config (local/S3)
  router.merge(createBackupRouter()); // M32: backup config + trigger + list + download
  router.merge(createMonitorRouter()); // M33: monitoring/alerting (config + alerts + test)

  // Buat HTTP server. Perhatikan betapa tipisnya lapisan ini:
  // server = terima koneksi → serahkan ke router → router memanggil handler.
  // Express pada dasarnya hanya ini + kenyamanan tambahan!
  const server = http.createServer((req, res) => {
    router.handle(req, res);
  });

  server.listen(PORT, () => {
    // M15c: scheduler cron — mulai setelah server listen (DB sudah siap).
    // dbProvider: scheduler membaca DB project pertama? TIDAK — function
    // milik tiap project. Untuk M15c v1: scheduler cek SEMUA project via
    // listProjectDbs. (Lihat scheduler.start menerima array provider.)
    console.log('');
    console.log('🛠️  WekanzBaseForge server running');
    console.log(`   → http://localhost:${PORT}`);
    console.log(`   → Health: http://localhost:${PORT}/api/health`);
    console.log('');
    scheduler.start(getProjectDbProviders());

    // M24: flush metrics buffer ke platform.db tiap 30 detik
    // M26: flush API key usage counter ke DB project masing-masing
    startMetricsFlusher(30_000);
    setInterval(() => {
      try {
        flushApiKeyUsage((pid) => {
          try {
            return getProjectDb(pid);
          } catch {
            return null;
          }
        });
      } catch (err) {
        console.error('[api-keys] usage flush failed:', err);
      }
    }, 30_000).unref?.();

    // M32: backup scheduler — cek tiap 30 detik, backup sesuai config per project
    backupScheduler.start();

    // M33: monitor scheduler — cek threshold tiap 30 detik, alert via webhook
    monitorScheduler.start();
  });
}

// M15c: scheduler butuh akses ke SEMUA project DB (function milik project)
import { listProjects } from './core/platformDb.js';
import { getProjectDb } from './core/projectDbManager.js';
import type { DatabaseSync } from 'node:sqlite';

function getProjectDbProviders(): (() => DatabaseSync)[] {
  const projects = listProjects();
  return projects.map((p) => () => getProjectDb(p.id));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
