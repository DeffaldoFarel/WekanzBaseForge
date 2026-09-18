// ============================================================================
// Ops-4: KONTRAK SCHEMA API — tiga celah dari real-test WekanzDashboard
//
// B1: POST/PUT /collections menolak rule yang dikirim FLAT (dulu 201 + rules null)
// B2: PATCH /collections/:name menolak `rules` (dulu 200 tanpa menyimpan)
// B3: kolom yang direferensikan rule mendapat index otomatis (dulu SCAN)
// ============================================================================

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Router } from '../src/core/router.js';
import { initPlatformDb, projectDbPath } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { collectRuleFieldNames } from '../src/core/rules.js';
import { validateCollectionBody } from '../src/core/schema.js';

const TEST_DATA_DIR = path.resolve('../data/ops4-test');
const ADMIN_EMAIL = 'ops4@test.local';
const ADMIN_PASSWORD = 'ops4-password-123';

let server: nodeHttp.Server;
let baseURL: string;
let adminToken = '';
let projectId = '';

function http(
  method: string,
  p: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      new URL(p, baseURL),
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data: any = null;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Baca rencana eksekusi langsung dari SQLite project — bukti terukur B3. */
function queryPlan(collection: string, column: string): string {
  // Pakai projectDbPath(), JANGAN menyusun path sendiri: path relatif
  // resolve terhadap cwd shell dan gagal 'unable to open database file'
  // (errcode 14) — pitfall yang tercatat di skill repo.
  const db = new DatabaseSync(projectDbPath(projectId));
  try {
    const rows = db
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM "${collection}" WHERE "${column}" = ?`)
      .all('x') as Array<{ detail: string }>;
    return rows[0]?.detail ?? '';
  } finally {
    db.close();
  }
}

function listIndexes(collection: string): string[] {
  const db = new DatabaseSync(projectDbPath(projectId));
  try {
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'`
      )
      .all(collection) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

const OWNER_RULE = 'userId = @request.auth.id';

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.STORAGE_DIR = path.join(TEST_DATA_DIR, 'storage');
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.JWT_SECRET = 'ops4-test-secret';

  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createPublicRouter());

  server = nodeHttp.createServer((req, res) => router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseURL = `http://127.0.0.1:${port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  assert.equal(login.status, 200, 'admin login harus 200');
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'ops4-project' }, adminToken);
  assert.equal(proj.status, 201, 'create project harus 201');
  projectId = proj.data.project.id;
});

after(() => {
  closeAllProjectDbs();
  server?.close();
  setTimeout(() => {
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort: Windows file lock */
    }
  }, 100);
});

// ─── B1 ─────────────────────────────────────────────────────────────────────

describe('Ops-4 B1: body collection menolak kunci tak dikenal', () => {
  test('POST dengan rule FLAT ditolak 400, bukan 201 dengan rules null', async () => {
    const res = await http(
      'POST',
      `/api/admin/projects/${projectId}/collections`,
      {
        name: 'flat_rules',
        fields: [{ name: 'userId', type: 'text', required: true }],
        // Bentuk SALAH — inilah yang dulu membalas 201 dengan rules null
        listRule: OWNER_RULE,
        createRule: '@request.auth.id != ""',
      },
      adminToken
    );

    assert.equal(res.status, 400, 'harus 400, bukan 201');
    assert.match(
      String(res.data?.error?.message ?? ''),
      /listRule/,
      'pesan harus menyebut kunci yang salah'
    );
    assert.match(
      String(res.data?.error?.message ?? ''),
      /rules\.listRule/,
      'pesan harus menuntun ke bentuk benar'
    );

    // Dan collection-nya BENAR-BENAR tidak dibuat
    const list = await http(
      'GET',
      `/api/admin/projects/${projectId}/collections`,
      undefined,
      adminToken
    );
    const names = (list.data.collections ?? []).map((c: any) => c.name);
    assert.ok(!names.includes('flat_rules'), 'collection tidak boleh terbuat');
  });

  test('POST dengan rules BERSARANG diterima dan rules benar-benar tersimpan', async () => {
    const res = await http(
      'POST',
      `/api/admin/projects/${projectId}/collections`,
      {
        name: 'nested_rules',
        fields: [
          { name: 'userId', type: 'text', required: true },
          { name: 'title', type: 'text' },
        ],
        rules: { listRule: OWNER_RULE, createRule: '@request.auth.id != ""' },
      },
      adminToken
    );
    assert.equal(res.status, 201);

    // Dibaca ULANG dari server — 201 bukan bukti tersimpan
    const list = await http(
      'GET',
      `/api/admin/projects/${projectId}/collections`,
      undefined,
      adminToken
    );
    const col = (list.data.collections ?? []).find((c: any) => c.name === 'nested_rules');
    assert.ok(col, 'collection harus ada');
    assert.equal(col.rules.listRule, OWNER_RULE, 'listRule harus tersimpan, bukan null');
  });

  test('kunci acak tak dikenal juga ditolak', async () => {
    const res = await http(
      'POST',
      `/api/admin/projects/${projectId}/collections`,
      {
        name: 'typo_key',
        fields: [{ name: 'userId', type: 'text' }],
        feilds: [],
      },
      adminToken
    );
    assert.equal(res.status, 400);
    assert.match(String(res.data?.error?.message ?? ''), /feilds/);
  });

  test('validateCollectionBody menerima body yang sah', () => {
    assert.equal(
      validateCollectionBody({
        name: 'x',
        fields: [],
        indexes: [],
        rules: {},
        type: 'base',
        viewQuery: null,
      }),
      null
    );
  });
});

// ─── B2 ─────────────────────────────────────────────────────────────────────

describe('Ops-4 B2: PATCH tidak boleh diam-diam membuang rules', () => {
  test('PATCH dengan rules ditolak 400 dan menunjuk jalur yang benar', async () => {
    const res = await http(
      'PATCH',
      `/api/admin/projects/${projectId}/collections/nested_rules`,
      { fields: [{ name: 'extra', type: 'text' }], rules: { listRule: '' } },
      adminToken
    );

    assert.equal(res.status, 400, 'harus 400, bukan 200 yang menyesatkan');
    const msg = String(res.data?.error?.message ?? '');
    assert.match(msg, /rules/, 'pesan menyebut rules');
    assert.match(msg, /\/rules|PUT/, 'pesan menunjuk jalur alternatif');
  });

  test('rules TIDAK berubah setelah PATCH ditolak', async () => {
    const list = await http(
      'GET',
      `/api/admin/projects/${projectId}/collections`,
      undefined,
      adminToken
    );
    const col = (list.data.collections ?? []).find((c: any) => c.name === 'nested_rules');
    assert.equal(col.rules.listRule, OWNER_RULE, 'listRule harus tetap seperti semula');
  });

  test('PATCH tanpa rules tetap bekerja (perubahan aditif field)', async () => {
    // updateCollection menuntut daftar field LENGKAP: field yang tidak
    // disertakan dianggap DIHAPUS, dan penghapusan ditolak ("Removing fields
    // is not supported yet ... needs table rebuild"). Jadi kirim ulang semua
    // field yang sudah ada + satu yang baru.
    const res = await http(
      'PATCH',
      `/api/admin/projects/${projectId}/collections/nested_rules`,
      {
        fields: [
          { name: 'userId', type: 'text', required: true },
          { name: 'title', type: 'text' },
          { name: 'note', type: 'text' },
        ],
      },
      adminToken
    );
    assert.equal(res.status, 200, 'jalur normal tidak boleh ikut rusak');
  });

  test('jalur resmi PATCH /rules tetap berfungsi', async () => {
    const res = await http(
      'PATCH',
      `/api/admin/projects/${projectId}/collections/nested_rules/rules`,
      { viewRule: OWNER_RULE },
      adminToken
    );
    assert.equal(res.status, 200);

    const list = await http(
      'GET',
      `/api/admin/projects/${projectId}/collections`,
      undefined,
      adminToken
    );
    const col = (list.data.collections ?? []).find((c: any) => c.name === 'nested_rules');
    assert.equal(col.rules.viewRule, OWNER_RULE, 'viewRule harus tersimpan lewat jalur resmi');
  });
});

// ─── B3 ─────────────────────────────────────────────────────────────────────

describe('Ops-4 B3: kolom yang dipakai rule mendapat index otomatis', () => {
  test('collectRuleFieldNames mengekstrak field skema, mengabaikan @request & literal', () => {
    const fields = [
      { name: 'userId', type: 'text' as const },
      { name: 'status', type: 'text' as const },
    ];
    const got = collectRuleFieldNames(
      {
        listRule: 'userId = @request.auth.id',
        viewRule: 'status = "published"',
        createRule: '@request.auth.id != ""',
      },
      fields
    );
    assert.deepEqual(got.sort(), ['status', 'userId']);
  });

  test('collectRuleFieldNames melewati id dan nama di luar skema', () => {
    const got = collectRuleFieldNames(
      { listRule: 'id = @request.auth.id', viewRule: 'ghostField = "x"' },
      [{ name: 'userId', type: 'text' as const }]
    );
    assert.deepEqual(got, []);
  });

  test('index rule dibuat saat collection dibuat (SEARCH, bukan SCAN)', () => {
    const plan = queryPlan('nested_rules', 'userId');
    assert.match(plan, /SEARCH/, `harus memakai index, dapat: ${plan}`);
    assert.ok(
      listIndexes('nested_rules').includes('idx_nested_rules_userId_rule'),
      'index bernama idx_<col>_<field>_rule harus ada'
    );
  });

  test('collection TANPA rule pemilik tidak mendapat index rule', async () => {
    const res = await http(
      'POST',
      `/api/admin/projects/${projectId}/collections`,
      {
        name: 'no_rules_col',
        fields: [{ name: 'userId', type: 'text' }],
      },
      adminToken
    );
    assert.equal(res.status, 201);
    const idx = listIndexes('no_rules_col').filter((n) => n.endsWith('_rule'));
    assert.deepEqual(idx, [], 'tidak boleh membuat index yang tidak diminta rule');
  });

  test('index rule bertahan setelah PUT rebuild', async () => {
    const res = await http(
      'PUT',
      `/api/admin/projects/${projectId}/collections/nested_rules`,
      {
        fields: [
          { name: 'userId', type: 'text', required: true },
          { name: 'title', type: 'text' },
          { name: 'note', type: 'text' },
          { name: 'extra2', type: 'text' },
        ],
        rules: { listRule: OWNER_RULE },
      },
      adminToken
    );
    assert.equal(res.status, 200);

    const plan = queryPlan('nested_rules', 'userId');
    assert.match(plan, /SEARCH/, `rebuild harus membuat ulang index, dapat: ${plan}`);
  });

  test('field unique tidak mendapat index rule duplikat', async () => {
    const res = await http(
      'POST',
      `/api/admin/projects/${projectId}/collections`,
      {
        name: 'unique_owner',
        fields: [{ name: 'userId', type: 'text', required: true, unique: true }],
        rules: { listRule: OWNER_RULE },
      },
      adminToken
    );
    assert.equal(res.status, 201);

    const ruleIdx = listIndexes('unique_owner').filter((n) => n.endsWith('_rule'));
    assert.deepEqual(ruleIdx, [], 'UNIQUE INDEX sudah melayani predikat ini');
    assert.match(queryPlan('unique_owner', 'userId'), /SEARCH/);
  });
});
