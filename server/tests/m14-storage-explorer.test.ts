import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initSchemaTable, defineCollection } from '../src/core/schema.js';
import { createRecord } from '../src/core/records.js';
import { saveFile, listProjectStorageFiles, cleanOrphanedFiles, deleteFile } from '../src/core/storage.js';
import { bucketUpload, bucketRead } from '../src/core/bucketStorage.js';
import { getStorageAdapter } from '../src/core/storageAdapter.js';

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
    assert.equal(lampiran.mime, 'image/png');
    assert.equal(lampiran.isImage, true);
    assert.equal(lampiran.storedName.startsWith('migratedfile123_'), true);

    // Clean orphans → file bucket HARUS tetap utuh
    const cleaned = await cleanOrphanedFiles(pid, db);
    assert.equal(cleaned, 0);

    const after = await listProjectStorageFiles(pid, db);
    const stillThere = after.find((f) => f.name === 'lampiran.png');
    assert.ok(stillThere, 'file bucket harus selamat dari clean orphans');
    assert.equal(stillThere.isBucket, true);
    assert.equal(stillThere.isOrphaned, false);
  });

  test('bucket overwrite keeps the Storage Explorer display name and pointer in sync', async () => {
    const overwritten = await bucketUpload(db, pid, {
      filename: 'updated-lampiran.jpg',
      data: Buffer.from('new version'),
      fileId: 'migratedfile123',
    });
    assert.equal(overwritten.filename, 'updated-lampiran.jpg');
    const files = await listProjectStorageFiles(pid, db);
    const latest = files.filter((f) => f.recordId === 'migratedfile123');
    assert.equal(latest.length, 1);
    assert.equal(latest[0].name, 'updated-lampiran.jpg');
    assert.equal(latest[0].mime, 'image/jpeg');
    assert.equal(latest[0].isBucket, true);
    assert.equal(latest[0].isOrphaned, false);
  });

  test('Storage Explorer identifies current version when a bucket ID contains underscores', async () => {
    const up = await bucketUpload(db, pid, {
      filename: 'scanned.pdf', data: Buffer.from('pdf bytes'), fileId: 'id_with_underscores',
    });
    const all = await listProjectStorageFiles(pid, db);
    const matches = all.filter((f) => f.recordId === up.fileId);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].name, 'scanned.pdf');
    assert.equal(matches[0].isBucket, true);
    assert.equal(matches[0].isOrphaned, false);
  });

  test('Storage Explorer does not present an older physical bucket version as a second logical file', async () => {
    const up = await bucketUpload(db, pid, {
      filename: 'two-versions.png', data: Buffer.from('first'), fileId: 'doubleversionfile',
    });
    const saved = db.prepare('SELECT stored_name FROM _bucket_files WHERE file_id = ?').get(up.fileId) as { stored_name: string };
    // Emulate delayed cleanup of a previous physical version after the CAS.
    await saveFile(pid, up.fileId, 'b'.repeat(32) + '.png', Buffer.from('uncommitted'));
    const listed = await listProjectStorageFiles(pid, db);
    const current = listed.filter((f) => f.recordId === up.fileId);
    assert.equal(current.length, 1);
    assert.equal(current[0].storedName, saved.stored_name);
    assert.equal(current[0].name, 'two-versions.png');
    assert.equal(await cleanOrphanedFiles(pid, db), 0, 'do not delete an upload still in flight');
  });

  test('Storage Explorer does not hide an unrelated record file sharing a bucket prefix', async () => {
    const bucketId = 'sharedprefix';
    await bucketUpload(db, pid, { filename: 'bucket.png', data: Buffer.from('bucket'), fileId: bucketId });
    const recordId = 'sharedprefix_record';
    await saveFile(pid, recordId, 'report.pdf', Buffer.from('report'));
    const listed = await listProjectStorageFiles(pid, db);
    const other = listed.find((f) => f.storedName === `${recordId}_report.pdf`);
    assert.ok(other, 'unrelated record file must remain visible');
    assert.equal(other.isBucket, false);
    assert.equal(other.isOrphaned, true);
  });

  test('Clean Orphans cannot delete a physical bucket upload before metadata commits', async () => {
    const adapter = getStorageAdapter();
    const save = adapter.save;
    let reached!: () => void;
    let release!: () => void;
    const atSave = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const fileId = 'pending_bucket_id';
    adapter.save = async function (...args) {
      const result = await save.apply(this, args);
      if (args[1] === fileId) {
        reached();
        await resume;
      }
      return result;
    };
    try {
      const uploading = bucketUpload(db, pid, { filename: 'pending.png', data: Buffer.from('keep me'), fileId });
      await atSave;
      await cleanOrphanedFiles(pid, db);
      release();
      await uploading;
      const read = await bucketRead(db, pid, fileId);
      assert.equal(read?.data.toString(), 'keep me');
    } finally {
      release();
      adapter.save = save;
    }
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
