// ============================================================================
// M33: MONITOR ADMIN ROUTES — alert config + history + test + ack/resolve
//
//   GET    /api/admin/settings/monitoring        → config + stats
//   PUT    /api/admin/settings/monitoring        → update config (rules, webhook, enabled)
//   GET    /api/admin/alerts                     → alert history (firing + resolved)
//   POST   /api/admin/alerts/test                → kirim test alert
//   POST   /api/admin/alerts/:id/acknowledge     → tandai alert sebagai acknowledged
//   POST   /api/admin/alerts/:id/resolve         → resolve manual (force)
// ============================================================================

import { Router } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import {
  getAlertConfig,
  setAlertConfig,
  listAlerts,
  testAlert,
  acknowledgeAlert,
  resolveAlertManually,
  runMonitorCheck,
  type AlertRule,
  type AlertRuleName,
} from '../core/monitor.js';

export function createMonitorRouter(): Router {
  const router = new Router();

  // ─── CONFIG ────────────────────────────────────────────────────────────────

  router.get('/api/admin/settings/monitoring', requireAdmin, (req, res) => {
    const config = getAlertConfig();
    const alerts = listAlerts(200);
    const firing = alerts.filter((a) => a.status === 'firing');
    res.json({
      ...config,
      stats: {
        totalAlerts: alerts.length,
        firing: firing.length,
        unresolved: firing.filter((a) => !a.acknowledged).length,
      },
    });
  });

  router.put('/api/admin/settings/monitoring', requireAdmin, (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        enabled?: boolean;
        cooldownMinutes?: number;
        webhookUrl?: string | null;
        rules?: Array<{ name: string; threshold?: number; enabled?: boolean }>;
      };

      // Merge rules (partial update per rule)
      const current = getAlertConfig();
      const rules: AlertRule[] = current.rules.map((rule) => {
        const update = body.rules?.find((r) => r.name === rule.name);
        if (!update) return rule;
        return {
          ...rule,
          threshold: update.threshold !== undefined ? Math.max(0, update.threshold) : rule.threshold,
          enabled: update.enabled !== undefined ? update.enabled : rule.enabled,
        };
      });

      setAlertConfig({
        rules,
        cooldownMinutes: body.cooldownMinutes !== undefined
          ? Math.min(Math.max(body.cooldownMinutes, 1), 1440)
          : undefined,
        webhookUrl: body.webhookUrl !== undefined
          ? (body.webhookUrl === '' ? null : body.webhookUrl)
          : undefined,
        enabled: body.enabled !== undefined ? body.enabled : undefined,
      });

      const updated = getAlertConfig();
      res.json({
        ...updated,
        message: `Monitoring ${updated.enabled ? 'enabled' : 'disabled'} — ${updated.rules.filter((r) => r.enabled).length} rules active`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // ─── ALERT HISTORY ─────────────────────────────────────────────────────────

  router.get('/api/admin/alerts', requireAdmin, (req, res) => {
    const status = req.query.get('status') as 'firing' | 'resolved' | null;
    const limit = req.query.get('limit') ? parseInt(req.query.get('limit')!, 10) : 50;
    const alerts = listAlerts(Math.min(Math.max(limit, 1), 200), status ?? undefined);
    res.json({ alerts, total: alerts.length });
  });

  // ─── TEST ALERT ─────────────────────────────────────────────────────────────

  router.post('/api/admin/alerts/test', requireAdmin, async (req, res) => {
    try {
      const body = (req.body ?? {}) as { rule?: string };
      const ruleName = body.rule as AlertRuleName | undefined;
      const alert = await testAlert(ruleName);
      res.status(201).json({
        alert,
        message: `Test alert created: ${alert.message}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test alert failed';
      res.status(400).json({ error: { code: 'TEST_FAILED', message } });
    }
  });

  // ─── ACKNOWLEDGE ────────────────────────────────────────────────────────────

  router.post('/api/admin/alerts/:id/acknowledge', requireAdmin, (req, res) => {
    const ok = acknowledgeAlert(req.params.id);
    if (!ok) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert not found' } });
      return;
    }
    res.json({ ok: true, message: 'Alert acknowledged' });
  });

  // ─── MANUAL RESOLVE ─────────────────────────────────────────────────────────

  router.post('/api/admin/alerts/:id/resolve', requireAdmin, (req, res) => {
    // Manual resolve: status → resolved + acknowledged (sekaligus).
    // Sebelumnya hanya memanggil acknowledgeAlert → status tidak pernah berubah.
    const ok = resolveAlertManually(req.params.id);
    if (!ok) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Alert not found or already resolved' } });
      return;
    }
    res.json({ ok: true, message: 'Alert resolved' });
  });

  // ─── FORCE CHECK ────────────────────────────────────────────────────────────

  router.post('/api/admin/monitoring/check', requireAdmin, async (req, res) => {
    try {
      const result = await runMonitorCheck();
      res.json({
        triggered: result.triggered.length,
        resolved: result.resolved.length,
        triggeredAlerts: result.triggered,
        resolvedAlerts: result.resolved,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Check failed';
      res.status(500).json({ error: { code: 'CHECK_FAILED', message } });
    }
  });

  return router;
}
