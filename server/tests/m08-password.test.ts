// ============================================================================
// M08: TEST PASSWORD HASHING
//
// Yang paling penting di sini:
//   1. Hash selalu berbeda untuk password sama (efek salt)
//   2. Verifikasi benar/salah
//   3. Waktu hash ~50-500ms (LAMBAH itu fitur!)
//   4. Kegagalan aman: hash korup → false, bukan crash
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
} from '../src/auth/password.js';

// ════════════════════════════════════════════════════════════════════════════
// FORMAT & SALT
// ════════════════════════════════════════════════════════════════════════════

test('M08: hash menghasilkan format scrypt lengkap', () => {
  const hash = hashPassword('passwordRahasia123');

  console.log('\n   📜 Contoh hash:', hash.slice(0, 60) + '...');

  // Format: scrypt:N:r:p:salt:hash
  const parts = hash.split(':');
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts.length, 6);
  assert.equal(parseInt(parts[1], 10), 16384); // N
  assert.equal(parseInt(parts[2], 10), 8);     // r
  assert.equal(parseInt(parts[3], 10), 1);     // p
  // salt & hash dalam hex
  assert.match(parts[4], /^[0-9a-f]+$/);
  assert.match(parts[5], /^[0-9a-f]+$/);
  // salt 16 bytes = 32 hex chars, hash 64 bytes = 128 hex chars
  assert.equal(parts[4].length, 32);
  assert.equal(parts[5].length, 128);
});

test('M08: password SAMA dua kali → hash BERBEDA (efek salt)', () => {
  const hash1 = hashPassword('passwordRahasia123');
  const hash2 = hashPassword('passwordRahasia123');

  console.log('\n   🧂 Hash 1:', hash1.slice(30, 70) + '...');
  console.log('   🧂 Hash 2:', hash2.slice(30, 70) + '...');
  console.log('   → Berbeda! Rainbow table tidak berguna.');

  assert.notEqual(hash1, hash2, 'salt membuat hash selalu unik');

  // Tapi keduanya tetap bisa diverifikasi dengan password aslinya
  assert.equal(verifyPassword('passwordRahasia123', hash1), true);
  assert.equal(verifyPassword('passwordRahasia123', hash2), true);
});

// ════════════════════════════════════════════════════════════════════════════
// VERIFY
// ════════════════════════════════════════════════════════════════════════════

test('M08: verifyPassword benar → true, salah → false', () => {
  const hash = hashPassword('passwordRahasia123');

  assert.equal(verifyPassword('passwordRahasia123', hash), true);
  assert.equal(verifyPassword('passwordSalah999', hash), false);
  assert.equal(verifyPassword('', hash), false);
  assert.equal(verifyPassword('passwordRahasia1234', hash), false); // mirip tapi salah
});

test('M08: hash korup/format aneh → false (bukan crash)', () => {
  // Hash rusak tidak boleh melempar error — itu hanya "password salah"
  assert.equal(verifyPassword('apapun', 'bukan-hash'), false);
  assert.equal(verifyPassword('apapun', 'md5:abc:def'), false);
  assert.equal(verifyPassword('apapun', 'scrypt:abc:def:ghi:jkl:mno'), false);
  assert.equal(verifyPassword('apapun', ''), false);
  console.log('\n   🛡️  Hash korup → false (gagal aman, tidak crash)');
});

// ════════════════════════════════════════════════════════════════════════════
// KECEPATAN — lambat itu FITUR
// ════════════════════════════════════════════════════════════════════════════

test('M08: BENCHMARK — hash butuh waktu ~50-500ms (lambat itu fitur)', () => {
  const t0 = performance.now();
  hashPassword('passwordRahasia123');
  const hashTime = performance.now() - t0;

  const t1 = performance.now();
  verifyPassword('passwordRahasia123', hashPassword('passwordRahasia123'));
  const verifyTime = performance.now() - t1;

  console.log('\n   ⏱️  Waktu hash   :', hashTime.toFixed(0) + 'ms');
  console.log('   ⏱️  Waktu verify :', verifyTime.toFixed(0) + 'ms');
  console.log('   💡 User login 1x tidak merasakan. Attacker menebak 1 miliar =');
  console.log('      ' + ((1e9 * (hashTime || 50)) / 1000 / 60 / 60 / 24 / 365).toFixed(0) + ' TAHUN!');

  // Harus cukup lambat untuk menghambat brute force
  // (tidak terlalu ketat — mesin lambat bisa di bawah 50ms)
  assert.ok(hashTime > 10, 'hash tidak boleh instan (< 10ms)');
  assert.ok(hashTime < 1000, 'hash tidak boleh > 1 detik (user experience)');
});

// ════════════════════════════════════════════════════════════════════════════
// VALIDASI KEKUATAN
// ════════════════════════════════════════════════════════════════════════════

test('M08: password lemah DITOLAK', () => {
  assert.ok(validatePasswordStrength('short') !== null, 'terlalu pendek');
  assert.ok(validatePasswordStrength('') !== null, 'kosong');
  assert.ok(validatePasswordStrength('x'.repeat(200)) !== null, 'terlalu panjang (DoS via scrypt memory)');
  assert.equal(validatePasswordStrength('passwordRahasia123'), null, 'valid');
});
