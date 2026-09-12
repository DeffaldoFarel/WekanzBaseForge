// ============================================================================
// M08: TEST AUTH USERS (per project)
//
// Membuktikan: create/verify/list + email unique (D1) + password tidak
// pernah bocor ke luar.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initAuthUsersTable, createAuthUser, verifyAuthCredentials, findAuthUserByEmail, listAuthUsers, changeAuthUserPassword, deleteAuthUser } from '../src/auth/users.js';

const TEST_DIR = path.resolve('../data/m08-users-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initAuthUsersTable(db);
  return db;
}

// ════════════════════════════════════════════════════════════════════════════

test('M08-users: createAuthUser menyimpan hash, BUKAN password', () => {
  const db = freshDb();

  const user = createAuthUser(db, { email: 'farel@x.com', password: 'passwordRahasia123', name: 'Farel' });

  assert.ok(user.id);
  assert.equal(user.email, 'farel@x.com');
  assert.equal(user.name, 'Farel');

  // BUKTI: di database mentah tersimpan HASH, bukan password!
  const raw = db.prepare('SELECT password_hash FROM _auth_users WHERE id = ?').get(user.id) as { password_hash: string };
  console.log('\n   📜 Di DB tersimpan:', raw.password_hash.slice(0, 50) + '...');
  assert.ok(raw.password_hash.startsWith('scrypt:'), 'harus scrypt hash');
  assert.ok(!raw.password_hash.includes('passwordRahasia123'), 'password plaintext TIDAK BOLEH ada!');

  db.close();
});

test('M08-users: email unique — duplikat DITOLAK dengan pesan ramah (D1!)', () => {
  const db = freshDb();

  createAuthUser(db, { email: 'farel@x.com', password: 'passwordRahasia123' });

  assert.throws(() => {
    createAuthUser(db, { email: 'farel@x.com', password: 'passwordLain456' });
  }, /sudah terdaftar/);

  db.close();
});

test('M08-users: email dinormalisasi ke lowercase', () => {
  const db = freshDb();

  createAuthUser(db, { email: 'Farel@X.COM', password: 'passwordRahasia123' });

  // Login dengan case berbeda → tetap ditemukan
  const found = findAuthUserByEmail(db, 'farel@x.com');
  assert.ok(found, 'email lowercase harus ketemu');

  db.close();
});

test('M08-users: verifyAuthCredentials benar → user, salah → null', () => {
  const db = freshDb();

  createAuthUser(db, { email: 'farel@x.com', password: 'passwordRahasia123' });

  // Kredensial benar
  const ok = verifyAuthCredentials(db, 'farel@x.com', 'passwordRahasia123');
  assert.ok(ok !== null, 'kredensial benar harus lolos');
  assert.equal(ok?.email, 'farel@x.com');

  // Password salah
  assert.equal(verifyAuthCredentials(db, 'farel@x.com', 'passwordSalah999'), null);

  // Email tidak terdaftar
  assert.equal(verifyAuthCredentials(db, 'hantu@x.com', 'passwordRahasia123'), null);

  db.close();
});

test('M08-users: verifikasi password lemah DITOLAK saat create', () => {
  const db = freshDb();

  assert.throws(() => {
    createAuthUser(db, { email: 'a@x.com', password: 'pendek' });
  }, /minimal 8 karakter/);

  db.close();
});

test('M08-users: listAuthUsers TIDAK membocorkan password_hash', () => {
  const db = freshDb();

  createAuthUser(db, { email: 'a@x.com', password: 'passwordRahasia123' });
  createAuthUser(db, { email: 'b@x.com', password: 'passwordLain456' });

  const list = listAuthUsers(db);
  assert.equal(list.totalItems, 2);

  // Buat serialisasi seluruh hasil — tidak boleh ada hash di dalamnya
  const json = JSON.stringify(list);
  assert.ok(!json.includes('scrypt:'), 'hash TIDAK BOLEH bocor di list!');

  console.log('\n   🛡️  List users tidak membocorkan password_hash ✓');

  db.close();
});

test('M08-users: changeAuthUserPassword — hash lama tidak valid lagi', () => {
  const db = freshDb();

  const user = createAuthUser(db, { email: 'farel@x.com', password: 'passwordLama999' });
  const oldHash = (db.prepare('SELECT password_hash FROM _auth_users WHERE id = ?').get(user.id) as { password_hash: string }).password_hash;

  changeAuthUserPassword(db, user.id, 'passwordBaru777');

  const newHash = (db.prepare('SELECT password_hash FROM _auth_users WHERE id = ?').get(user.id) as { password_hash: string }).password_hash;
  assert.notEqual(newHash, oldHash, 'hash harus berubah');

  // Password lama tidak valid, baru valid
  assert.equal(verifyAuthCredentials(db, 'farel@x.com', 'passwordLama999'), null);
  assert.ok(verifyAuthCredentials(db, 'farel@x.com', 'passwordBaru777') !== null);

  db.close();
});

test('M08-users: deleteAuthUser menghapus', () => {
  const db = freshDb();

  const user = createAuthUser(db, { email: 'hapus@x.com', password: 'passwordRahasia123' });
  assert.equal(deleteAuthUser(db, user.id), true);
  assert.equal(findAuthUserByEmail(db, 'hapus@x.com'), undefined);

  db.close();
});
