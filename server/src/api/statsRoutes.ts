// ============================================================================
// M24: STATS ROUTES — statistik request & bandwidth per project
//
// GET /api/admin/projects/:pid/stats → { today, days[14], totals }
//   days = 14 hari terakhir (UTC) zero-filled — siap dipakai bar chart.
//   Real-time: merge data DB + buffer in-memory yang belum di-flush.
// ============================================================================

import { Router } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { getProject } from '../core/platformDb.js';
import { getProjectStats } from '../core/metrics.js';

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

  return router;
}
