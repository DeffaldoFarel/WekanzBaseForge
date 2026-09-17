# @wekanz/baseforge 🚀

Official lightweight, zero-dependency TypeScript & JavaScript SDK for **WekanzBaseForge** BaaS platform.

Designed with ergonomics similar to PocketBase, making integration with modern frontend apps (React, Next.js, Vue, Svelte, React Native) effortless.

---

## 📦 Installation

```bash
npm install @wekanz/baseforge
```

---

## ⚡ Quick Start

```typescript
import { BaseForge } from '@wekanz/baseforge';

// 1. Initialize client
const bf = new BaseForge({
  baseUrl: 'https://baseforge.example.com', // URL BaseForge server Anda
  projectId: 'your_project_id'               // ID project target
});

// 2. Authentication (End-User)
await bf.auth.login('user@example.com', 'password123');

console.log('Logged in user:', bf.auth.user);
console.log('Is logged in:', bf.auth.isValid);

// 3. CRUD Records
interface Post {
  id: string;
  title: string;
  content: string;
  tags?: string[];
}

const posts = await bf.collection<Post>('posts').getList(1, 20, {
  filter: 'status = "published"',
  sort: '-created',
  search: 'backend'
});

const newPost = await bf.collection<Post>('posts').create({
  title: 'Halo BaseForge',
  content: 'Membuat backend terasa menyenangkan!',
  tags: ['baas', 'sqlite']
});

const post = await bf.collection<Post>('posts').getOne(newPost.id);

await bf.collection<Post>('posts').update(post.id, {
  title: 'Halo BaseForge (Updated)'
});

await bf.collection('posts').delete(post.id);
```

---

## 🆔 Custom Document ID (migrasi Appwrite/PocketBase)

Buat record dengan ID pilihan Anda — misalnya untuk mempertahankan ID yang
sudah ada dari backend lama, atau ID komposit seperti `userId_theme`:

```typescript
const pref = await bf.collection('preferences').createWithId(
  `${userId}_theme`,
  { colorTheme: 'dark' }
);
// Alternatif: bf.collection('preferences').create({ id: 'my-id', ... })
// Duplikat ID → ClientResponseError status 409 (DOCUMENT_ID_TAKEN)
```

---

## 🔐 Auth & Session (long-running SPA ready)

Access token (15 menit) + refresh token. **401 auto-refresh bekerja
otomatis** di semua service: request yang kedaluwarsa memicu satu refresh
(singleton lock — N request bersamaan hanya memicu 1 POST refresh), lalu
request asli di-retry tanpa campur tangan kode Anda.

```typescript
await bf.auth.register('user@example.com', 'password123', 'Nama');
await bf.auth.login('user@example.com', 'password123');

const me = await bf.auth.me();        // validasi/ambil profil aktif
await bf.auth.refresh();              // refresh manual bila perlu
await bf.auth.logout();               // cabut sesi di server + clear store
```

AuthStore: `LocalStorageAuthStore` (browser, default) dan
`MemoryAuthStore` (SSR/Node) — pilih via `new BaseForge({ authStore })`.

---

## 📁 File Uploads & Thumbnails

```typescript
const formData = new FormData();
formData.append('title', 'Foto Liburan');
formData.append('image', fileInput.files[0]);

const record = await bf.collection('photos').create(formData);

// URL file + thumbnail
const rawUrl = bf.files.getUrl('photos', record.id, record.image);
const thumbUrl = bf.files.getUrl('photos', record.id, record.image, {
  thumb: '100x100' // '100x100', '300x0', '0x200', '200x200f'
});
```

### Bucket Storage (file decoupled dari record)

Upload file tanpa record — dapat `fileId` untuk disematkan di mana saja
(rich text editor, attachments). Determinate `fileId` = overwrite idempoten
(cocok untuk migrasi dari Appwrite/Firebase).

```typescript
const file = await bf.files.upload(formData);        // → { fileId, url, ... }
const url = bf.files.getBucketUrl(file.fileId);       // serve publik + cache
await bf.files.list();                                // file milik user aktif
await bf.files.delete(file.fileId);                   // owner/admin only
```

---

## 📡 Realtime Subscriptions (SSE, auto-reconnect)

Koneksi SSE yang putus (network glitch, proxy timeout, server restart)
**otomatis reconnect** dengan exponential backoff (1s → 30s cap), me-re-sync
semua subscription aktif ke clientId baru, dan memicu hook `onReconnect`
agar Anda bisa re-fetch data awal.

```typescript
bf.realtime.onReconnect(() => {
  console.log('Reconnected — saatnya re-fetch initial data');
});

const unsubscribe = await bf.realtime.subscribe('messages/*', (event) => {
  console.log('Action:', event.action); // 'create' | 'update' | 'delete'
  console.log('Record:', event.record); // delete: full payload snapshot
});

await unsubscribe(); // guard: unsubscribe ≠ koneksi putus
```

---

## ⚡ Callable Functions

```typescript
const response = await bf.functions.execute('calculateDiscount', {
  code: 'PROMO10',
  total: 50000
});

console.log('Result:', response.result);
console.log('Logs:', response.logs);
```

---

## 🛡️ License

MIT
