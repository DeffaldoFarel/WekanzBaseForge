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

  // Buat HTTP server. Perhatikan betapa tipisnya lapisan ini:
  // server = terima koneksi → serahkan ke router → router memanggil handler.
  // Express pada dasarnya hanya ini + kenyamanan tambahan!
  const server = http.createServer((req, res) => {
    router.handle(req, res);
  });

  server.listen(PORT, () => {
    console.log('');
    console.log('🛠️  WekanzBaseForge server running');
    console.log(`   → http://localhost:${PORT}`);
    console.log(`   → Health: http://localhost:${PORT}/api/health`);
    console.log('');
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
