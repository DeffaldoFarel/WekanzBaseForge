// ============================================================================
// M15c: TEST SCHEDULER — cron parser + scheduled run + anti double-fire
//
// PROOF yang dicari:
// 1. Parser: semua syntax (*, N, A-B, *\/N, A-B/N, list) valid & invalid ditolak
// 2. cronMatches: menit-precision benar (jam, hari, bulan, dow)
// 3. Scheduler: function dengan schedule jalan saat forceTick
// 4. Anti double-fire: 2 tick di menit sama = 1 run
// 5. Disabled function tidak jalan walau schedule cocok
// 6. Schedule invalid → ditolak saat create/patch
// 7. req = { scheduled: true, time } di sandbox
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseCron, cronMatches } from '../src/core/cronParser.js';
import { scheduler } from '../src/core/scheduler.js';
import { runFunctionCode } from '../src/core/functionRunner.js';
import {
  initFunctionsTable,
  createFunction,
  updateFunction,
  listFunctions,
  getFunctionByName,
} from '../src/core/functionsStore.js';

// ─── Parser ──────────────────────────────────────────────────────────────────

describe('M15c: parseCron', () => {
  test('M15c: format valid diterima', () => {
    assert.doesNotThrow(() => parseCron('* * * * *'));
    assert.doesNotThrow(() => parseCron('0 1 * * *')); // harian 01:00
    assert.doesNotThrow(() => parseCron('*/15 * * * *'));
    assert.doesNotThrow(() => parseCron('30 8 * * 1-5'));
    assert.doesNotThrow(() => parseCron('0 0 1 * *'));
    assert.doesNotThrow(() => parseCron('5,10,15 * * * *'));
    assert.doesNotThrow(() => parseCron('1-3,5 * * * *'));
    assert.doesNotThrow(() => parseCron('10-30/5 * * * *'));
  });

  test('M15c: format invalid ditolak dengan pesan jelas', () => {
    assert.throws(() => parseCron('* * * *'), /5 field/);
    assert.throws(() => parseCron('* * * * * *'), /5 field/);
    assert.throws(() => parseCron('60 * * * *'), /di luar rentang/);
    assert.throws(() => parseCron('* 25 * * *'), /di luar rentang/);
    assert.throws(() => parseCron('a * * * *'), /tidak valid/);
    assert.throws(() => parseCron('5-1 * * * *'), /terbalik/);
    assert.throws(() => parseCron('*\/0 * * * *'), /step/);
  });

  test('M15c: parseCron menghasilkan set yang benar', () => {
    const f = parseCron('*/15 0-2 1,15 3 1');
    assert.deepEqual([...f.minutes].sort(), [0, 15, 30, 45]);
    assert.deepEqual([...f.hours].sort(), [0, 1, 2]);
    assert.deepEqual([...f.daysOfMonth].sort(), [1, 15]);
    assert.deepEqual([...f.months], [3]);
    assert.deepEqual([...f.daysOfWeek], [1]);
  });
});

describe('M15c: cronMatches (menit precision)', () => {
  test('M15c: match menit & jam', () => {
    // 2026-09-12 08:30 Sabtu (dow=6)
    const d = new Date(2026, 8, 12, 8, 30, 0);
    assert.equal(cronMatches('30 8 * * *', d), true);
    assert.equal(cronMatches('31 8 * * *', d), false);
    assert.equal(cronMatches('* 9 * * *', d), false);
    assert.equal(cronMatches('* * * * *', d), true);
  });

  test('M15c: day-of-week & day-of-month', () => {
    const sabtu = new Date(2026, 8, 12, 10, 0, 0); // dow = 6
    assert.equal(cronMatches('* * * * 6', sabtu), true);
    assert.equal(cronMatches('* * * * 0-5', sabtu), false);
    assert.equal(cronMatches('* * 12 * *', sabtu), true); // dom 12
    assert.equal(cronMatches('* * 13 * *', sabtu), false);
  });

  test('M15c: expression invalid → tidak pernah match (fail-safe)', () => {
    const d = new Date();
    assert.equal(cronMatches('bukan cron', d), false);
  });
});

// ─── Scheduler integration (DB nyata) ────────────────────────────────────────

const TEST_DIR = path.join(process.env.TEMP ?? '/tmp', 'baseforge-m15c-tests');


// M18a: runner async — tunggu sampai predicate terpenuhi (poll microtask+macrotask)
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

// M18a: tunggu sampai fn() truthy (max 2 detik) — untuk async runner assertion
async function waitFor(predicate: () => boolean, maxMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > maxMs) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

describe('M15c: Scheduler', () => {
  let db: DatabaseSync;

  before(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    db = new DatabaseSync(path.join(TEST_DIR, `m15c.db`));
    initFunctionsTable(db);
    scheduler.resetRunHistory();
  });

  after(() => {
    scheduler.stop();
    // Windows: file SQLite masih dipegang closeAllProjectDbs — beri jeda
    // kecil lalu cleanup best-effort (EPERM di CI tidak menggagalkan test)
    setTimeout(() => {
      try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      } catch {
        /* diabaikan */
      }
    }, 100);
  });

  test('M15c: create function dengan schedule valid', () => {
    const fn = createFunction(db, {
      name: 'every_minute',
      code: `return { scheduled: req.scheduled === true, time: typeof req.time === 'string' };`,
      schedule: '* * * * *', // tiap menit
    });
    assert.equal(fn.schedule, '* * * * *');
  });

  test('M15c: schedule invalid → ditolak saat create', () => {
    assert.throws(
      () => createFunction(db, { name: 'bad_cron', code: 'return 1;', schedule: 'tidak valid' }),
      /5 field/
    );
    assert.equal(getFunctionByName(db, 'bad_cron'), undefined);
  });

  test('M15c: scheduler forceTick → function jalan, req = { scheduled: true, time }', async () => {
    scheduler.start([() => db]);
    scheduler.forceTick();
    // M18a: runner async — tunggu promise isolate resolve
    await waitFor(() => scheduler.lastRuns.has('every_minute'));

    const run = scheduler.lastRuns.get('every_minute');
    assert.ok(run, 'function harus tercatat jalan');
    assert.equal(run.ok, true);

    // req contract: verifikasi dengan function yang menulis hasil ke log:
    const fn2 = createFunction(db, {
      name: 'log_time',
      code: `console.log('SCHEDPAYLOAD', req.scheduled, typeof req.time); return null;`,
      schedule: '* * * * *',
    });
    assert.ok(fn2);

    scheduler.forceTick();
    await waitFor(() => scheduler.lastRuns.has('log_time'));
    const run2 = scheduler.lastRuns.get('log_time');
    assert.ok(run2?.ok);

    // req contract: verifikasi payload scheduled via runner langsung
    const direct = await runFunctionCode(`return { s: req.scheduled, t: typeof req.time };`, {
      scheduledContext: { time: new Date().toISOString() },
    });
    assert.deepEqual(direct.result, { s: true, t: 'string' });
  });

  test('M15c: anti double-fire — tick 2x di menit sama = 1 run', async () => {
    scheduler.resetRunHistory();

    scheduler.forceTick();
    await waitFor(() => scheduler.lastRuns.has('every_minute'));
    const run1 = scheduler.lastRuns.get('every_minute');
    assert.ok(run1);

    scheduler.forceTick();
    await flushMicrotasks(); // menit sama
    const run2 = scheduler.lastRuns.get('every_minute');
    assert.deepEqual(run2, run1, 'run kedua harus tidak terjadi (objek sama)');
  });

  test('M15c: disabled function dengan schedule → tidak jalan', async () => {
    createFunction(db, {
      name: 'disabled_cron',
      code: `return 'x';`,
      schedule: '* * * * *',
      enabled: false,
    });
    scheduler.resetRunHistory();
    scheduler.forceTick();
    await flushMicrotasks();

    assert.equal(scheduler.lastRuns.get('disabled_cron'), undefined, 'disabled tidak boleh jalan');
  });

  test('M15c: schedule yang tidak cocok menit ini → tidak jalan', async () => {
    createFunction(db, {
      name: 'only_at_noon',
      code: `return 'x';`,
      schedule: '0 12 * * *', // jam 12:00 — sekarang hampir pasti bukan
    });
    scheduler.resetRunHistory();
    scheduler.forceTick();
    await flushMicrotasks();

    assert.equal(scheduler.lastRuns.get('only_at_noon'), undefined);
  });

  test('M15c: PATCH schedule — ubah & hapus (null)', () => {
    const fn = createFunction(db, { name: 'patched', code: 'return 1;', schedule: '0 1 * * *' });
    assert.equal(fn.schedule, '0 1 * * *');

    const changed = updateFunction(db, 'patched', { schedule: '*/5 * * * *' });
    assert.equal(changed?.schedule, '*/5 * * * *');

    const cleared = updateFunction(db, 'patched', { schedule: null });
    assert.equal(cleared?.schedule, null);

    // invalid saat patch → error
    assert.throws(() => updateFunction(db, 'patched', { schedule: 'xxx' }), /5 field/);
  });
});
