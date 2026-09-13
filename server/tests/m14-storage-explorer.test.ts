import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initSchemaTable, defineCollection } from '../src/core/schema.js';
import { createRecord } from '../src/core/records.js';
import { saveFile, listProjectStorageFiles, cleanOrphanedFiles, deleteFile } from '../src/core/storage.js';

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

  test('listProjectStorageFiles: lists files and matches collection', () => {
    // 1. Create a record with a file
    const r1 = createRecord(db, 'photos', { title: 'Liburan', image: 'beach.jpg' });
    saveFile(pid, r1.id, 'beach.jpg', Buffer.from('fake image content'));

    // 2. Create an orphaned file (record id does not exist in db)
    saveFile(pid, 'nonexistentrec12', 'orphan.png', Buffer.from('orphan content'));

    const files = listProjectStorageFiles(pid, db);
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

  test('cleanOrphanedFiles: removes files without parent record', () => {
    const cleaned = cleanOrphanedFiles(pid, db);
    assert.equal(cleaned, 1);

    const remaining = listProjectStorageFiles(pid, db);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].name, 'beach.jpg');
  });

  test('deleteFile: removes specific file from storage', () => {
    const files = listProjectStorageFiles(pid, db);
    assert.equal(files.length, 1);
    deleteFile(pid, files[0].recordId, files[0].name);

    const afterDelete = listProjectStorageFiles(pid, db);
    assert.equal(afterDelete.length, 0);
  });
});
