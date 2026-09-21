// ============================================================================
// M24: STATS ROUTES — statistik request & bandwidth per project
//
// GET /api/admin/projects/:pid/stats → { today, days[14], totals }
//   days = 14 hari terakhir (UTC) zero-filled — siap dipakai bar chart.
//   Real-time: merge data DB + buffer in-memory yang belum di-flush.
//
// M48: GET /api/admin/stats/projects?ids=a,b,c → { stats: { id: {today,totals} } }
//   Versi BATCH untuk daftar project. Halaman /projects dulu memanggil
//   endpoint per-project satu kali PER KARTU — 400 project = 400 request HTTP
//   yang diantre browser 6-per-host. Satu request + satu query SQL
//   menggantikannya.
//
//   Path sengaja `/api/admin/stats/projects`, BUKAN `/api/admin/projects/stats`:
//   pola `/api/admin/projects/:id` sudah terdaftar lebih dulu di adminRoutes
//   (router mencocokkan sesuai urutan registrasi), jadi 'stats' akan tertangkap
//   sebagai :id dan berakhir 404 "Project not found".
// ============================================================================

import { Router } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { getProject } from '../core/platformDb.js';
import { getProjectStats, getProjectsStatsSummary, MAX_STATS_BATCH } from '../core/metrics.js';

export function createStatsRouter(): Router {
  const router = new Router();

  router.get('/api/admin/projects/:pid/stats', requireAdmin, (req, res) => {
    const pid = req.params.pid;
    if (!getProject(pid)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }
    try {
      res.json(getProjectStats(pid));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read statistics';
      res.status(500).json({ error: { code: 'STATS_ERROR', message } });
    }
  });

  // ─── M48: ringkasan stats banyak project sekaligus ────────────────────────
  router.get('/api/admin/stats/projects', requireAdmin, (req, res) => {
    const raw = req.query.get('ids') ?? '';
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Query parameter "ids" is required' },
      });
      return;
    }
    // Batas tegas, bukan senyap: klien yang mengirim 5000 id harus tahu
    // permintaannya tidak dilayani utuh — diam-diam memotong = bug sunyi.
    if (new Set(ids).size > MAX_STATS_BATCH) {
      res.status(400).json({
        error: {
          code: 'TOO_MANY_IDS',
          message: `Too many project ids (max ${MAX_STATS_BATCH} per request)`,
        },
      });
      return;
    }

    try {
      res.json({ stats: getProjectsStatsSummary(ids) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read statistics';
      res.status(500).json({ error: { code: 'STATS_ERROR', message } });
    }
  });

  return router;
}
