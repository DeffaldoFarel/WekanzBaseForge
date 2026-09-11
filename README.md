# WekanzBaseForge 🛠️

> **Project belajar: membangun backend lengkap dari bawah — SQL database, auth, storage, functions — untuk memahami cara kerjanya.**

⚠️ **Status: Learning playground.** Ini BUKAN untuk production. Wekanz production tetap memakai PocketBase + WBS (WekanzBackendService).

---

## 🎯 Tujuan Project

Membangun ulang komponen-komponen backend yang selama ini kita pakai sebagai "black box" (PocketBase, Firebase) — satu per satu, dari fondasi — agar benar-benar paham:

- Bagaimana data disimpan & di-query (database engine di atas SQLite)
- Bagaimana index mempercepat pencarian
- Bagaimana transaksi menjaga data tetap konsisten (ACID, WAL)
- Bagaimana auth bekerja (hashing, JWT, session, OAuth2)
- Bagaimana API otomatis di-generate dari skema
- Bagaimana realtime subscription bekerja

## 🧭 Prinsip Project

1. **Belajar > cepat selesai.** Setiap komponen ditulis dengan pemahaman, bukan copy-paste.
2. **Bangun di atas fondasi teruji** — SQLite sebagai mesin penyimpanan (seperti PocketBase), bukan dari nol.
3. **Tidak ada beban production** — bebas rusak, bebas refactor, bebas lambat.
4. **Dokumentasikan setiap "aha!"** — setiap konsep yang dipahami dicatat di `docs/`.

## 🗺️ Roadmap Belajar (milestone berurutan)

| # | Milestone | Konsep yang Dipelajari |
|---|-----------|------------------------|
| 1 | **KV Store sederhana** | File storage, serialisasi, CRUD dasar |
| 2 | **SQLite integration** | SQL, tabel dinamis, query builder |
| 3 | **Schema & collections** | Metadata, migrasi, validasi |
| 4 | **Query parser** | Lexer/parser untuk filter (`streak > 5`) |
| 5 | **REST API generator** | CRUD endpoints otomatis, pagination, sorting |
| 6 | **Indexing** | B-Tree, query planning, benchmark |
| 7 | **Transactions** | ACID, rollback, WAL, crash recovery |
| 8 | **Auth: password** | Hashing (bcrypt/argon2), salt, timing attacks |
| 9 | **Auth: tokens** | JWT, refresh tokens, session management |
| 10 | **Auth: OAuth2** | Google login flow end-to-end |
| 11 | **API rules** | Row-level security, rule evaluator |
| 12 | **Relasi & expand** | JOIN dinamis, N+1 problem |
| 13 | **Realtime** | WebSocket, broadcast dengan filter |
| 14 | **File storage** | Upload, serving, thumbnails |
| 15 | **Functions & triggers** | Eksekusi kode user, event hooks |

Setiap milestone = folder sendiri di `src/` + catatan pembelajaran di `docs/`.

## 📁 Struktur (akan tumbuh seiring milestone)

```
WekanzBaseForge/
├── src/
│   └── m01-kv-store/     (dst per milestone)
├── docs/
│   └── learnings/        ← catatan "aha!" per konsep
├── README.md             ← file ini
└── package.json
```

## 🔗 Relasi dengan Project Lain

| Project | Peran |
|---------|-------|
| WekanzBackendService (WBS) | Production compute layer (functions, queue, cron) — **tidak tersentuh** |
| PocketBase | Production database + auth — **tidak tergantikan** |
| WekanzBaseForge | Lab belajar — berdiri sendiri |

---

*Dimulai: 2026 — sebagai wahana memahami backend secara mendalam.*
