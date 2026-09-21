// ============================================================================
// Ops-8: DYNAMIC PROJECT DISCOVERY IN SCHEDULER
//
// Bug M15c: scheduler.start(getProjectDbProviders()) meng-snapshot project
// saat server boot. Project baru yang dibuat setelah boot tidak pernah
// di-tick cron-nya sampai server di-restart.
//
// Fix Ops-8:
// 1. scheduler.start() tanpa argumen mengevaluasi listProjects() secara
//    dinamis di setiap tick.
// 2. Project baru yang dibuat setelah scheduler running langsung di-tick
//    pada siklus berikutnya tanpa perlu restart.
// 3. Backward-compatibility: scheduler.start([() => customDb]) tetap
//    berfungsi untuk isolasi unit test.
// ============================================================================

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initPlatformDb, createProject, provisionProjectStorage, closePlatformDb } from '../src/core/platformDb.js';
import { getProjectDb, closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { scheduler } from '../src/core/scheduler.js';
import { createFunction, initFunctionsTable } from '../src/core/functionsStore.js';

const TEST_DATA_DIR = path.resolve('../data/ops8-scheduler-test');

async function waitFor(predicate: () => boolean, maxMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > maxMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

before(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  initPlatformDb();
  scheduler.resetRunHistory();
  scheduler.stop();
});

after(() => {
  scheduler.stop();
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  setTimeout(() => {
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }, 100);
});

describe('Ops-8: Dynamic Project Discovery in Scheduler', () => {
  const ts = Date.now().toString(36);
  const pid1 = `ops8_e_${ts}`;
  const pid2 = `ops8_l_${ts}`;
  const pid3 = `ops8_d_${ts}`;

  test('Ops-8: project yang ada sebelum scheduler.start() dieksekusi', async () => {
    createProject(pid1, 'Early Project', { database: true, auth: true, storage: true });
    provisionProjectStorage(pid1);

    const db1 = getProjectDb(pid1);
    createFunction(db1, {
      name: 'early_cron',
      code: 'return { ran: true, t: req.time };',
      schedule: '* * * * *',
    });

    // Jalankan scheduler mode dinamis (tanpa argumen)
    scheduler.start();
    scheduler.resetRunHistory();
    scheduler.forceTick();

    const executed = await waitFor(() => scheduler.lastRuns.has('early_cron'));
    assert.ok(executed, 'early_cron harus dieksekusi');
    const run = scheduler.lastRuns.get('early_cron');
    assert.equal(run?.ok, true);
  });

  test('Ops-8: project baru dibuat SETELAH scheduler running langsung terdeteksi & dieksekusi', async () => {
    // Scheduler SUDAH running dari test sebelumnya.
    // Di versi lama (M15c snapshot), project berikut tidak akan pernah dieksekusi
    // karena getProjectDbProviders() hanya dipanggil sekali saat server boot.
    createProject(pid2, 'Late Project', { database: true, auth: true, storage: true });
    provisionProjectStorage(pid2);

    const db2 = getProjectDb(pid2);
    createFunction(db2, {
      name: 'late_cron',
      code: 'return { ran: true, late: true };',
      schedule: '* * * * *',
    });

    // Reset run history dan trigger tick berikutnya
    scheduler.resetRunHistory();
    scheduler.forceTick();

    const executed = await waitFor(() => scheduler.lastRuns.has('late_cron'));
    assert.ok(executed, 'late_cron di project baru harus dieksekusi tanpa restart scheduler');
    const run = scheduler.lastRuns.get('late_cron');
    assert.equal(run?.ok, true);
  });

  test('Ops-8: function disabled di project baru tidak boleh dieksekusi', async () => {
    createProject(pid3, 'Disabled Project', { database: true, auth: true, storage: true });
    provisionProjectStorage(pid3);

    const db3 = getProjectDb(pid3);
    const fn = createFunction(db3, {
      name: 'disabled_late_cron',
      code: 'return 1;',
      schedule: '* * * * *',
    });
    // Matikan function
    db3.prepare('UPDATE _functions SET enabled = 0 WHERE id = ?').run(fn.id);

    scheduler.resetRunHistory();
    scheduler.forceTick();

    // Tunggu sejenak untuk memastikan tidak ada race condition
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(scheduler.lastRuns.get('disabled_late_cron'), undefined, 'disabled function tidak boleh jalan');
  });

  test('Ops-8: backward-compatibility — customProviders tetap dihormati jika di-pass eksplisit', async () => {
    scheduler.stop();

    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    const customDbPath = path.join(TEST_DATA_DIR, 'custom-isolated.db');
    const customDb = new DatabaseSync(customDbPath);
    initFunctionsTable(customDb);

    createFunction(customDb, {
      name: 'custom_isolated_cron',
      code: 'return { isolated: true };',
      schedule: '* * * * *',
    });

    // Pass custom provider array (seperti m15c-scheduler.test.ts)
    scheduler.start([() => customDb]);
    scheduler.resetRunHistory();
    scheduler.forceTick();

    const executed = await waitFor(() => scheduler.lastRuns.has('custom_isolated_cron'));
    assert.ok(executed, 'custom provider harus dieksekusi');
    const run = scheduler.lastRuns.get('custom_isolated_cron');
    assert.equal(run?.ok, true);

    scheduler.stop();
    customDb.close();
  });
});
