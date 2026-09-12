// ============================================================================
// M14: TEST STORAGE — multipart, file field, disk, serving
//
// PROOF yang dicari:
// 1. Parser multipart benar (teks + file binary utuh)
// 2. File tersimpan di disk & nama file di record
// 3. Path traversal DITOLAK (../../etc/passwd aman)
// 4. Replace file → lama terhapus; record hapus → file terhapus
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initSchemaTable, defineCollection, getCollectionByName } from '../src/core/schema.js';
import { createRecord, updateRecord, deleteRecord, multipartToRecordData, cleanupReplacedFiles } from '../src/core/records.js';
import { parseMultipart, extractBoundary, sanitizeFilename } from '../src/core/multipart.js';
import { saveFile, readFile, deleteRecordFiles } from '../src/core/storage.js';

const TEST_DIR = path.join(os.tmpdir(), 'baseforge-m14-tests');
let counter = 0;

// Storage khusus test — STORAGE_DIR dibaca lazy oleh storageRoot()
const STORAGE_TEST = path.join(TEST_DIR, `storage-${Date.now()}`);
process.env.STORAGE_DIR = STORAGE_TEST;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `m14-${Date.now()}-${counter++}.db`));
  initSchemaTable(db);
  defineCollection(db, {
    name: 'docs',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'doc', type: 'file', options: { maxSelect: 1 } },
      { name: 'gallery', type: 'file', options: { maxSelect: 3 } },
    ],
  });
  return db;
}

describe('M14: Multipart parser', () => {
  test('M14: extractBoundary menemukan boundary', () => {
    const b = extractBoundary('multipart/form-data; boundary=----WebKitFormBoundaryABC123');
    assert.equal(b, '----WebKitFormBoundaryABC123');
  });

  test('M14: parse field teks & file binary UTUH', async () => {
    const boundary = 'XBOUND';
    // File "binary" berisi bytes non-utf8-safe (0xFF, 0x00 dst)
    const fileBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22, 0x50, 0x4b]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="title"\r\n\r\n`),
      Buffer.from('Laporan Harian\r\n'),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="doc"; filename="foto.jpg"\r\n`),
      Buffer.from(`Content-Type: image/jpeg\r\n\r\n`),
      fileBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const result = await parseMultipart(body, boundary);
    assert.equal(result.fields.title, 'Laporan Harian');
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].fieldName, 'doc');
    assert.equal(result.files[0].filename, 'foto.jpg');
    assert.equal(result.files[0].contentType, 'image/jpeg');
    assert.ok(result.files[0].data.equals(fileBytes), 'bytes binary harus identik!');
  });

  test('M14: sanitizeFilename menolak path traversal', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('..\\..\\windows\\system32'), 'system32');
    assert.equal(sanitizeFilename(''), 'file');
    assert.equal(sanitizeFilename('.'), 'file');
    assert.equal(sanitizeFilename('..'), 'file');
  });
});

describe('M14: Storage disk', () => {
  test('M14: saveFile + readFile — utuh kembali', () => {
    const content = Buffer.from('isi dokumen penting');
    const stored = saveFile('proj1', 'rec123', 'test.txt', content);
    assert.equal(stored, 'test.txt');

    const read = readFile('proj1', 'rec123', 'test.txt');
    assert.ok(read && read.equals(content));
  });

  test('M14: readFile menolak path traversal (null, bukan crash)', () => {
    assert.equal(readFile('proj1', 'rec123', '..\\..\\secret.txt'), null);
  });

  test('M14: deleteRecordFiles menghapus semua file record', () => {
    saveFile('proj1', 'recX', 'a.txt', Buffer.from('a'));
    saveFile('proj1', 'recX', 'b.txt', Buffer.from('b'));
    saveFile('proj1', 'recY', 'c.txt', Buffer.from('c'));

    const n = deleteRecordFiles('proj1', 'recX');
    assert.equal(n, 2, '2 file recX terhapus');
    assert.equal(readFile('proj1', 'recX', 'a.txt'), null);
    assert.ok(readFile('proj1', 'recY', 'c.txt'), 'file recY tidak ikut!');
  });
});

describe('M14: File field di records', () => {
  test('M14: multipartToRecordData menyimpan file & mengisi field', async () => {
    const db = freshDb();
    const meta = getCollectionByName(db, 'docs')!;
    const boundary = 'XB';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="title"\r\n\r\n`),
      Buffer.from('dengan lampiran\r\n'),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="doc"; filename="gambar.png"\r\n`),
      Buffer.from(`Content-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    // recordId ditentukan dulu (seperti di publicRoutes: preGeneratedId)
    const recId = 'recABC123';
    const data = await multipartToRecordData('projM14', meta, recId, body, `multipart/form-data; boundary=${boundary}`);

    assert.equal(data.title, 'dengan lampiran');
    assert.equal(data.doc, 'gambar.png');

    // File fisik ada & utuh?
    const stored = readFile('projM14', recId, 'gambar.png');
    assert.ok(stored && stored.equals(png));
  });

  test('M14: createRecord dgn preGeneratedId + delete + cleanup → file hilang', () => {
    const db = freshDb();
    const stored = saveFile('projM14', 'recDEL1', 'hapus.txt', Buffer.from('file milik record'));

    const rec = createRecord(db, 'docs', { title: 'x', doc: stored }, undefined, 'recDEL1');
    assert.equal(rec.id, 'recDEL1');
    assert.ok(readFile('projM14', 'recDEL1', 'hapus.txt'), 'file ada sebelum delete');

    const ok = deleteRecord(db, 'docs', 'recDEL1');
    assert.equal(ok, true);

    // Cleanup file (dilakukan API layer setelah deleteRecord sukses)
    deleteRecordFiles('projM14', 'recDEL1');
    assert.equal(readFile('projM14', 'recDEL1', 'hapus.txt'), null, 'file ikut terhapus!');
  });

  test('M14: replace file saat update → file lama hilang', () => {
    const db = freshDb();
    const meta = getCollectionByName(db, 'docs')!;
    const rec = createRecord(db, 'docs', { title: 'v1' });

    saveFile('projM14', rec.id, 'v1.txt', Buffer.from('versi 1'));
    const r1 = updateRecord(db, 'docs', rec.id, { doc: 'v1.txt' });
    assert.equal(r1?.doc, 'v1.txt');

    saveFile('projM14', rec.id, 'v2.txt', Buffer.from('versi 2'));
    const r2 = updateRecord(db, 'docs', rec.id, { doc: 'v2.txt' });
    assert.equal(r2?.doc, 'v2.txt');

    // cleanupReplacedFiles — persis seperti yang dipanggil publicRoutes PATCH
    const oldSnapshot = { doc: 'v1.txt' };
    cleanupReplacedFiles('projM14', meta, rec.id, oldSnapshot, { doc: 'v2.txt' });

    assert.equal(readFile('projM14', rec.id, 'v1.txt'), null, 'file lama harus terhapus');
    assert.ok(readFile('projM14', rec.id, 'v2.txt'), 'file baru tetap ada');
  });

  test('M14: multi-file (maxSelect=3) — semua tersimpan sebagai array', async () => {
    const db = freshDb();
    const meta = getCollectionByName(db, 'docs')!;
    const boundary = 'XM';

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="title"\r\n\r\n`),
      Buffer.from('galeri\r\n'),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="gallery"; filename="a.png"\r\n\r\n`),
      Buffer.from('AAA'),
      Buffer.from(`\r\n--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="gallery"; filename="b.png"\r\n\r\n`),
      Buffer.from('BBB'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const recId = 'recMULTI1';
    const data = await multipartToRecordData('projM14', meta, recId, body, `multipart/form-data; boundary=${boundary}`);

    assert.ok(Array.isArray(data.gallery), 'multi-file = array');
    assert.equal((data.gallery as string[]).length, 2);

    assert.ok(readFile('projM14', recId, 'a.png'));
    assert.ok(readFile('projM14', recId, 'b.png'));
  });
});
