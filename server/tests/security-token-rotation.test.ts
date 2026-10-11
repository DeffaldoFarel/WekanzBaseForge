// SECURITY: auth token lifecycle (audit #22).
//
// refreshAccessToken() issued a NEW refresh token without revoking the old
// one — a stolen old refresh token stayed valid for the full 30-day TTL even
// after the legitimate user rotated.

import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initAuthUsersTable } from '../src/auth/users.js';
import { initAuthTokensTable, issueTokens, refreshAccessToken, revokeRefreshToken } from '../src/auth/tokens.js';

const TEST_DIR = path.resolve('../data/token-rotation-test');

after(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows SQLite handle retention — must not fail a green suite.
  }
});

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initAuthUsersTable(db);
  initAuthTokensTable(db);
  return db;
}

function seedUser(db: DatabaseSync): string {
  const id = 'user-1';
  db.prepare(
    `INSERT INTO _auth_users (id, email, password_hash, verified) VALUES (?, ?, ?, 1)`
  ).run(id, 'u1@x.test', 'x');
  return id;
}

test('#22: refreshing ROTATES — the old refresh token becomes unusable', async () => {
  const db = freshDb();
  const userId = seedUser(db);

  const first = await issueTokens(db, { id: userId, email: 'u1@x.test' } as never, undefined as never);
  const second = await refreshAccessToken(db, first.refreshToken, undefined as never);

  assert.ok(second, 'refresh must succeed');
  assert.notEqual(second.refreshToken, first.refreshToken, 'a NEW refresh token must be issued');

  // The OLD token must now be dead.
  const third = await refreshAccessToken(db, first.refreshToken, undefined as never);
  assert.equal(third, null, 'the pre-rotation refresh token must be rejected after rotation');

  // The NEW token works.
  const fourth = await refreshAccessToken(db, second.refreshToken, undefined as never);
  assert.ok(fourth, 'the rotated refresh token must keep working');
  db.close();
});

test('#22: reuse of an already-rotated token is rejected (one-time use)', async () => {
  const db = freshDb();
  const userId = seedUser(db);

  const first = await issueTokens(db, { id: userId, email: 'u1@x.test' } as never, undefined as never);
  await refreshAccessToken(db, first.refreshToken, undefined as never);
  await refreshAccessToken(db, first.refreshToken, undefined as never); // reuse attempt
  const again = await refreshAccessToken(db, first.refreshToken, undefined as never);
  assert.equal(again, null, 'repeated reuse of the rotated token must stay rejected');
  db.close();
});

test('#22: explicit logout still revokes, independent of rotation', async () => {
  const db = freshDb();
  const userId = seedUser(db);

  const pair = await issueTokens(db, { id: userId, email: 'u1@x.test' } as never, undefined as never);
  assert.equal(revokeRefreshToken(db, pair.refreshToken), true);
  const after = await refreshAccessToken(db, pair.refreshToken, undefined as never);
  assert.equal(after, null, 'a logged-out token must be rejected');
  db.close();
});

test('#22: concurrent refreshes with the SAME token — at most one succeeds', async () => {
  const db = freshDb();
  const userId = seedUser(db);

  const pair = await issueTokens(db, { id: userId, email: 'u1@x.test' } as never, undefined as never);

  // Two racing refreshes presenting the same token. One-time rotation means
  // at most one of them may issue a fresh pair.
  const results = await Promise.allSettled([
    refreshAccessToken(db, pair.refreshToken, undefined as never),
    refreshAccessToken(db, pair.refreshToken, undefined as never),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length;
  assert.ok(succeeded <= 1, `at most one racing refresh may succeed, got ${succeeded}`);
  db.close();
});
