import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initSchemaTable, defineCollection } from '../src/core/schema.js';
import { createRecord } from '../src/core/records.js';
import { saveFile, listProjectStorageFiles, cleanOrphanedFiles, deleteFile } from '../src/core/storage.js';
import { bucketUpload } from '../src/core/bucketStorage.js';

const TEST_DIR = path.join(os.tmpdir(), 'baseforge-storage-explorer-tests');
process.env.STORAGE_DIR = path.join(TEST_DIR, 'storage');

describe('Storage Explorer Functions', () => {
  const pid = 'proj_storage_test_' + Date.now();
  fs.mkdirSync(path.join(process.env.STORAGE_DIR!, pid), { recursive: true });

  const db = new DatabaseSync(':memory:');
  initSchemaTable(db);
  defineCollection(db, {
    name: 'photos',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'image', type: 'file' },
    ],
  });

  test('listProjectStorageFiles: lists files and matches collection', async () => {
    // 1. Create a record with a file
    const r1 = createRecord(db, 'photos', { title: 'Liburan', image: 'beach.jpg' });
    await saveFile(pid, r1.id, 'beach.jpg', Buffer.from('fake image content'));

    // 2. Create an orphaned file (record id does not exist in db)
    await saveFile(pid, 'nonexistentrec12', 'orphan.png', Buffer.from('orphan content'));

    const files = await listProjectStorageFiles(pid, db);
    assert.equal(files.length, 2);

    const beach = files.find((f) => f.name === 'beach.jpg');
    assert.ok(beach);
    assert.equal(beach.collectionName, 'photos');
    assert.equal(beach.isOrphaned, false);
    assert.equal(beach.isImage, true);
    assert.equal(beach.mime, 'image/jpeg');

    const orphan = files.find((f) => f.name === 'orphan.png');
    assert.ok(orphan);
    assert.equal(orphan.collectionName, null);
    assert.equal(orphan.isOrphaned, true);
    assert.equal(orphan.isImage, true);
  });

  test('cleanOrphanedFiles: removes files without parent record', async () => {
    const cleaned = await cleanOrphanedFiles(pid, db);
    assert.equal(cleaned, 1);

    const remaining = await listProjectStorageFiles(pid, db);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].name, 'beach.jpg');
  });

  test('bucket file (M35) BUKAN orphaned — clean orphans tidak boleh menghapusnya', async () => {
    // Regresi bug data-loss: bucket file disimpan di namespace fileId, bukan
    // id record koleksi. Dulu listProjectStorageFiles salah menandainya orphaned
    // → "Clean Orphaned Files" menghapus lampiran sah (mis. hasil migrasi).
    const up = await bucketUpload(db, pid, {
      filename: 'lampiran.png',
      data: Buffer.from('bucket file content'),
      fileId: 'migratedfile123',
    });
    assert.equal(up.fileId, 'migratedfile123');

    const files = await listProjectStorageFiles(pid, db);
    const lampiran = files.find((f) => f.name === 'lampiran.png');
    assert.ok(lampiran, 'bucket file harus terlihat di storage explorer');
    assert.equal(lampiran.isBucket, true);
    assert.equal(lampiran.isOrphaned, false);

    // Clean orphans → file bucket HARUS tetap utuh
    const cleaned = await cleanOrphanedFiles(pid, db);
    assert.equal(cleaned, 0);

    const after = await listProjectStorageFiles(pid, db);
    const stillThere = after.find((f) => f.name === 'lampiran.png');
    assert.ok(stillThere, 'file bucket harus selamat dari clean orphans');
    assert.equal(stillThere.isBucket, true);
    assert.equal(stillThere.isOrphaned, false);
  });

  test('deleteFile: removes specific file from storage', async () => {
    // Target-spesifik (bukan files[0]) agar urutan test tidak mengubah makna.
    const files = await listProjectStorageFiles(pid, db);
    const beach = files.find((f) => f.name === 'beach.jpg');
    assert.ok(beach);
    await deleteFile(pid, beach.recordId, beach.name);

    const afterDelete = await listProjectStorageFiles(pid, db);
    assert.ok(!afterDelete.find((f) => f.name === 'beach.jpg'), 'beach.jpg harus terhapus');
  });
});
