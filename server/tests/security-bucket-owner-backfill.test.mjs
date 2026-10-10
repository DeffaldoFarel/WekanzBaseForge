import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = path.resolve('../data/security-bucket-owner-backfill-test');
const script = fileURLToPath(new URL('../tools/backfill-bucket-owners.mjs', import.meta.url));
const project = 'backfill-test-project';
const storagePath = 'users/alice/quick_notes/image.png';
const pathId = createHash('md5').update(storagePath).digest('hex');
const urlId = createHash('md5').update('users/alice/quick_notes/document.txt').digest('hex');
const ambiguousId = 'file_referenced_by_two_users';
const legacyId = 'unreferenced_legacy_file';
const ownedId = 'already_owned_file';
let serial = 0;

after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture({ conflicting = false, mismatchedPath = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, `fixture-${++serial}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE _collections (name TEXT PRIMARY KEY);
    CREATE TABLE _auth_users (id TEXT PRIMARY KEY);
    CREATE TABLE _bucket_files (file_id TEXT PRIMARY KEY, uploaded_by TEXT);
    CREATE TABLE quick_notes (userId TEXT NOT NULL, imagePath TEXT, imageUrl TEXT, content TEXT);
    CREATE TABLE cc_notes (userId TEXT NOT NULL, gambar TEXT, fileIds TEXT);
  `);
  db.prepare('INSERT INTO _collections(name) VALUES (?)').run('quick_notes');
  db.prepare('INSERT INTO _collections(name) VALUES (?)').run('cc_notes');
  for (const user of ['alice', 'bob']) db.prepare('INSERT INTO _auth_users(id) VALUES (?)').run(user);
  for (const id of [pathId, urlId, ambiguousId, legacyId]) {
    db.prepare('INSERT INTO _bucket_files(file_id, uploaded_by) VALUES (?,NULL)').run(id);
  }
  db.prepare('INSERT INTO _bucket_files(file_id, uploaded_by) VALUES (?,?)').run(ownedId, 'bob');
  db.prepare('INSERT INTO quick_notes(userId,imagePath,imageUrl,content) VALUES (?,?,?,?)').run(
    'alice', JSON.stringify([storagePath, 'users/alice/quick_notes/document.txt']), null,
    `<p><a href="https://baseforge.example/api/files/${project}/bucket/${urlId}">attachment</a></p>`,
  );
  if (mismatchedPath) {
    db.prepare('INSERT INTO quick_notes(userId,imagePath) VALUES (?,?)').run('bob', storagePath);
  }
  if (conflicting) {
    const url = `https://baseforge.example/api/files/${project}/bucket/${ambiguousId}`;
    db.prepare('INSERT INTO cc_notes(userId,gambar) VALUES (?,?)').run('alice', JSON.stringify([url]));
    db.prepare('INSERT INTO cc_notes(userId,gambar) VALUES (?,?)').run('bob', JSON.stringify([url]));
  }
  db.close();
  return dbPath;
}

function run(args) {
  return spawnSync(process.execPath, [script, '--project', project, ...args], {
    encoding: 'utf8',
  });
}

function state(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(db.prepare('SELECT file_id,uploaded_by FROM _bucket_files').all()
      .map((row) => [row.file_id, row.uploaded_by]));
  } finally {
    db.close();
  }
}

test('backfill dry-run is read-only, only uniquely referenced active-user files are eligible', () => {
  const dbPath = fixture({ conflicting: true, mismatchedPath: true });
  const before = state(dbPath);
  const result = run(['--db', dbPath]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.mode, 'dry-run');
  assert.equal(summary.eligible, 2);
  assert.equal(summary.ambiguous, 0);
  assert.equal(summary.unreferenced, 2);
  assert.ok(summary.untrustedReferences > 0);
  assert.equal(summary.alreadyOwned, 1);
  assert.ok(summary.rejectedMismatchedPaths > 0);
  assert.deepEqual(state(dbPath), before);
});

test('backfill refuses to write without a backup and exact expected count', () => {
  const dbPath = fixture();
  const before = state(dbPath);
  assert.notEqual(run(['--db', dbPath, '--apply']).status, 0);
  assert.notEqual(run(['--db', dbPath, '--apply', '--expect', '1', '--backup', `${dbPath}.bak`]).status, 0);
  assert.deepEqual(state(dbPath), before);
  assert.equal(fs.existsSync(`${dbPath}.bak`), false);
});

test('backfill commits after online backup; unresolved references require manual review', () => {
  const dbPath = fixture({ conflicting: true });
  const backupPath = `${dbPath}.bak`;
  const denied = run(['--db', dbPath, '--apply', '--expect', '2', '--backup', backupPath]);
  assert.notEqual(denied.status, 0);
  assert.equal(fs.existsSync(backupPath), false);
  assert.equal(state(dbPath)[pathId], null);
});

test('backfill rejects a reference to another project even with the same bucket fileId', () => {
  const dbPath = fixture();
  const fileId = 'foreign_project_url';
  const editable = new DatabaseSync(dbPath);
  editable.prepare('INSERT INTO _bucket_files(file_id,uploaded_by) VALUES (?,NULL)').run(fileId);
  editable.prepare('INSERT INTO quick_notes(userId,imageUrl) VALUES (?,?)').run(
    'alice', `https://baseforge.example/api/files/not-${project}/bucket/${fileId}`,
  );
  editable.close();
  const summary = JSON.parse(run(['--db', dbPath]).stdout);
  assert.equal(summary.eligible, 2);
  assert.equal(summary.unreferenced, 3);
});

test('security: an arbitrary URL in user text is not evidence to transfer a legacy file', () => {
  const dbPath = fixture();
  const attackerUrl = `https://attacker.invalid/api/files/${project}/bucket/${legacyId}`;
  const editable = new DatabaseSync(dbPath);
  editable.prepare('INSERT INTO quick_notes(userId,content) VALUES (?,?)').run('bob', `<p>${attackerUrl}</p>`);
  editable.close();
  const summary = JSON.parse(run(['--db', dbPath]).stdout);
  assert.equal(summary.eligible, 2);
  assert.equal(summary.unreferenced, 2);
});

test('security: a forged BaseForge bucket URL in rich text is not evidence of legacy ownership', () => {
  const dbPath = fixture();
  const editable = new DatabaseSync(dbPath);
  editable.prepare('INSERT INTO quick_notes(userId,content) VALUES (?,?)').run(
    'bob', `<p>https://baseforge.example/api/files/${project}/bucket/${legacyId}</p>`,
  );
  editable.close();
  const summary = JSON.parse(run(['--db', dbPath]).stdout);
  assert.equal(summary.eligible, 2);
  assert.equal(summary.unreferenced, 2);
});

test('backfill refuses to assign a legacy file when only a user-controlled fileIds string claims it', () => {
  const dbPath = fixture();
  const editable = new DatabaseSync(dbPath);
  editable.prepare('INSERT INTO cc_notes(userId,fileIds) VALUES (?,?)').run('bob', JSON.stringify([legacyId]));
  editable.close();
  const summary = JSON.parse(run(['--db', dbPath]).stdout);
  assert.equal(summary.eligible, 2);
  assert.equal(summary.unreferenced, 2);
});

test('backfill assigns verified owners to legacy files and leaves a restorable prechange backup', () => {
  const dbPath = fixture();
  // Remove the intentionally unreferenced fixture row; all unowned files now
  // have one owner so apply can be authorized with an exact expected count.
  const editable = new DatabaseSync(dbPath);
  editable.prepare('DELETE FROM _bucket_files WHERE file_id = ?').run(legacyId);
  editable.prepare('DELETE FROM _bucket_files WHERE file_id = ?').run(ambiguousId);
  editable.close();
  const backupPath = `${dbPath}.before-owners.db`;
  const result = run(['--db', dbPath, '--apply', '--expect', '2', '--backup', backupPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, 2);
  assert.equal(state(dbPath)[pathId], 'alice');
  assert.equal(state(dbPath)[urlId], 'alice');
  assert.equal(state(dbPath)[ownedId], 'bob');
  assert.equal(state(backupPath)[pathId], null);
  assert.equal(state(backupPath)[urlId], null);
  const again = run(['--db', dbPath]);
  assert.equal(JSON.parse(again.stdout).eligible, 0);
});
