// ============================================================================
// Ops-5: RESET PASSWORD ADMIN PLATFORM — recovery offline saat terkunci
//
// B5: tidak ada jalur reset password admin platform → .env basi bisa
//     mengunci akses admin sepenuhnya (terjadi di VPS tencentvps1).
// Sekarang: sub-perintah CLI `reset-admin-password` yang membuka platform.db
// langsung, tanpa butuh server jalan atau token.
//
// Test memanggil fungsi inti secara langsung (bukan spawn CLI) karena
// spawnSync dengan shell:true di Windows tidak meneruskan env dengan andal.
// CLI itu sendiri adalah wrapper tipis di sekitar fungsi yang sama.
// ============================================================================

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { initPlatformDb, getPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { createInitialAdmin, loginAdmin } from '../src/platform/adminAuth.js';
import { resetAdminPassword } from '../src/platform/resetAdminPassword.js';

const TEST_DATA_DIR = path.resolve('../data/ops5-test');
const ADMIN_EMAIL = 'ops5-admin@test.local';
const OLD_PASSWORD = 'old-password-123';
const NEW_PASSWORD = 'new-password-456';

before(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  initPlatformDb();
  const db = getPlatformDb();
  db.prepare('DELETE FROM _platform_admins WHERE lower(email) = ?').run(ADMIN_EMAIL.toLowerCase());
  createInitialAdmin(ADMIN_EMAIL, OLD_PASSWORD);
});

after(() => {
  // Dulu rmSync ditunda lewat setTimeout(100) — callback-nya tidak pernah
  // ditunggu test runner, jadi proses keluar duluan dan direktori TIDAK
  // pernah terhapus. Tutup DB (melepas handle) lalu hapus secara sinkron.
  closePlatformDb();
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best-effort — jangan gagalkan suite yang assertion-nya sudah lulus */
  }
});

describe('Ops-5: reset password admin platform', () => {
  test('login dengan password lama berhasil sebelum reset', () => {
    const result = loginAdmin(ADMIN_EMAIL, OLD_PASSWORD);
    assert.ok(result, 'login lama harus berhasil');
    assert.equal(result.admin.email, ADMIN_EMAIL);
  });

  test('reset password → login lama GAGAL, login baru BERHASIL', () => {
    const r = resetAdminPassword(ADMIN_EMAIL, NEW_PASSWORD);
    assert.ok(r.ok, `reset harus berhasil: ${r.error ?? ''}`);

    const oldLogin = loginAdmin(ADMIN_EMAIL, OLD_PASSWORD);
    assert.equal(oldLogin, null, 'password lama harus ditolak setelah reset');

    const newLogin = loginAdmin(ADMIN_EMAIL, NEW_PASSWORD);
    assert.ok(newLogin, 'password baru harus diterima');
    assert.equal(newLogin.admin.email, ADMIN_EMAIL);
  });

  test('email yang tidak terdaftar → error jelas', () => {
    const r = resetAdminPassword('ghost@nowhere.local', 'some-password-123');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /tidak ditemukan/);
  });

  test('password lemah → error jelas', () => {
    const r = resetAdminPassword(ADMIN_EMAIL, 'short');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /lemah|at least 8/);
  });

  test('password_hash di DB benar-benar berubah setelah reset', () => {
    const db = getPlatformDb();
    const before = db
      .prepare('SELECT password_hash FROM _platform_admins WHERE lower(email) = ?')
      .get(ADMIN_EMAIL.toLowerCase()) as { password_hash: string };

    const r = resetAdminPassword(ADMIN_EMAIL, 'another-password-789');
    assert.ok(r.ok);

    const after = db
      .prepare('SELECT password_hash FROM _platform_admins WHERE lower(email) = ?')
      .get(ADMIN_EMAIL.toLowerCase()) as { password_hash: string };

    assert.notEqual(before.password_hash, after.password_hash, 'hash harus berubah');
  });
});
