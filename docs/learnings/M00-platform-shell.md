# M00 — Platform Shell: Admin Auth & Project Registry

> **Konsep yang dipelajari:** arsitektur multi-tenant, dua lapisan database (platform vs project), HTTP router dari nol, token sederhana.

## 🎯 Tujuan Milestone

Membangun "cangkang" platform tempat semua milestone berikutnya hidup:

1. **Admin login** — autentikasi pengelola BaseForge (versi sederhana: env var + token di memori; hashing proper datang di M08)
2. **Project registry** — CRUD projects, tersimpan di `data/platform.db`
3. **Project database provisioning** — setiap project dapat file SQLite sendiri di `data/projects/<id>/data.db`
4. **HTTP router buatan sendiri** — di atas `node:http`, tanpa framework, supaya paham apa yang sebenarnya dilakukan Express/Fastify

## 🧠 Konsep Kunci

### 1. Dua lapisan database

```
data/platform.db          ← milik PLATFORM: tabel admins, projects
data/projects/wekanz/data.db  ← milik PROJECT "wekanz": collections, users, dll
data/projects/blog/data.db    ← milik PROJECT "blog"
```

**Kenapa dipisah?** Isolasi. Platform rusak ≠ project rusak. Backup per project = copy 1 file.
Ini juga yang dilakukan PocketBase (pb_data terpisah per instalasi) dan Firebase (data per project).

### 2. Dua jenis user (JANGAN TERTUKAR)

| | Admin (platform) | End user (project) |
|---|---|---|
| Siapa | Pengelola BaseForge | Pengguna aplikasi (misal user Wekanz) |
| Login | Dashboard BaseForge | Aplikasi project (M09/M10) |
| Data disimpan | `platform.db` | `projects/<id>/data.db` |
| Dibangun | **M00 (ini), sederhana** | M08-M11, proper |

### 3. Kenapa router dari nol?

Express hanyalah pembungkus `node:http`. Dengan membangun router mini (method + path pattern + params), kita memahami:
- Bagaimana URL dipecah menjadi segmen
- Bagaimana `:id` menjadi parameter
- Bagaimana middleware chaining bekerja
- Bahwa "framework" itu bukan magic — hanya ~100 baris kode

## 📐 API yang Dibangun di M00

### Admin API (untuk Dashboard)

```
POST   /api/admin/auth/login        { email, password } → { token, admin }
GET    /api/admin/projects          → daftar project (butuh token)
POST   /api/admin/projects          { name, services } → project baru
GET    /api/admin/projects/:id      → detail project
PATCH  /api/admin/projects/:id      → update (nama, service toggles)
DELETE /api/admin/projects/:id      → hapus project + file-nya
GET    /api/health                  → status server
```

### Struktur data

```typescript
// platform.db
interface AdminRow {        // M00: dari env, belum di DB
  email: string;
}

interface ProjectRow {
  id: string;               // 15-char random (seperti PocketBase)
  name: string;
  services: string;         // JSON: {database, auth, storage, functions}
  created: string;          // ISO date
  updated: string;
}
```

### Auth sederhana M00

```
.env: ADMIN_EMAIL, ADMIN_PASSWORD (plaintext, sementara!)
login cocok → terbitkan token random (crypto.randomBytes) →
token disimpan di MAP di memori → hilang saat restart (OK untuk M00)
M08 akan mengganti ini dengan hashing + token persisten.
```

## ✅ Definisi Selesai

- [ ] `GET /api/health` merespons
- [ ] Login dengan kredensial env → dapat token
- [ ] Buat project → muncul di list + file `data/projects/<id>/data.db` terbuat
- [ ] Detail/update/delete project bekerja
- [ ] Request tanpa token → 401
- [ ] Test: `npm test` hijau untuk semua endpoint

## 📝 Catat Aha! Moments di Sini

### Aha! #1 — Framework itu bukan magic
Router yang kita tulis (matching `:id`, middleware chain, parse body) hanya
~150 baris — dan itulah inti Express. Selama ini kita memakai `req.params.id`
tanpa tahu bahwa itu hanyalah pencocokan segmen string. Sekarang kita TAHU.

### Aha! #2 — Request body itu STREAM, bukan data siap pakai
`express.json()` menyembunyikan fakta bahwa body datang chunk demi chunk
lewat jaringan dan harus dikumpulkan dulu. Itulah kenapa parsing body itu
async di Node asli.

### Aha! #3 — Login = server yang "mengingat"
Token di memori (Map) memperlihatkan esensi session: STATE di server.
Inilah yang nanti membedakan session stateful (M00 ini) dengan JWT
stateless (M09) — di JWT, "ingatan" dipindah ke dalam token itu sendiri.

### Aha! #4 — timingSafeEqual itu penting bahkan untuk hal kecil
Perbandingan `===` berhenti di karakter pertama yang beda — attacker bisa
mengukur WAKTU respons untuk menebak password karakter per karakter.
Membandingkan dengan waktu konstan menutup celah itu.

### Aha! #5 — Meta-database
`platform.db` tidak menyimpan data user — ia menyimpan data TENTANG projects.
Inilah pola yang sama yang akan kita pakai lagi di M03: `_collections`
menyimpan data TENTANG collections. Database yang mendeskripsikan database.

### Aha! #6 — Native dependency itu rapuh
`better-sqlite3` gagal compile di Windows (butuh Visual C++ build tools).
Solusinya justru lebih baik: `node:sqlite` bawaan Node 24 — zero dependency,
API sinkron yang sama. Pelajaran: setiap dependency adalah tanggungan.

## ✅ Status: SELESAI (11/11 test lulus) — 2026-09-11
