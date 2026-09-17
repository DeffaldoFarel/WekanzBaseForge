# 📚 WekanzBaseForge Documentation

Selamat datang di dokumentasi resmi **WekanzBaseForge** — backend platform *self-hosted* multi-project (BaaS) yang menyediakan database SQL relasional, autentikasi, file storage, realtime subscriptions, dan serverless functions dalam satu paket yang ringan dan terisolasi.

---

## 🧭 Daftar Panduan

Dokumentasi ini disusun untuk membantu developer membangun aplikasi dengan BaseForge:

| Panduan | Deskripsi |
|---|---|
| [**1. Getting Started**](./getting-started.md) | Prasyarat, instalasi, struktur proyek, konfigurasi environment (`.env`), fitur opsional (OAuth2, SMTP, stats), dan kredensial bawaan. |
| [**2. REST API Reference**](./api-reference.md) | Dokumentasi endpoint lengkap untuk aplikasi klien: Auth (password, **OAuth2 ×7 provider**, MFA/TOTP, verifikasi email & reset password, API keys), CRUD Records, filter query, nested expand relasi, pencarian FTS5, agregasi, vector search, file upload/S3, webhooks, backup, dan usage stats. |
| [**3. Client SDK (TypeScript)**](../packages/client/README.md) | SDK resmi `@wekanz/baseforge` untuk React, Next.js, Vue, React Native, dan Node.js. |
| [**4. API Rules (Security)**](./api-rules.md) | Konfigurasi keamanan Row-Level Security (RLS) berbasis ekspresi `@request.auth` dan aturan per-koleksi. |
| [**5. Realtime Subscriptions**](./realtime.md) | Panduan langganan event data secara live melalui Server-Sent Events (SSE). |
| [**6. Serverless Functions**](./functions.md) | Menulis fungsi kustom di sandbox V8 isolate (`isolated-vm`), triggers otomatis database, dan scheduler cron. |
| [**7. Deployment & Production**](./deployment.md) | Panduan deploy ke server VPS menggunakan Linux Systemd, reverse proxy HTTPS Caddy, Redis, dan konfigurasi SMTP produksi. |
| [**8. Architectural Learnings**](./learnings/README.md) | Jurnal teknis internal dan catatan pembelajaran milestone (M00 s/d M33). |

---

## 🎯 Konsep Inti BaseForge

1. **Multi-Project dalam Satu Instalasi**: Satu instalasi BaseForge dapat menampung banyak aplikasi independen. Setiap project memiliki database SQLite terpisah (`data/projects/<id>/data.db`), memastikan isolasi data total.
2. **Dua Jenis User**:
   * **Admin**: Pengelola platform yang masuk melalui Dashboard Console (`:7701`) untuk mengelola skema, rules, dan functions.
   * **End-User**: Pengguna aplikasi akhir yang mendaftar dan login melalui endpoint autentikasi per-project (`/api/p/:pid/auth/*`).
3. **Single-Gate Engine**: Semua aturan keamanan (API Rules) dievaluasi di layer SQL query, sehingga klien web atau mobile tidak bisa mengeksekusi operasi yang tidak diizinkan.
