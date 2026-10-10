#!/usr/bin/env node
/**
 * Safely assign owner IDs to legacy bucket files from dashboard record refs.
 * Dry-run by default. Apply requires an explicit expected count and a new,
 * absolute backup destination. Never log user IDs, filenames, file IDs, or
 * document content. Run only against a trusted database path.
 *
 * node tools/backfill-bucket-owners.mjs --db /path/to/data.db --project <pid>
 * node tools/backfill-bucket-owners.mjs --db /path/to/data.db --project <pid> \
 *   --apply --expect <count> --backup /path/to/prechange-backup.db
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

const argv = process.argv.slice(2);
function option(flag) {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

const dbPath = option('--db');
const project = option('--project');
const apply = argv.includes('--apply');
const backupPath = option('--backup');
const expectedText = option('--expect');
if (!dbPath || !path.isAbsolute(dbPath) || !project || !/^[A-Za-z0-9_-]+$/.test(project)) {
  throw new Error('An absolute --db and a valid --project are required');
}
if (!fs.existsSync(dbPath)) throw new Error('Database does not exist');
if (apply && (!backupPath || !path.isAbsolute(backupPath) ||
    !/^(0|[1-9][0-9]*)$/.test(expectedText ?? '') ||
    fs.existsSync(backupPath) || path.resolve(backupPath) === path.resolve(dbPath))) {
  throw new Error('Apply requires --expect <exact count> and a NEW absolute --backup path');
}

const db = new DatabaseSync(dbPath, { readOnly: !apply });
try {
  const files = new Map(db.prepare('SELECT file_id, uploaded_by FROM _bucket_files').all()
    .map((entry) => [entry.file_id, entry.uploaded_by]));
  const activeUsers = new Set(db.prepare('SELECT id FROM _auth_users').all().map((entry) => entry.id));
  const ownerByFile = new Map();
  let untrustedReferences = 0;
  let rejectedMismatchedPaths = 0;
  // A URL, free text, or client-supplied fileIds are references only: their
  // author can paste another user's public bucket ID. They cannot establish
  // ownership. Only a legacy path names its user AND hashes to the bucket ID.
  const untrustedUrlIds = new RegExp(`/api/files/${project}/bucket/([A-Za-z0-9_-]+)(?=[?#/"'\\s<]|$)`, 'g');
  const candidateColumns = new Set([
    'imagePath', 'imageUrl', 'imageUrls', 'gambar', 'fileIds',
    'content', 'description', 'notes', 'note', 'deskripsi', 'aktivitas', 'data',
  ]);

  function track(id, owner) {
    if (!files.has(id) || !activeUsers.has(owner)) return;
    if (!ownerByFile.has(id)) ownerByFile.set(id, new Set());
    ownerByFile.get(id).add(owner);
  }

  const names = db.prepare('SELECT name FROM _collections').all();
  for (const { name } of names) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) continue;
    const available = new Set(db.prepare(`PRAGMA table_info("${name}")`).all().map((column) => column.name));
    if (!available.has('userId')) continue;
    const selected = [...candidateColumns].filter((field) => available.has(field));
    if (!selected.length) continue;
    const quote = (key) => `"${key}"`;
    for (const record of db.prepare(`SELECT ${['userId', ...selected].map(quote).join(',')} FROM "${name}"`).all()) {
      const owner = record.userId;
      if (!activeUsers.has(owner)) continue;
      for (const field of selected) {
        const value = record[field];
        if (value == null) continue;
        const text = String(value);
        untrustedUrlIds.lastIndex = 0;
        for (const match of text.matchAll(untrustedUrlIds)) {
          if (files.has(match[1])) untrustedReferences++;
        }
        // Attribute imagePath is the only canonical, upload-derived path
        // from which we can deterministically reconstruct a bucket ID. The
        // nested path must agree with the record's authenticated userId.
        if (field !== 'imagePath') continue;
        let paths;
        try { paths = JSON.parse(text); } catch { paths = text; }
        for (const storagePath of Array.isArray(paths) ? paths : [paths]) {
          if (typeof storagePath !== 'string' || !storagePath.startsWith('users/')) continue;
          const declaredOwner = storagePath.split('/')[1];
          if (declaredOwner !== owner) {
            rejectedMismatchedPaths++;
            continue;
          }
          track(createHash('md5').update(storagePath).digest('hex'), owner);
        }
      }
    }
  }

  const updates = [];
  let ambiguous = 0;
  let unreferenced = 0;
  let alreadyOwned = 0;
  for (const [id, storedOwner] of files) {
    if (storedOwner !== null) { alreadyOwned++; continue; }
    const candidates = ownerByFile.get(id);
    if (!candidates?.size) { unreferenced++; continue; }
    if (candidates.size !== 1) { ambiguous++; continue; }
    updates.push([id, [...candidates][0]]);
  }
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    total: files.size,
    eligible: updates.length,
    ambiguous,
    unreferenced,
    alreadyOwned,
    untrustedReferences,
    rejectedMismatchedPaths,
  };
  if (!apply) {
    console.log(JSON.stringify(summary));
  } else {
    const expected = Number(expectedText);
    if (ambiguous || unreferenced || expected !== updates.length) {
      throw new Error('Owner reconciliation is incomplete or --expect differs: no changes made');
    }
    await backup(db, backupPath); // node:sqlite online backup includes active WAL pages
    const before = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(before.prepare('SELECT COUNT(*) AS n FROM _bucket_files').get().n, files.size);
    } finally { before.close(); }
    db.exec('BEGIN IMMEDIATE');
    try {
      const statement = db.prepare('UPDATE _bucket_files SET uploaded_by = ? WHERE file_id = ? AND uploaded_by IS NULL');
      for (const [id, owner] of updates) {
        assert.equal(statement.run(owner, id).changes, 1, 'concurrent bucket owner mutation');
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    console.log(JSON.stringify({ ...summary, updated: updates.length, backupVerified: true }));
  }
} finally {
  db.close();
}
