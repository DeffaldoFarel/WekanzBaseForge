# 🚀 Getting Started

Panduan ini memandu Anda mulai dari persiapan lingkungan hingga menjalankan backend dan dashboard BaseForge di mesin lokal Anda.

---

## 📋 Prasyarat Sistem

BaseForge dirancang seringan mungkin tanpa perlu database eksternal. Namun, karena BaseForge memanfaatkan modul bawaan terbaru Node.js yaitu `node:sqlite`, pastikan versi Node.js Anda memenuhi syarat:

* **Node.js**: Versi **`>= 22.5.0`** (Wajib, unduh di [nodejs.org](https://nodejs.org))
* **npm**: Versi **`>= 10.0.0`** (otomatis terpasang bersama Node.js)
* **OS**: Linux, macOS, atau Windows 10/11 (64-bit / ARM64)

Verifikasi versi Anda di terminal:
```bash
node -v   # harus v22.5.0 atau lebih baru
npm -v    # v10.x atau lebih baru
```

---

## 📦 1. Clone & Instalasi

BaseForge menggunakan struktur **npm workspaces**, sehingga Anda dapat menginstall dependensi untuk backend dan frontend dashboard sekaligus dalam satu perintah:

```bash
# Clone repositori
git clone https://github.com/DeffaldoFarel/WekanzBaseForge.git
cd WekanzBaseForge

# Install seluruh dependencies (server + dashboard)
npm install
```

---

## ⚡ 2. Menjalankan Service

Jalankan server backend dan dashboard web di dua terminal terpisah:

### Terminal 1: Backend Server API
```bash
npm run dev:server
```
* Backend akan aktif di **`http://localhost:5100`**
* Tes kesehatan server: `http://localhost:5100/api/health`
* Saat dijalankan pertama kali, server akan otomatis membuat direktori `data/` dan menginisialisasi database platform.

### Terminal 2: Admin Dashboard (Next.js)
```bash
npm run dev:dashboard
```
* Dashboard web akan aktif di **`http://localhost:7701`**

---

## 🔐 3. Login Admin Pertama Kali

Buka browser Anda dan kunjungi **`http://localhost:7701`**.

Gunakan kredensial pengembang bawaan (*default development credentials*):
* **Email:** `admin@baseforge.local`
* **Password:** `admin123`

Setelah berhasil login, Anda akan masuk ke halaman konsol utama untuk membuat project pertama Anda!

---

## ⚙️ 4. Konfigurasi Environment (`.env`)

Secara *default*, BaseForge siap berjalan tanpa file `.env`. Jika Anda ingin mengubah port, kredensial admin, atau mengaktifkan Redis, lakukan konfigurasi berikut:

### Konfigurasi Server (`server/.env`)
Salin file contoh di folder `server/`:
```bash
cp server/.env.example server/.env
```

Buka `server/.env` dan sesuaikan nilainya:
```bash
# Port backend server (default: 5100)
PORT=5100

# Kredensial Login Admin Dashboard
ADMIN_EMAIL=admin@domainanda.com
ADMIN_PASSWORD=password-rahasia-anda

# Secret Key untuk Enkripsi JWT Access Token End-User
# (Wajib diganti saat deploy ke server produksi)
JWT_SECRET=rahasia-string-acak-dan-panjang

# Secret Key untuk Enkripsi Client Secret OAuth2 & Password SMTP (M10/M23)
# (Opsional — fallback ke JWT_SECRET jika kosong)
# OAUTH_SECRET=rahasia-lain-acak-dan-panjang

# SMTP Mail Service — Verifikasi Email & Reset Password (M23)
# Tanpa konfigurasi ini, email masuk ke DEV OUTBOX (dashboard Settings → Outbox)
# — link verifikasi/reset tetap berfungsi untuk development.
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_USER=you@gmail.com
# SMTP_PASS=app-password-dari-google
# SMTP_SECURE=false
# MAIL_FROM=BaseForge <no-reply@baseforge.local>

# Redis URL untuk Rate Limiter (Opsional)
# Kosongkan jika ingin menggunakan in-memory rate limiter bawaan
# REDIS_URL=redis://127.0.0.1:6379

# Folder Penyimpanan Database & Files (default: ../data)
# DATA_DIR=../data
```

### Konfigurasi Dashboard (`dashboard/.env.local`)
Jika backend server Anda berjalan di port atau domain yang berbeda:
```bash
cp dashboard/.env.example dashboard/.env.local
```
Isi dengan URL backend API Anda:
```bash
NEXT_PUBLIC_BASEFORGE_API=http://localhost:5100
```

---

## 🧩 5. Fitur Opsional Pasca-Install

### A. OAuth2 Social Login (Google / GitHub)
1. Buat OAuth App di [Google Cloud Console](https://console.cloud.google.com/apis/credentials) atau [GitHub Developer Settings](https://github.com/settings/developers).
2. Daftarkan Redirect URI yang ditampilkan di dashboard: **Project → Auth (sidebar) → copy Redirect URI**.
3. Isi Client ID & Client Secret di halaman yang sama, lalu klik **Test Flow** untuk mencoba.
4. Aplikasi Anda tinggal mengarahkan user ke `/api/p/{projectId}/auth/oauth/google/authorize` — detail alur ada di [API Reference § OAuth2](./api-reference.md).

### B. Email Service (Verifikasi & Reset Password)
1. Buka **Settings (ikon gear di navbar dashboard)**.
2. Isi SMTP Host/Port/User/Password — atau set env `SMTP_HOST` dst.
3. Klik **Send Test** untuk memverifikasi koneksi.
4. Tanpa SMTP: semua email masuk **Dev Outbox** (tampilan di halaman yang sama) — link verifikasi & reset tetap bisa diklik untuk development.

### C. Usage Statistics (Request & Bandwidth)
Otomatis aktif — buka **Overview project** untuk melihat kartu statistik + grafik 14 hari. Endpoint API: `GET /api/admin/projects/{id}/stats`.

---

## 📁 6. Struktur Folder

```text
WekanzBaseForge/
├── package.json             ← Root package.json (NPM Workspaces)
├── server/                  ← Backend core server (Node.js + TypeScript)
│   ├── src/
│   │   ├── api/             ← HTTP route handlers (admin, public, auth, storage, realtime)
│   │   ├── auth/            ← Password hashing (scrypt), JWT (jose), rate limiter (ioredis)
│   │   ├── core/            ← Database engine, query parser, schema, storage, V8 functions
│   │   └── platform/        ← Registry multi-project & admin auth
│   ├── tests/               ← 363 unit & integration automated tests
│   └── package.json
├── dashboard/               ← Admin UI Console (Next.js 15, React 19, Tailwind)
│   ├── app/                 ← App router pages (login, projects, collections, auth, functions)
│   └── package.json
├── data/                    ← SEMUA DATA TERSIMPAN DI SINI (di-ignore oleh git)
│   ├── platform.db          ← Database registry platform & akun admin
│   └── projects/            ← Folder per-project (terisolasi total)
│       └── <project_id>/
│           ├── data.db      ← SQLite database project
│           └── storage/     ← File-file upload milik project
└── docs/                    ← Dokumentasi resmi & jurnal arsitektur
```

---

## 🧪 7. Menjalankan Automated Tests

BaseForge memiliki test suite komprehensif berisi **363 pengujian otomatis** untuk memverifikasi keamanan SQL injection, isolasi data, transaksi WAL, pembatasan rate limit, sandbox eksekusi fungsi, OAuth2 flow, email tokens, dan usage metrics:

```bash
# Menjalankan seluruh test dari root
npm test
```
Semua test dieksekusi menggunakan test runner bawaan Node (`node:test`) tanpa dependensi framework testing luar.
