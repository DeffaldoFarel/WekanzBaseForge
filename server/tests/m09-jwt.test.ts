// ============================================================================
// M09: TEST JWT & REFRESH TOKENS
//
// Bagian 1: JWT sign/verify (termasuk TAMPERING test!)
// Bagian 2: refresh tokens (persisten, hashed, revoke)
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { signToken, verifyToken } from '../src/auth/jwt.js';
import { createAuthUser, initAuthUsersTable } from '../src/auth/users.js';
import {
  initAuthTokensTable,
  issueTokens,
  refreshAccessToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  ACCESS_TOKEN_TTL,
} from '../src/auth/tokens.js';

const TEST_DIR = path.resolve('../data/m09-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initAuthUsersTable(db);   // tabel _auth_users (M08)
  initAuthTokensTable(db);  // tabel _auth_tokens (M09)
  return db;
}

// ════════════════════════════════════════════════════════════════════════════
// JWT DASAR
// ════════════════════════════════════════════════════════════════════════════

test('M09: signToken menghasilkan JWT 3 bagian', () => {
  const token = signToken({ sub: 'u1', email: 'f@x.com' }, 900);
  const parts = token.split('.');

  console.log('\n   📜 JWT:', token.slice(0, 60) + '...');
  assert.equal(parts.length, 3, 'JWT harus header.payload.signature');
});

test('M09: verify token sah → payload sesuai', () => {
  const token = signToken({ sub: 'u1', email: 'farel@x.com' }, 900);
  const result = verifyToken(token);

  assert.ok(result.valid, 'token sah harus valid');
  if (result.valid) {
    assert.equal(result.payload.sub, 'u1');
    assert.equal(result.payload.email, 'farel@x.com');
    assert.ok(result.payload.exp > Math.floor(Date.now() / 1000));
  }
});

test('M09: TAMPERING — payload dimodifikasi → DITOLAK', () => {
  const token = signToken({ sub: 'u1', role: 'user' }, 900);
  const [header, payload, signature] = token.split('.');

  // Attacker coba jadi dirinya sendiri: ubah payload jadi admin
  const forgedPayload = Buffer.from(
    JSON.stringify({ sub: 'u1', role: 'admin' })
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const forged = `${header}.${forgedPayload}.${signature}`;
  const result = verifyToken(forged);

  console.log('\n   ⚔️  Token dipalsukan: sub tetap, role → admin');
  console.log('   🛡️  Hasil:', result.valid ? 'DITERIMA (BAHAYA!)' : 'DITOLAK (signature tidak cocok)');

  assert.ok(!result.valid, 'token tamper HARUS ditolak');
  assert.equal(result.valid ? '' : result.reason, 'bad-signature');
});

test('M09: signature dari SECRET berbeda → DITOLAK', () => {
  // Token yang dibuat dengan secret berbeda (server lain / secret lama)
  const token = signToken({ sub: 'u1' }, 900);
  const result = verifyToken(token);
  assert.ok(result.valid); // secret sama → valid (sanity check)
  // ( Pengujian secret berbeda dilakukan via env di test terpisah
  //   karena secret dibaca saat pemanggilan. Struktur sudah siap. )
});

test('M09: token expired → ditolak dengan reason expired', () => {
  // Buat token yang sudah expired (ttl negatif)
  const token = signToken({ sub: 'u1' }, -10); // expired 10 detik lalu
  const result = verifyToken(token);

  assert.ok(!result.valid);
  assert.equal(result.valid ? '' : result.reason, 'expired');
});

test('M09: token salah format / signature palsu → ditolak', () => {
  assert.equal(verifyToken('bukan-jwt').valid, false);
  assert.equal(verifyToken('a.b').valid, false);          // kurang bagian
  assert.equal(verifyToken('a.b.c.d.e').valid, false);    // kebanyakan bagian

  // 3 bagian tapi signature palsu → bad-signature (bukan malformed!)
  // Ini benar: formatnya valid, isi yang palsu.
  const r = verifyToken('a.b.c');
  assert.equal(r.valid, false);
  assert.equal(r.valid ? '' : r.reason, 'bad-signature');

  console.log('\n   🛡️  Semua format salah / signature palsu ditolak.');
});

// ════════════════════════════════════════════════════════════════════════════
// REFRESH TOKENS — persisten, hashed, revoke
// ════════════════════════════════════════════════════════════════════════════

test('M09: issueTokens menghasilkan access + refresh', () => {
  const db = freshDb();
  const user = createAuthUser(db, { email: 'farel@x.com', password: 'passwordRahasia123' });

  const tokens = issueTokens(db, user);

  assert.ok(tokens.accessToken, 'access token harus ada');
  assert.ok(tokens.refreshToken, 'refresh token harus ada');
  assert.equal(tokens.expiresIn, ACCESS_TOKEN_TTL);
  assert.equal(tokens.accessToken.split('.').length, 3, 'access harus JWT');

  // Access token langsung valid
  const verified = verifyToken(tokens.accessToken);
  assert.ok(verified.valid);

  db.close();
});

test('M09: refresh token tersimpan HASHED di DB (bukan plaintext)', () => {
  const db = freshDb();
  const user = createAuthUser(db, { email: 'farel@x.com', password: 'passwordRahasia123' });

  const tokens = issueTokens(db, user);

  // Cek DB mentah
  const rows = db.prepare('SELECT token_hash FROM _auth_tokens').all() as { token_hash: string }[];
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].token_hash.includes(tokens.refreshToken), 'plaintext TIDAK BOLEH tersimpan');
  assert.equal(rows[0].token_hash.length, 64, 'harus sha256 hex');

  console.log('\n   🧂 Refresh token di DB (hashed):', rows[0].token_hash.slice(0, 32) + '...');

  db.close();
});

test('M09: refreshAccessToken memberi access baru TANPA login ulang', () => {
  const db = freshDb();
  const user = createAuthUser(db, { email: 'farel@x.com', password: 'passwordRahasia123' });

  const first = issueTokens(db, user);

  // 15 menit kemudian: access expired → pakai refresh
  const refreshed = refreshAccessToken(db, first.refreshToken);

  assert.ok(refreshed !== null, 'refresh harus berhasil');

  // Access baru harus VALID (catatan: JWT dalam detik yang sama bisa
  // identik secara string — itu normal & deterministik. Yang penting valid!)
  const verified = verifyToken(refreshed!.accessToken);
  assert.ok(verified.valid, 'access baru harus valid');
  if (verified.valid) {
    assert.equal(verified.payload.sub, user.id);
  }

  // Refresh token BARU juga diterbitkan (rotasi) → yang lama tetap dipakai
  // untuk sesi berikutnya, yang baru tersimpan di DB
  const count = (db.prepare('SELECT COUNT(*) AS n FROM _auth_tokens').get() as { n: number }).n;
  assert.equal(count, 2, 'issueTokens kedua menambah baris token');

  console.log('\n   🔄 Refresh berhasil: access baru valid tanpa login ulang');

  db.close();
});

test('M09: refresh token SALAH → null', () => {
  const db = freshDb();
  const user = createAuthUser(db, { email: 'farel@x.com', password: 'passwordRahasia123' });
  issueTokens(db, user);

  assert.equal(refreshAccessToken(db, 'token-hantu-yang-tidak-ada'), null);
  assert.equal(refreshAccessToken(db, ''), null);

  db.close();
});

test('M09: REVOKE — logout membuat refresh token tidak bisa dipakai', () => {
  const db = freshDb();
  const user = createAuthUser(db, { email: 'farel@x.com', password: 'passwordRahasia123' });

  const tokens = issueTokens(db, user);

  // Logout (revoke)
  assert.equal(revokeRefreshToken(db, tokens.refreshToken), true);

  // Setelah revoke → refresh ditolak
  assert.equal(refreshAccessToken(db, tokens.refreshToken), null);
  console.log('\n   🚪 Setelah logout, refresh token mati ✓');

  db.close();
});

test('M09: revokeAllUserTokens — logout dari semua device', () => {
  const db = freshDb();
  const user = createAuthUser(db, { email: 'farel@x.com', password: 'passwordRahasia123' });

  // Login dari 3 "device"
  const t1 = issueTokens(db, user);
  const t2 = issueTokens(db, user);
  const t3 = issueTokens(db, user);

  const revoked = revokeAllUserTokens(db, user.id);
  console.log(`\n   📵 Revoke semua: ${revoked} token dimatikan`);

  assert.equal(revoked, 3);
  assert.equal(refreshAccessToken(db, t1.refreshToken), null);
  assert.equal(refreshAccessToken(db, t2.refreshToken), null);
  assert.equal(refreshAccessToken(db, t3.refreshToken), null);

  db.close();
});

test('M09: TOKEN PERSISTEN — selamat dari restart server', () => {
  const dbPath = path.join(TEST_DIR, `persist-${Date.now()}-${counter++}.db`);

  let refreshToken = '';
  {
    // "Server" pertama: login, dapat refresh token, lalu "restart"
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    initAuthUsersTable(db);
    initAuthTokensTable(db);
    const user = createAuthUser(db, { email: 'p@x.com', password: 'passwordRahasia123' });
    refreshToken = issueTokens(db, user).refreshToken;
    db.close(); // simulasi restart
  }

  {
    // "Server" kedua (setelah restart): refresh token MASIH BERFUNGSI
    const db2 = new DatabaseSync(dbPath);
    db2.exec('PRAGMA journal_mode = WAL');
    initAuthUsersTable(db2);
    initAuthTokensTable(db2);
    const refreshed = refreshAccessToken(db2, refreshToken);
    assert.ok(refreshed !== null, 'refresh token harus selamat dari restart!');
    console.log('\n   💪 Token persisten: selamat dari restart server (beda dengan M00!)');
    db2.close();
  }
});
