# @wekanz/baseforge 🚀

Official lightweight, zero-dependency TypeScript & JavaScript SDK for **WekanzBaseForge** BaaS platform.

Designed with ergonomics similar to PocketBase, making integration with modern frontend apps (React, Next.js, Vue, Svelte, React Native) effortless.

---

## 📦 Installation

```bash
# In your frontend project
npm install @wekanz/baseforge
```

Or reference locally within a monorepo / workspaces:
```json
{
  "dependencies": {
    "@wekanz/baseforge": "workspace:*"
  }
}
```

---

## ⚡ Quick Start

```typescript
import { BaseForge } from '@wekanz/baseforge';

// 1. Initialize client
const bf = new BaseForge({
  baseUrl: 'http://localhost:5100', // URL BaseForge server Anda
  projectId: 'your_project_id'       // ID project target
});

// 2. Authentication (End-User)
await bf.auth.login('user@example.com', 'password123');

console.log('Logged in user:', bf.auth.user);
console.log('Access token:', bf.auth.token);
console.log('Is logged in:', bf.auth.isValid);

// 3. CRUD Records
interface Post {
  id: string;
  title: string;
  content: string;
  tags?: string[];
}

// Fetch list with pagination & filter
const posts = await bf.collection<Post>('posts').getList(1, 20, {
  filter: 'status = "published"',
  sort: '-created',
  search: 'backend'
});

// Create new record
const newPost = await bf.collection<Post>('posts').create({
  title: 'Halo BaseForge',
  content: 'Membuat backend terasa menyenangkan!',
  tags: ['baas', 'sqlite']
});

// Get single record
const post = await bf.collection<Post>('posts').getOne(newPost.id);

// Update record
await bf.collection<Post>('posts').update(post.id, {
  title: 'Halo BaseForge (Updated)'
});

// Delete record
await bf.collection('posts').delete(post.id);
```

---

## 📁 File Uploads & Thumbnails

### Uploading Files (FormData)
```typescript
const formData = new FormData();
formData.append('title', 'Foto Liburan');
formData.append('image', fileInput.files[0]);

const record = await bf.collection('photos').create(formData);
```

### Generating Image URLs
```typescript
// Original file
const rawUrl = bf.files.getUrl('photos', record.id, record.image);

// Auto-generated thumbnail
const thumbUrl = bf.files.getUrl('photos', record.id, record.image, {
  thumb: '100x100' // '100x100', '300x0', '0x200', '200x200f'
});
```

---

## 📡 Realtime Subscriptions (SSE)

```typescript
// Subscribe to all changes in 'messages' collection
const unsubscribe = await bf.realtime.subscribe('messages/*', (event) => {
  console.log('Action:', event.action); // 'create' | 'update' | 'delete'
  console.log('Record:', event.record);
});

// Unsubscribe when done (e.g. React useEffect cleanup)
await unsubscribe();
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
