// ============================================================================
// M01: TEST + 4 EKSPERIMEN KV STORE
//
// Bagian pertama: test fungsional dasar (set/get/delete/keys).
// Bagian kedua: 4 EKSPERIMEN yang sengaja memicu cacat desain KV store.
//
// Jalankan: npm test
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { KVStore } from '../src/lab/kvStore.js';

const TEST_DIR = path.resolve('../data/m01-test');
const TEST_DB = path.join(TEST_DIR, 'test-kv.json');

// Bersihkan file test sebelum setiap suite
function cleanTestDb(): void {
  if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
}

// ════════════════════════════════════════════════════════════════════════════
// BAGIAN 1: TEST FUNGSIONAL DASAR
// ════════════════════════════════════════════════════════════════════════════

test('M01: set dan get bekerja', async () => {
  cleanTestDb();
  const kv = new KVStore(TEST_DB);

  await kv.set('habits:h1', { title: 'Olahraga', streak: 7 });
  const result = (await kv.get('habits:h1')) as { title: string; streak: number };

  assert.equal(result.title, 'Olahraga');
  assert.equal(result.streak, 7);
});

test('M01: get key yang tidak ada → undefined', async () => {
  cleanTestDb();
  const kv = new KVStore(TEST_DB);

  const result = await kv.get('tidak-ada');
  assert.equal(result, undefined);
});

test('M01: delete menghapus key', async () => {
  cleanTestDb();
  const kv = new KVStore(TEST_DB);

  await kv.set('x', 1);
  const deleted = await kv.delete('x');

  assert.equal(deleted, true);
  assert.equal(await kv.get('x'), undefined);
  assert.equal(await kv.delete('x'), false); // delete lagi → false
});

test('M01: keys dengan prefix', async () => {
  cleanTestDb();
  const kv = new KVStore(TEST_DB);

  await kv.set('habits:h1', { streak: 1 });
  await kv.set('habits:h2', { streak: 2 });
  await kv.set('users:u1', { name: 'A' });

  const habitKeys = await kv.keys('habits:');
  assert.equal(habitKeys.length, 2);
  assert.ok(habitKeys.includes('habits:h1'));

  const allKeys = await kv.keys();
  assert.equal(allKeys.length, 3);
});

// ════════════════════════════════════════════════════════════════════════════
// BAGIAN 2: EMPAT EKSPERIMEN — merasakan cacat desain
// ════════════════════════════════════════════════════════════════════════════

test('EKSPERIMEN 1: persistensi — data selamat dari "restart"', async () => {
  cleanTestDb();

  // "Server" pertama: tulis data, lalu "mati" (objek dibuang)
  {
    const kv = new KVStore(TEST_DB);
    await kv.set('penting', { rahasia: 'jangan hilang' });
    // kv keluar scope = simulasi proses mati
  }

  // "Server" kedua: instance baru, membaca file yang sama
  {
    const kv2 = new KVStore(TEST_DB);
    const result = (await kv2.get('penting')) as { rahasia: string };
    assert.equal(result.rahasia, 'jangan hilang');
    console.log('   ✅ E1: Data selamat dari restart karena ada file persist.');
    console.log('      Tapi coba bayangkan versi TANPA persist() — semua hilang!');
  }
});

test('EKSPERIMEN 2: biaya persist() — setiap set menulis ulang SEMUANYA', async () => {
  cleanTestDb();
  const kv = new KVStore(TEST_DB);

  // Isi 2000 key
  const FILL = 2000;
  const t0 = performance.now();
  for (let i = 0; i < FILL; i++) {
    await kv.set(`key:${i}`, { n: i, payload: 'x'.repeat(50) });
  }
  const fillTime = performance.now() - t0;

  const fileSize = fs.statSync(TEST_DB).size;

  console.log(`   📊 E2: Mengisi ${FILL} key butuh ${fillTime.toFixed(0)}ms`);
  console.log(`      File sekarang ${(fileSize / 1024).toFixed(0)} KB.`);
  console.log(`      Setiap SET ke-1..${FILL} menulis ulang file yang makin besar!`);
  console.log(`      Waktu total ~O(N²) — kuadratik terhadap jumlah data.`);

  // Bukti kuadratik: mengisi 2x data harusnya >2x lebih lambat dari 1x data.
  // (Kita tidak assert waktu — hanya menampilkan, karena timing berbeda
  //  antar mesin. Yang penting kamu MELIHAT angkanya.)
  assert.ok(fillTime > 0);
});

test('EKSPERIMEN 3: file corrupt — JSON setengah jadi', async () => {
  cleanTestDb();

  // Simulasikan crash saat menulis: tulis JSON yang TERPOTONG
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(TEST_DB, '{"key:a": {"value": 1}, "key:b": {"val', 'utf-8');
  //                                                            ⬆️ terpotong di tengah!

  let error: Error | null = null;
  try {
    new KVStore(TEST_DB); // mencoba load file corrupt
  } catch (err) {
    error = err as Error;
  }

  assert.ok(error !== null, 'Seharusnya throw error saat file corrupt');
  assert.ok(error!.message.includes('CORRUPT'));
  console.log('   💥 E3: File setengah jadi → database GAGAL TOTAL load.');
  console.log('      Satu crash di saat yang salah = SELURUH database tidak terbaca.');
  console.log('      Database sungguhan: tulis ke WAL/temp-file dulu (M07).');

  cleanTestDb();
});

test('EKSPERIMEN 4: pencarian tanpa index — full scan', async () => {
  cleanTestDb();
  const kv = new KVStore(TEST_DB);

  // Isi 5000 habits dengan streak acak
  const FILL = 5000;
  for (let i = 0; i < FILL; i++) {
    await kv.set(`habits:h${i}`, { title: `Habit ${i}`, streak: i % 10 });
  }

  // Cari semua yang streak > 5 — satu-satunya cara: BACA SEMUANYA
  const t0 = performance.now();
  const found = await kv.findByValue(
    (v) => (v as { streak: number }).streak > 5
  );
  const searchTime = performance.now() - t0;

  console.log(`   🔍 E4: Mencari streak>5 dari ${FILL} records: ${searchTime.toFixed(1)}ms`);
  console.log(`      Ketemu ${found.length} records — tapi kita MEMBACA semua ${FILL}!`);
  console.log(`      Dengan index (M06): hanya baca yang relevan, 100-1000x lebih cepat.`);

  assert.equal(found.length, 2000); // streak 6,7,8,9 × (5000/10) = 4 × 500
  cleanTestDb();
});
