// ============================================================================
// M32: BACKUP ADMIN ROUTES — config CRUD + trigger + list + download
//
//   GET    /api/admin/projects/:pid/backup/config     → konfigurasi aktif
//   PUT    /api/admin/projects/:pid/backup/config     → set { schedule, retention }
//   DELETE /api/admin/projects/:pid/backup/config     → reset ke default (off)
//   POST   /api/admin/projects/:pid/backup/run        → trigger backup manual
//   GET    /api/admin/projects/:pid/backup/list       → daftar backup + metadata
//   GET    /api/admin/projects/:pid/backup/download/:filename → stream file .db
// ============================================================================

import fs from 'node:fs';
import { Router } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { getProject } from '../core/platformDb.js';
import {
  getBackupConfig,
  setBackupConfig,
  deleteBackupConfig,
  backupProject,
  listBackups,
  getBackupPath,
} from '../core/backupScheduler.js';

export function createBackupRouter(): Router {
  const router = new Router();

  // ─── CONFIG ────────────────────────────────────────────────────────────────

  router.get('/api/admin/projects/:pid/backup/config', requireAdmin, (req, res) => {
    res.json(getBackupConfig(req.params.pid));
  });

  router.put('/api/admin/projects/:pid/backup/config', requireAdmin, (req, res) => {
    try {
      if (!getProject(req.params.pid)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
        return;
      }
      const body = (req.body ?? {}) as { schedule?: string; retention?: number };
      const schedule = body.schedule === 'daily' || body.schedule === 'weekly' ? body.schedule : 'off';
      const retention = Math.min(Math.max(body.retention ?? 7, 1), 30);
      setBackupConfig(req.params.pid, { schedule, retention });
      res.json({ schedule, retention, message: `Backup schedule set to ${schedule} (retention: ${retention})` });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.delete('/api/admin/projects/:pid/backup/config', requireAdmin, (req, res) => {
    const had = deleteBackupConfig(req.params.pid);
    res.json({ schedule: 'off', retention: 7, message: had ? 'Backup config removed' : 'No config found (already default)' });
  });

  // ─── TRIGGER MANUAL ─────────────────────────────────────────────────────────

  router.post('/api/admin/projects/:pid/backup/run', requireAdmin, (req, res) => {
    try {
      const info = backupProject(req.params.pid);
      res.status(201).json({
        backup: info,
        message: `Backup created: ${info.filename} (${(info.size / 1024).toFixed(1)}KB)`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Backup failed';
      res.status(400).json({ error: { code: 'BACKUP_FAILED', message } });
    }
  });

  // ─── LIST ──────────────────────────────────────────────────────────────────

  router.get('/api/admin/projects/:pid/backup/list', requireAdmin, (req, res) => {
    const config = getBackupConfig(req.params.pid);
    const backups = listBackups(req.params.pid);
    res.json({
      config,
      backups,
      totalSize: backups.reduce((acc, b) => acc + b.size, 0),
    });
  });

  // ─── DOWNLOAD ──────────────────────────────────────────────────────────────

  router.get('/api/admin/projects/:pid/backup/download/:filename', requireAdmin, (req, res) => {
    const filePath = getBackupPath(req.params.pid, req.params.filename);
    if (!filePath) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Backup file not found' } });
      return;
    }

    const stat = fs.statSync(filePath);
    res.raw.setHeader('Content-Type', 'application/x-sqlite3');
    res.raw.setHeader('Content-Length', String(stat.size));
    res.raw.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.raw.setHeader('Cache-Control', 'no-cache');

    const stream = fs.createReadStream(filePath);
    stream.pipe(res.raw);
  });

  return router;
}
