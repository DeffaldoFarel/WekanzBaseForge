// ============================================================================
// Ops-18: TEST ISOLASI DATA_DIR — test tidak boleh menulis ke data produksi
//
// Bug yang ditutup (nyata, ditemukan 2026-09-21):
//
//   platformDb.ts dulu menghitung path pada level MODUL:
//     const DATA_DIR = path.resolve(process.env.DATA_DIR ?? '../data');
//
//   Static import ESM di-hoist ke atas seluruh statement file pemanggil, jadi
//   pola test yang dipakai 42 file di repo ini:
//     import { initPlatformDb } from '../src/core/platformDb.js';
//     before(() => { process.env.DATA_DIR = TEST_DIR; initPlatformDb(); });
//   SELALU terlambat — modul sudah membekukan '../data'.
//
//   Akibatnya setiap `npm test` membuat project di DATA PRODUKSI. Bukti saat
//   ditemukan: 789 project di data/platform.db, termasuk 14 pasang
//   'm24-proj-a'/'m24-proj-b' dan direktori sampah ops8_*/m47proj* di
//   data/projects/. Test tetap "hijau" sehingga kebocoran tak terlihat
//   bertahun-tahun milestone.
//
// File ini SENGAJA memakai STATIC IMPORT — persis pola yang dulu bocor.
// Kalau seseorang mengembalikan path ke level modul, test ini merah.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ⚠️ Import statis DI ATAS penyetelan env — justru itu intinya.
import {
  initPlatformDb,
  getDataDir,
  projectDir,
  projectDbPath,
  createProject,
  listProjects,
  provisionProjectStorage,
  resetPlatformDbForTests,
  DEFAULT_SERVICES,
} from '../src/core/platformDb.js';

const TEST_DATA_DIR = path.resolve('../data/ops18-isolation-test');
const PROD_DATA_DIR = path.resolve('../data');

/** Jumlah project di platform.db produksi SEBELUM test — pembanding akhir. */
let prodProjectCountBefore = -1;

/** Baca jumlah project dari sebuah platform.db lewat koneksi terpisah. */
function countProjectsIn(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM projects').get() as unknown as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

before(() => {
  // Foto keadaan produksi dulu (kalau ada), untuk dibandingkan di akhir.
  const prodDb = path.join(PROD_DATA_DIR, 'platform.db');
  if (fs.existsSync(prodDb)) {
    prodProjectCountBefore = countProjectsIn(prodDb);
  }

  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  // Env diset SETELAH import — inilah yang dulu diabaikan modul.
  process.env.DATA_DIR = TEST_DATA_DIR;
  initPlatformDb();
});

after(() => {
  // Tutup DB dulu: di Windows, rmSync gagal EPERM selama handle masih hidup —
  // itulah kenapa direktori test lama menumpuk tanpa ada yang sadar.
  resetPlatformDbForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

test('DATA_DIR yang diset SETELAH import tetap dihormati (resolusi lazy)', () => {
  assert.equal(
    getDataDir(),
    TEST_DATA_DIR,
    'modul membaca env saat DIPAKAI, bukan saat di-import'
  );
  assert.notEqual(getDataDir(), PROD_DATA_DIR, 'tidak boleh menunjuk data produksi');
});

test('platform.db dibuat di direktori TEST, bukan di data/ produksi', () => {
  assert.ok(
    fs.existsSync(path.join(TEST_DATA_DIR, 'platform.db')),
    'platform.db harus ada di direktori test'
  );
  assert.ok(
    fs.existsSync(path.join(TEST_DATA_DIR, 'projects')),
    'folder projects/ harus ada di direktori test'
  );
});

test('project yang dibuat mendarat di direktori test, bukan produksi', () => {
  const id = 'ops18probe' + Date.now().toString(36);
  createProject(id, 'ops18-probe-project', DEFAULT_SERVICES);
  provisionProjectStorage(id);

  const dir = projectDir(id);
  assert.ok(dir.startsWith(TEST_DATA_DIR), `projectDir harus di bawah test dir, dapat: ${dir}`);
  assert.ok(fs.existsSync(dir), 'folder project harus benar-benar dibuat');
  assert.ok(fs.existsSync(projectDbPath(id)), 'data.db project harus dibuat');

  // Dan TIDAK di produksi
  assert.ok(
    !fs.existsSync(path.join(PROD_DATA_DIR, 'projects', id)),
    'project test TIDAK boleh muncul di data/projects produksi'
  );

  // Registry yang terbaca adalah registry test (kecil), bukan produksi (ratusan)
  const all = listProjects();
  assert.ok(
    all.length < 10,
    `registry test harus kecil; dapat ${all.length} project — kemungkinan membaca platform.db produksi`
  );
  assert.ok(all.some((p) => p.id === id));
});

test('platform.db produksi TIDAK bertambah gara-gara test ini', () => {
  if (prodProjectCountBefore < 0) {
    // Tidak ada DB produksi di mesin ini (CI bersih) — tidak ada yang perlu dijaga.
    return;
  }
  assert.equal(
    countProjectsIn(path.join(PROD_DATA_DIR, 'platform.db')),
    prodProjectCountBefore,
    'jumlah project produksi berubah — test masih menulis ke data produksi!'
  );
});

test('resetPlatformDbForTests: melepas handle DB sehingga direktori bisa dihapus', () => {
  // Bukan detail kosmetik: tanpa ini `fs.rmSync` melempar EPERM di Windows,
  // cleanup diam-diam gagal, dan direktori test menumpuk selamanya.
  const probeDir = path.resolve('../data/ops18-close-probe');
  fs.rmSync(probeDir, { recursive: true, force: true });

  resetPlatformDbForTests();
  process.env.DATA_DIR = probeDir;
  initPlatformDb();
  assert.ok(fs.existsSync(path.join(probeDir, 'platform.db')));

  resetPlatformDbForTests();
  fs.rmSync(probeDir, { recursive: true, force: true }); // harus TIDAK melempar
  assert.ok(!fs.existsSync(probeDir), 'direktori harus benar-benar terhapus');

  // Kembalikan state untuk hook after()
  process.env.DATA_DIR = TEST_DATA_DIR;
  initPlatformDb();
});

test('cache DATA_DIR: path stabil selama proses, tidak berubah diam-diam', () => {
  // Path data yang berubah di tengah jalan = separuh data di folder lama,
  // separuh di folder baru. Setelah resolusi pertama, ubahan env diabaikan
  // sampai ada reset eksplisit.
  const before = getDataDir();
  process.env.DATA_DIR = path.resolve('../data/ops18-should-be-ignored');
  assert.equal(getDataDir(), before, 'DATA_DIR tidak boleh berpindah tanpa reset eksplisit');
  process.env.DATA_DIR = TEST_DATA_DIR;
});
