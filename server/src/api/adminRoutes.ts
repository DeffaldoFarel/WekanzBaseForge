// ============================================================================
// M00: ADMIN API ROUTES — endpoint yang akan dipakai Dashboard
// ============================================================================

import { Router, generateId } from '../core/router.js';
import {
  requireAdmin,
  loginAdmin,
  logoutAdmin,
  getAdminSetupState,
  createInitialAdmin,
  changeAdminPassword,
} from '../platform/adminAuth.js';
import {
  listProjects,
  listProjectsPaged,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  provisionProjectStorage,
  destroyProjectStorage,
  DEFAULT_SERVICES,
  type ProjectServices,
  type ProjectSort,
} from '../core/platformDb.js';
import { closeProjectDb, getProjectResourceCounts } from '../core/projectDbManager.js';

export function createAdminRouter(): Router {
  const router = new Router();

  // ─── Health check & Setup (publik) ───────────────────────────────────────
  router.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'baseforge' });
  });

  router.get('/api/admin/setup-state', (req, res) => {
    res.json(getAdminSetupState());
  });

  router.post('/api/admin/auth/setup', (req, res) => {
    const state = getAdminSetupState();
    if (!state.needsSetup) {
      res.status(403).json({
        error: {
          code: 'SETUP_COMPLETED',
          message: 'Platform administrator is already configured',
        },
      });
      return;
    }

    const body = req.body as { email?: string; password?: string } | undefined;
    if (!body?.email || !body?.password) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'email and password are required' },
      });
      return;
    }

    try {
      const result = createInitialAdmin(body.email, body.password);
      res.status(201).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to setup administrator';
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message },
      });
    }
  });

  // ─── Auth ───────────────────────────────────────────────────────────────
  router.post('/api/admin/auth/login', (req, res) => {
    const body = req.body as { email?: string; password?: string } | undefined;

    if (!body?.email || !body?.password) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'email and password are required' },
      });
      return;
    }

    const result = loginAdmin(body.email, body.password);
    if (!result) {
      res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Wrong email or password' },
      });
      return;
    }

    res.json(result);
  });

  router.post('/api/admin/auth/logout', requireAdmin, (req, res) => {
    const authHeader = req.headers.authorization!;
    logoutAdmin(authHeader.slice(7));
    res.json({ success: true });
  });

  // Endpoint untuk memeriksa token masih valid (dipakai dashboard saat load)
  router.get('/api/admin/auth/me', requireAdmin, (req, res) => {
    res.json({ admin: req.admin });
  });

  // Ganti password admin yang sedang login. Wajib currentPassword yang benar
  // (membuktikan pemilik akun, bukan sekadar pembawa token), dan mencabut semua
  // sesi lain — hanya token yang dipakai untuk mengganti yang tetap hidup.
  router.post('/api/admin/auth/change-password', requireAdmin, (req, res) => {
    const body = req.body as
      | { currentPassword?: string; newPassword?: string }
      | undefined;

    if (!body?.currentPassword || !body?.newPassword) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'currentPassword and newPassword are required' },
      });
      return;
    }

    try {
      const authHeader = req.headers.authorization!;
      changeAdminPassword(
        req.admin!.email,
        body.currentPassword,
        body.newPassword,
        authHeader.slice(7) // token ini yang dipertahankan
      );
      res.json({ success: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to change password';
      // Kesalahan kredensial/kebijakan → 400, bukan 500.
      const isClientError =
        msg.includes('incorrect') ||
        msg.includes('not found') ||
        msg.includes('characters') ||
        msg.includes('password');
      res.status(isClientError ? 400 : 500).json({
        error: { code: isClientError ? 'BAD_REQUEST' : 'INTERNAL', message: msg },
      });
    }
  });

  // ─── Projects CRUD ──────────────────────────────────────────────────────
  // Perhatikan: semua route di bawah ini memakai middleware requireAdmin.

  // M48: paginasi + search + sort DI SERVER.
  //
  // Kompatibilitas: tanpa parameter apa pun, respons tetap seperti semula
  // (seluruh project di `projects`) — CLI dan test lama tidak perlu diubah.
  // Klien yang mengirim `perPage` mendapat satu halaman + blok `meta`.
  // Alasan opt-in: memaksa paginasi default akan diam-diam memotong hasil
  // bagi pemanggil lama, bentuk bug yang paling sulit dilacak.
  router.get('/api/admin/projects', requireAdmin, (req, res) => {
    const perPageRaw = req.query.get('perPage');
    const search = req.query.get('search') ?? '';
    const sortRaw = req.query.get('sort') ?? 'newest';
    const sort: ProjectSort =
      sortRaw === 'oldest' || sortRaw === 'name' ? sortRaw : 'newest';

    if (perPageRaw === null) {
      const all = listProjects();
      const projects = search
        ? listProjectsPaged({ search, sort, limit: 100, offset: 0 }).projects
        : all;
      res.json({ projects: projects.map(serializeProject) });
      return;
    }

    const perPage = Math.min(Math.max(parseInt(perPageRaw, 10) || 24, 1), 100);
    const page = Math.max(parseInt(req.query.get('page') ?? '1', 10) || 1, 1);

    const { projects, total } = listProjectsPaged({
      search,
      sort,
      limit: perPage,
      offset: (page - 1) * perPage,
    });

    res.json({
      projects: projects.map(serializeProject),
      meta: {
        page,
        perPage,
        total,
        totalPages: Math.max(Math.ceil(total / perPage), 1),
      },
    });
  });

  router.post('/api/admin/projects', requireAdmin, (req, res) => {
    const body = req.body as
      | { name?: string; services?: Partial<ProjectServices> }
      | undefined;

    if (!body?.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'Project name is required' },
      });
      return;
    }

    const id = generateId();
    const services: ProjectServices = { ...DEFAULT_SERVICES, ...body.services };

    // Aturan dependensi layanan (seperti Firebase): auth butuh database
    if (services.auth && !services.database) {
      res.status(400).json({
        error: { code: 'INVALID_SERVICES', message: 'auth service requires database service' },
      });
      return;
    }

    const project = createProject(id, body.name.trim(), services);
    provisionProjectStorage(id);

    res.status(201).json({ project: serializeProject(project) });
  });

  router.get('/api/admin/projects/:id', requireAdmin, (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }
    res.json({ project: serializeProject(project) });
  });

  router.patch('/api/admin/projects/:id', requireAdmin, (req, res) => {
    const body = req.body as
      | { name?: string; services?: Partial<ProjectServices> }
      | undefined;

    const existing = getProject(req.params.id);
    if (!existing) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    let services: ProjectServices | undefined;
    if (body?.services) {
      const current = JSON.parse(existing.services) as ProjectServices;
      services = { ...current, ...body.services };

      if (services.auth && !services.database) {
        res.status(400).json({
          error: { code: 'INVALID_SERVICES', message: 'auth service requires database service' },
        });
        return;
      }
    }

    const updated = updateProject(req.params.id, {
      name: body?.name?.trim(),
      services,
    });

    res.json({ project: serializeProject(updated!) });
  });

  router.delete('/api/admin/projects/:id', requireAdmin, (req, res) => {
    // Tutup koneksi DB project jika sedang aktif di cache (wajib di Windows sebelum unlink)
    closeProjectDb(req.params.id);

    const deleted = deleteProject(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    // Hapus juga seluruh folder project (db + files)
    destroyProjectStorage(req.params.id);

    res.json({ success: true });
  });

  return router;
}

// DB menyimpan services sebagai string JSON — kita parse saat keluar
function serializeProject(row: {
  id: string;
  name: string;
  services: string;
  created: string;
  updated: string;
}) {
  return {
    id: row.id,
    name: row.name,
    // Semua layanan BaaS selalu aktif secara bawaan (ready to use)
    services: {
      database: true,
      auth: true,
      storage: true,
      functions: true,
    } as ProjectServices,
    // Hitungan data riil untuk badge indikator UI
    resources: getProjectResourceCounts(row.id),
    created: row.created,
    updated: row.updated,
  };
}
