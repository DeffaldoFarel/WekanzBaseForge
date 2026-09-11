# WekanzBaseForge 🛠️

> **Project belajar: membangun complete backend dari bawah — SQL database, auth, functions, storage, dan dashboard admin — untuk memahami cara kerjanya.**

⚠️ **Status: Learning playground.** BUKAN untuk production. Wekanz production tetap memakai PocketBase + WBS (WekanzBackendService).

---

## 🎯 Visi

Seperti Firebase Console: satu BaseForge bisa menampung **banyak project**, dan setiap project bisa mengaktifkan **layanan** yang dibutuhkannya:

```
BaseForge (1 instalasi)
 └── 📁 Projects
      ├── Project "wekanz"    → database ✅ auth ✅ storage ✅
      ├── Project "bookmark"  → database ✅ functions ✅
      └── Project "blog"      → database ✅ saja
```

**Prinsip arsitektur (meniru PocketBase):**
- Setiap project = **1 file SQLite terpisah** (`data/projects/<id>/data.db`)
- Isolasi total antar project; backup/hapus/pindah = copy/hapus file
- Dashboard = client murni dari Admin API (semua bisa via API)

**Dua jenis user (jangan tertukar!):**
| Jenis | Contoh | Login di |
|-------|--------|----------|
| **Admin** | developer pengelola BaseForge | Dashboard BaseForge |
| **End user** | pengguna aplikasi (misal user Wekanz) | Auth service per project |

## 🧰 Tech Stack

| Komponen | Pilihan | Alasan |
|----------|---------|--------|
| Bahasa | TypeScript (Node.js 22) | Fokus ke konsep, bukan belajar bahasa |
| Mesin database | SQLite via `better-sqlite3` | Strategi PocketBase: mesin teruji 25 thn, kita bangun lapisan di atasnya |
| HTTP server | `node:http` → router buatan sendiri | Belajar cara kerja framework |
| Dashboard | Next.js + Tailwind + shadcn/ui | Stack yang sudah dikuasai |
| Hashing (M08) | `argon2` | Standar modern |
| JWT (M09) | `jose` | Minimal & modern |
| Functions (M15) | `node:vm` | Isolasi kode user |
| Test | `node:test` | Bawaan Node |

## 🗺️ Roadmap (per milestone)

### 🏗️ Fondasi Platform
- [ ] **M00** — Shell: platform.db, admin login (sederhana dulu), project registry API, dashboard login + project picker + project detail kosong

### 📦 SQL Database
- [ ] M01 — KV store sederhana
- [ ] M02 — SQLite + raw queries (prepared statements)
- [ ] M03 — Meta-tables: schema-as-data (inti strategi PocketBase!)
- [ ] M04 — Query parser (filter string → SQL, lexer/parser/AST)
- [ ] M05 — Record API + REST endpoints generik
- [ ] M06 — Indexing & EXPLAIN QUERY PLAN
- [ ] M07 — Transactions, ACID & WAL
- [ ] M12 — Relations & expand (JOIN dinamis, N+1)
- [ ] M05u 🖥️ — Dashboard: schema builder + data browser

### 🔐 Auth (per project)
- [ ] M08 — Password hashing
- [ ] M09 — JWT + sessions + refresh tokens
- [ ] M10 — OAuth2 (Google)
- [ ] M11 — API rules (row-level security)
- [ ] M10u 🖥️ — Dashboard: user management + rules editor

### ⚡ Functions (per project)
- [ ] M15a — Code editor + vm isolation
- [ ] M15b — Database triggers
- [ ] M15c — Scheduler (cron)
- [ ] M15u 🖥️ — Dashboard: function editor + logs

### 📁 Storage (per project)
- [ ] M14a — Upload/serving per project
- [ ] M14b — Image processing (Sharp)
- [ ] M14u 🖥️ — Dashboard: file browser

### 📡 Tambahan
- [ ] M13 — Realtime subscriptions (WebSocket)

## 📁 Struktur

```
WekanzBaseForge/
├── server/                 ← BaseForge core (API + engine)
│   ├── src/
│   │   ├── core/           ← engine: db, schema, records, query
│   │   ├── platform/       ← multi-project: registry, admin auth
│   │   ├── api/
│   │   │   ├── admin/      ← /api/admin/* (untuk dashboard)
│   │   │   └── client/     ← /api/projects/:id/* (untuk aplikasi end user)
│   │   └── index.ts
│   └── package.json
├── dashboard/              ← Next.js admin UI
│   └── app/
│       ├── login/
│       ├── projects/       ← daftar project (seperti Firebase home)
│       └── projects/[id]/  ← detail project (per layanan)
├── data/                   ← semua data (seperti pb_data)
│   ├── platform.db         ← admin accounts + project registry
│   └── projects/<id>/
│       ├── data.db         ← SQLite per project
│       └── files/          ← storage per project
├── docs/learnings/         ← jurnal "aha!" per milestone
└── README.md
```

## 🔗 Relasi dengan Project Lain

| Project | Peran |
|---------|-------|
| WekanzBackendService (WBS) | Production compute — **tidak tersentuh** |
| PocketBase | Production database + auth — **tidak tergantikan** |
| **WekanzBaseForge** | Lab belajar — berdiri sendiri |

## 🧭 Prinsip Belajar

1. **Belajar > cepat selesai** — setiap komponen ditulis dengan pemahaman
2. **Bangun di atas fondasi teruji** (SQLite), bukan dari nol
3. **Tidak ada beban production** — bebas rusak, refactor, lambat
4. **Dokumentasikan setiap "aha!"** di `docs/learnings/`

---

*Dimulai 2026 — wahana memahami backend secara mendalam.*
