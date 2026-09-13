import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BaseForge, MemoryAuthStore, ClientResponseError } from '../src/index.js';

const BASE_URL = 'http://localhost:5100';

describe('BaseForge Client SDK', () => {
  let adminToken = '';
  let projectId = '';
  const testEmail = `sdk_${Date.now()}@example.com`;
  const testPassword = 'PasswordSDK123!';

  before(async () => {
    // 1. Dapatkan token admin untuk membuat project test
    const loginRes = await fetch(`${BASE_URL}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@baseforge.local',
        password: 'admin123',
      }),
    });
    assert.equal(loginRes.status, 200, 'Admin login harus berhasil');
    const loginData = await loginRes.json();
    adminToken = loginData.token;

    // 2. Buat project uji baru
    const projRes = await fetch(`${BASE_URL}/api/admin/projects`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: `sdk_test_${Date.now()}` }),
    });
    assert.equal(projRes.status, 201, 'Create project harus berhasil');
    const projData = await projRes.json();
    projectId = projData.project.id;

    // 3. Buat koleksi 'bookmarks' dengan rules publik/auth
    await fetch(`${BASE_URL}/api/admin/projects/${projectId}/collections`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'bookmarks',
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'url', type: 'url' },
          { name: 'tags', type: 'json' },
        ],
      }),
    });

    // Beri rule publik agar bisa diakses oleh test
    await fetch(`${BASE_URL}/api/admin/projects/${projectId}/collections/bookmarks/rules`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        listRule: '',
        viewRule: '',
        createRule: '',
        updateRule: '',
        deleteRule: '',
      }),
    });
  });

  after(async () => {
    // Bersihkan project uji
    if (projectId && adminToken) {
      await fetch(`${BASE_URL}/api/admin/projects/${projectId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${adminToken}` },
      });
    }
  });

  test('Inisialisasi BaseForge Client & AuthStore', () => {
    const authStore = new MemoryAuthStore();
    const bf = new BaseForge({
      baseUrl: BASE_URL,
      projectId: 'demo_proj',
      authStore,
    });

    assert.equal(bf.baseUrl, BASE_URL);
    assert.equal(bf.projectId, 'demo_proj');
    assert.equal(bf.auth.isValid, false);
    assert.equal(bf.auth.user, null);
    assert.equal(bf.auth.token, '');

    // Uji setProject
    bf.setProject('changed_proj');
    assert.equal(bf.projectId, 'changed_proj');
  });

  test('AuthStore: save, notify onChange, dan clear', () => {
    const store = new MemoryAuthStore();
    let notified = false;

    const unsubscribe = store.onChange((token, user) => {
      notified = true;
      assert.equal(token, 'fake_token');
      assert.equal(user?.email, 'test@x.com');
    });

    store.save('fake_token', 'fake_refresh', {
      id: 'u1',
      email: 'test@x.com',
      verified: false,
      created: new Date().toISOString(),
    });

    assert.equal(notified, true);
    assert.equal(store.isValid, true);
    assert.equal(store.token, 'fake_token');

    unsubscribe();
    store.clear();
    assert.equal(store.isValid, false);
    assert.equal(store.token, '');
  });

  test('FilesService: generate file URL & thumbnail query', () => {
    const bf = new BaseForge({ baseUrl: BASE_URL, projectId: 'proj_123' });

    const rawUrl = bf.files.getUrl('photos', 'rec_456', 'avatar.png');
    assert.equal(rawUrl, `${BASE_URL}/api/files/proj_123/photos/rec_456/avatar.png`);

    const thumbUrl = bf.files.getUrl('photos', 'rec_456', 'avatar.png', { thumb: '100x100' });
    assert.equal(thumbUrl, `${BASE_URL}/api/files/proj_123/photos/rec_456/avatar.png?thumb=100x100`);
  });

  test('AuthService: Register, Login, Me, dan Logout via SDK', async () => {
    const bf = new BaseForge({ baseUrl: BASE_URL, projectId });

    // 1. Register
    const regRes = await bf.auth.register(testEmail, testPassword, 'SDK User');
    assert.ok(regRes.accessToken);
    assert.ok(regRes.refreshToken);
    assert.equal(regRes.user.email, testEmail);
    assert.equal(bf.auth.isValid, true);
    assert.equal(bf.auth.user?.email, testEmail);

    // 2. Me
    const meRes = await bf.auth.me();
    assert.equal(meRes.user.email, testEmail);

    // 3. Logout
    await bf.auth.logout();
    assert.equal(bf.auth.isValid, false);
    assert.equal(bf.auth.token, '');

    // 4. Login kembali
    const loginRes = await bf.auth.login(testEmail, testPassword);
    assert.ok(loginRes.accessToken);
    assert.equal(bf.auth.isValid, true);
    assert.equal(bf.auth.user?.id, regRes.user.id);
  });

  test('RecordService: CRUD Records via SDK (getList, getOne, create, update, delete)', async () => {
    const bf = new BaseForge({ baseUrl: BASE_URL, projectId });

    // 1. Create Record
    const created = await bf.collection('bookmarks').create({
      title: 'Dokumentasi BaseForge',
      url: 'https://baseforge.wekanz.id',
      tags: ['docs', 'baas'],
    });

    assert.ok(created.id, 'Record ID harus terbuat');
    assert.equal(created.title, 'Dokumentasi BaseForge');
    assert.deepEqual(created.tags, ['docs', 'baas']);

    const recordId = created.id as string;

    // 2. Get One
    const fetched = await bf.collection('bookmarks').getOne(recordId);
    assert.equal(fetched.id, recordId);
    assert.equal(fetched.title, 'Dokumentasi BaseForge');

    // 3. Update Record
    const updated = await bf.collection('bookmarks').update(recordId, {
      title: 'Dokumentasi BaseForge (Updated)',
    });
    assert.equal(updated.title, 'Dokumentasi BaseForge (Updated)');

    // 4. Get List
    const list = await bf.collection('bookmarks').getList(1, 10, {
      filter: 'title ~ "Updated"',
      sort: '-created',
    });
    assert.ok(list.totalItems >= 1);
    assert.equal(list.items[0].id, recordId);

    // 5. Get First List Item
    const first = await bf.collection('bookmarks').getFirstListItem('title ~ "Updated"');
    assert.equal(first.id, recordId);

    // 6. Delete Record
    const deleted = await bf.collection('bookmarks').delete(recordId);
    assert.equal(deleted, true);

    // 7. Verifikasi sudah terhapus (harus throw ClientResponseError 404)
    await assert.rejects(
      async () => {
        await bf.collection('bookmarks').getOne(recordId);
      },
      (err: ClientResponseError) => {
        assert.equal(err.status, 404);
        return true;
      }
    );
  });

  test('RecordService: Auth Collection authWithPassword & authRefresh (PocketBase Parity)', async () => {
    // 1. Buat auth collection 'staff'
    await fetch(`${BASE_URL}/api/admin/projects/${projectId}/collections`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'staff',
        type: 'auth',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'role', type: 'select', options: { values: ['editor', 'admin'] } },
        ],
        rules: {
          listRule: '',
          viewRule: '',
          createRule: '',
          updateRule: '',
          deleteRule: '',
        },
      }),
    });

    const bf = new BaseForge({ baseUrl: BASE_URL, projectId });

    // 2. Register staff via collection create
    const newStaff = await bf.collection('staff').create({
      email: 'staff@wekanz.id',
      password: 'StaffSecretPass123!',
      name: 'Staff Wekanz',
      role: 'editor',
    });
    assert.ok(newStaff.id);
    assert.equal(newStaff.email, 'staff@wekanz.id');
    assert.equal(newStaff.role, 'editor');

    // 3. Login via collection.authWithPassword
    const authData = await bf.collection('staff').authWithPassword('staff@wekanz.id', 'StaffSecretPass123!');
    assert.ok(authData.token);
    assert.equal(authData.record.name, 'Staff Wekanz');
    assert.equal(authData.record.role, 'editor');
    assert.equal(bf.auth.isValid, true);
    assert.equal(bf.auth.token, authData.token);

    // 4. Refresh auth session
    const refreshed = await bf.collection('staff').authRefresh();
    assert.ok(refreshed.token);
    assert.equal(refreshed.record.name, 'Staff Wekanz');
  });
});
