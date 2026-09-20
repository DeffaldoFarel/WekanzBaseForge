import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BaseForge, MemoryAuthStore, ClientResponseError } from '../src/index.js';

// ============================================================================
// Ops-17 — 401 pada endpoint ANONIM tidak boleh disamarkan jadi SESSION_EXPIRED
// dan tidak boleh diam-diam me-refresh sesi lama.
//
// Regresi yang dilindungi:
//   - login salah password → INVALID_CREDENTIALS (bukan SESSION_EXPIRED)
//   - login gagal TIDAK menembak /auth/refresh milik sesi lama di store
//   - mfaChallenge / confirmPasswordReset salah token → error asli diteruskan
//   - NON-REGRESI M37: request terautentikasi 401 tetap auto-refresh + retry
// ============================================================================

const BASE_URL = 'http://localhost:5100';

describe('Ops-17: 401 pada endpoint anonim', () => {
  let adminToken = '';
  let projectId = '';
  const testEmail = `ops17_${Date.now()}@example.com`;
  const testPassword = 'PasswordOps17!';

  before(async () => {
    const loginRes = await fetch(`${BASE_URL}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@baseforge.local', password: 'admin123' }),
    });
    assert.equal(loginRes.status, 200, 'Admin login harus berhasil (server :5100 harus jalan)');
    adminToken = (await loginRes.json()).token;

    const projRes = await fetch(`${BASE_URL}/api/admin/projects`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `ops17_test_${Date.now()}` }),
    });
    assert.equal(projRes.status, 201, 'Create project harus berhasil');
    projectId = (await projRes.json()).project.id;
  });

  after(async () => {
    if (projectId) {
      await fetch(`${BASE_URL}/api/admin/projects/${projectId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
  });

  test('login salah password → INVALID_CREDENTIALS, sesi lama & refresh tak disentuh', async () => {
    const bf = new BaseForge({ baseUrl: BASE_URL, projectId });

    // Buat akun lalu login untuk mendapatkan sesi ASLI
    await bf.auth.register(testEmail, testPassword, 'User Ops17');
    const realRefresh = bf.authStore.refreshToken;
    assert.ok(realRefresh, 'sesi awal harus ada');

    // TUKAR refresh token dengan JEBAKAN: bila SDK menembak /auth/refresh
    // dengan ini, server akan menjawab 401 dan store akan di-clear — dan itu
    // sendiri adalah bukti bahwa login-gagal diam-diam me-refresh.
    const accessToken = bf.authStore.token;
    bf.authStore.save(accessToken, 'ops17-trap-invalid-refresh', bf.authStore.user);

    let err;
    try {
      await bf.auth.login(testEmail, 'SALAH-BANGET');
    } catch (e) {
      err = e;
    }

    assert.ok(err instanceof ClientResponseError, 'harus ClientResponseError');
    assert.equal(err.status, 401);
    assert.equal(err.code, 'INVALID_CREDENTIALS', `kode harus INVALID_CREDENTIALS, dapat ${err.code}`);

    // Sesi lama TIDAK boleh disentuh: refresh jebakan masih utuh di store,
    // bukti bahwa tidak ada tembakan /auth/refresh sama sekali.
    assert.equal(bf.authStore.refreshToken, 'ops17-trap-invalid-refresh', 'login gagal memicu refresh!');
    assert.equal(bf.authStore.token, accessToken, 'access token tidak boleh berubah');
  });

  test('login salah password TANPA sesi di store → tetap INVALID_CREDENTIALS', async () => {
    const bf = new BaseForge({ baseUrl: BASE_URL, projectId, authStore: new MemoryAuthStore() });
    let err;
    try {
      await bf.auth.login('takada@example.com', 'apapun');
    } catch (e) {
      err = e;
    }
    assert.equal(err.code, 'INVALID_CREDENTIALS');
    assert.equal(bf.authStore.token, '', 'store kosong harus tetap kosong');
  });

  test('mfaChallenge dengan mfaToken ngawur → error asli, bukan SESSION_EXPIRED', async () => {
    const bf = new BaseForge({ baseUrl: BASE_URL, projectId });
    let err;
    try {
      await bf.auth.mfaChallenge('mfa-token-ngawur', '123456');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ClientResponseError);
    assert.notEqual(err.code, 'SESSION_EXPIRED', `kode: ${err.code}`);
    assert.ok([400, 401].includes(err.status), `status: ${err.status}`);
  });

  test('confirmPasswordReset dengan token kedaluwarsa → error asli, bukan SESSION_EXPIRED', async () => {
    const bf = new BaseForge({ baseUrl: BASE_URL, projectId });
    let err;
    try {
      await bf.auth.confirmPasswordReset('token-kedaluwarsa-ngawur', 'PasswordBaru123!');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ClientResponseError);
    assert.notEqual(err.code, 'SESSION_EXPIRED', `kode: ${err.code}`);
    assert.ok([400, 401].includes(err.status), `status: ${err.status}`);
  });

  test('NON-REGRESI M37: request terautentikasi 401 → auto-refresh → retry sukses', async () => {
    const bf = new BaseForge({ baseUrl: BASE_URL, projectId });
    await bf.auth.login(testEmail, testPassword);

    // Rusakkan HANYA access token; refresh token asli tetap valid.
    bf.authStore.save('access-token-basi', bf.authStore.refreshToken, bf.authStore.user);

    // me() adalah endpoint terautentikasi → 401 → refresh → retry → 200
    const res = await bf.auth.me();
    assert.equal(res.user.email, testEmail);
    assert.notEqual(bf.authStore.token, 'access-token-basi', 'token harus hasil refresh');
  });

  test('NON-REGRESI M37: refresh token ngawur → SESSION_EXPIRED + store cleared', async () => {
    const bf = new BaseForge({ baseUrl: BASE_URL, projectId });
    bf.authStore.save('access-token-ngawur', 'refresh-ngawur', {
      id: 'u', email: testEmail,
    });
    let err;
    try {
      await bf.auth.me();
    } catch (e) {
      err = e;
    }
    assert.equal(err.code, 'SESSION_EXPIRED');
    assert.equal(bf.authStore.token, '', 'store harus dibersihkan');
  });
});
