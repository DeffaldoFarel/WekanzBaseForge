# 🚀 Production Deployment Guide

Panduan deploy BaseForge ke VPS Linux (Ubuntu) menggunakan **systemd user service**, **Caddy** (HTTPS otomatis), dan opsi **Redis** untuk rate limiting terdistribusi.

> 📌 **Dokumen ini diverifikasi dari deployment nyata** ke VPS produksi
> (Ubuntu + Node 22, 18 Sep 2026): server + dashboard + Caddy
> single-subdomain + Let's Encrypt aktif dalam < 30 menit. Semua langkah
> di bawah adalah langkah yang **terbukti berhasil** — bukan teori.
> Perbedaan penting dari praktik umum dijelaskan di ⚠️ callout.

---

## 🛠️ 1. Persiapan Server

### A. Node.js v22.5+
BaseForge membutuhkan `node:sqlite` (bawaan Node ≥ 22.5):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # harus v22.5.0 atau lebih baru
```

> ⚠️ **Terverifikasi:** `isolated-vm@7` menampilkan warning `EBADENGINE`
> (engines minta Node ≥24) saat install di Node 22 — **warning-nya aman
> diabaikan**: native module ter-build dan function sandbox terbukti jalan
> normal di Node 22.23 (diuji live: execute 16ms).

### B. Caddy (reverse proxy + SSL otomatis)
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

### C. Redis (opsional — rate limiter persisten)
Tanpa Redis, rate limiter otomatis fallback ke in-memory (tetap aman, hanya
reset saat restart). Pasang jika butuh persistensi/multi-instance:

```bash
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
```

---

## 📦 2. Clone & Install

```bash
cd /home/ubuntu
git clone https://github.com/DeffaldoFarel/WekanzBaseForge.git
cd WekanzBaseForge
```

### Install workspace server
```bash
npm install --workspace=server --no-audit --no-fund
```

> ⚠️ **LANGKAH WAJIB DI LINUX — perbaiki native binary `sharp`:**
> Lockfile repo dibuat di Windows, sehingga npm melewatkan optional
> dependency platform Linux (`@img/sharp-linux-x64`) dan server crash saat
> start dengan `Could not load the "sharp" module using the linux-x64
> runtime`. Perbaiki eksplisit (tidak mengubah package.json):
>
> ```bash
> cd server
> npm install --no-save --no-audit --no-fund @img/sharp-linux-x64
> cd ..
> ```
>
> Jalankan ulang perintah ini setiap kali setelah `npm install` bersih.
> Cek berhasil: `node -e "require('sharp'); console.log('sharp OK')"`
> dari dalam folder `server/`.

### Build server & dashboard
```bash
# Backend (tsc → dist/)
npm run build:server

# Dashboard — SET URL API PUBLIK SEBELUM BUILD (dibundel ke JS client)
cd dashboard
echo "NEXT_PUBLIC_BASEFORGE_API=https://baseforge.domainanda.com" > .env.production
cd ..
npm run build:dashboard
```

---

## ⚙️ 3. Konfigurasi Environment (via systemd, BUKAN dotenv)

> ⚠️ **PENTING — server TIDAK membaca `server/.env`.** Tidak ada dotenv di
> kode. Cara yang benar dan terbukti: **`EnvironmentFile=` di unit
> systemd** (lihat §4). Cukup buat file env (lokasi bebas,
> direkomendasikan `server/.env`) untuk dirujuk systemd — jangan berharap
> server membacanya sendiri.

```bash
cat > server/.env <<'EOF'
PORT=5100
JWT_SECRET=GantiStringAcakPanjangMinimal32Karakter
DATA_DIR=../data
REDIS_URL=redis://127.0.0.1:6379
OAUTH_SECRET=StringAcakLainMinimal32Karakter
# SMTP produksi (tanpa ini email masuk dev outbox saja):
# SMTP_HOST=smtp.domainanda.com
# SMTP_PORT=587
# SMTP_USER=no-reply@domainanda.com
# SMTP_PASS=password-smtp
# SMTP_SECURE=false
# MAIL_FROM=BaseForge <no-reply@domainanda.com>
EOF
chmod 600 server/.env
```

### 👤 Admin pertama: BUKAN lewat env!
Sejak **M39u (First-Time Admin Setup)**, kredensial master admin dibuat
lewat UI onboarding dan disimpan **ter-hash scrypt** di
`data/platform.db` (tabel `_platform_admins`) — bukan plaintext di `.env`:

1. Deploy selesai → buka `https://<domain>/signup`
2. Isi email + password → **Create Master Admin**
3. Endpoint setup otomatis terkunci permanen (`403 SETUP_COMPLETED`)

> `ADMIN_EMAIL`/`ADMIN_PASSWORD` di env kini hanya **fallback legacy** untuk
> development/test — jangan andalkan di produksi.

---

## 🤖 4. Systemd User Services

```bash
mkdir -p ~/.config/systemd/user
```

### A. Backend API (`~/.config/systemd/user/baseforge-server.service`)
```ini
[Unit]
Description=WekanzBaseForge Server (BaaS backend, port 5100)
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/WekanzBaseForge/server
ExecStart=/usr/bin/node dist/index.js
Environment=NODE_ENV=production
EnvironmentFile=/home/ubuntu/WekanzBaseForge/server/.env
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

### B. Dashboard (`~/.config/systemd/user/baseforge-dashboard.service`)
```ini
[Unit]
Description=WekanzBaseForge Dashboard (Next.js web UI, port 7701)
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/WekanzBaseForge/dashboard
ExecStart=/usr/bin/npx next start -p 7701
Environment=NODE_ENV=production
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

### C. Aktifkan + uji auto-restart
```bash
systemctl --user daemon-reload
systemctl --user enable --now baseforge-server baseforge-dashboard
sudo loginctl enable-linger $USER   # service tetap hidup setelah SSH logout

# Buktikan Restart=always bekerja (kill → bangkit lagi dalam ~2 detik):
kill -9 $(systemctl --user show -p MainPID --value baseforge-server)
sleep 3
curl -s http://localhost:5100/api/health   # → {"status":"ok",...}
```

Perintah harian:
```bash
systemctl --user status baseforge-server
journalctl --user -u baseforge-server -f      # log real-time
systemctl --user restart baseforge-server
```

---

## 🔒 5. Caddy: SATU subdomain untuk Dashboard + API

> ⚠️ **Pola yang terbukti (dan paling nyaman):** satu domain untuk semuanya.
> Request `/api/*` diteruskan ke backend :5100, sisanya ke dashboard :7701.
> Tidak perlu dua DNS record dan tidak perlu konfigurasi CORS silang.

Siapkan DNS: A record `baseforge` → IP VPS, lalu:

```caddy
# /etc/caddy/Caddyfile
baseforge.domainanda.com {
	@api path /api /api/*
	handle @api {
		reverse_proxy localhost:5100
	}
	handle {
		reverse_proxy localhost:7701
	}
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile   # wajib: "Valid configuration"
sudo systemctl reload caddy
```

Caddy otomatis menerbitkan sertifikat Let's Encrypt (HTTP-01) begitu DNS
mengarah — log `certificate obtained successfully` muncul dalam hitungan
detik. Verifikasi:

```bash
curl -s https://baseforge.domainanda.com/api/health      # JSON backend
curl -sI https://baseforge.domainanda.com/login           # 200 dashboard
```

> 💡 Port **5100 dan 7701 tidak perlu dibuka** di firewall/security group
> publik — semua traffic internet masuk lewat Caddy :443. Backend cukup
> listen di localhost.

---

## 💾 6. Backup & Migrasi

Semua state (platform.db + per-project SQLite + file storage) hidup di
satu folder: **`data/`**.

### Backup
```bash
mkdir -p ~/backups
# Stop server dulu agar hasil snapshot deterministik
systemctl --user stop baseforge-server
tar -czf ~/backups/baseforge_$(date +%Y%m%d_%H%M).tar.gz -C /home/ubuntu/WekanzBaseForge data
systemctl --user start baseforge-server
```

> BaseForge juga punya **scheduled backup bawaan per-project** (M32,
> `VACUUM INTO` + retensi, diatur dari dashboard Settings per project).

### Pindah server
1. Install Node 22 + clone repo di server baru (langkah §1–§2 termasuk fix sharp).
2. Salin arsip `data/` → ekstrak di root proyek.
3. Setup systemd + Caddy (§3–§5) → semua project, admin, user, dan file langsung aktif 100%.

---

## ✅ 7. Smoke Test Pasca-Deploy

```bash
# 1. Health
curl -s http://localhost:5100/api/health

# 2. Setup-state (true pada instalasi baru, false setelah admin dibuat)
curl -s https://baseforge.domainanda.com/api/admin/setup-state

# 3. Buat admin pertama lewat UI: https://<domain>/signup

# 4. Login admin (pakai akun dari _platform_admins yang dibuat di langkah 3)
curl -s -X POST https://baseforge.domainanda.com/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@domainanda.com","password":"<password-yang-tadi>"}'
```

---

## 🧯 Troubleshooting (kasus nyata dari deployment terverifikasi)

| Gejala | Penyebab | Perbaikan |
|---|---|---|
| `Could not load the "sharp" module using the linux-x64 runtime` | Binary platform Linux ke-skip (lockfile Windows) | `npm install --no-save @img/sharp-linux-x64` di `server/` (ulangi setelah tiap fresh install) |
| Login admin ditolak padahal `.env` sudah benar | Server tidak membaca `.env` (no dotenv) | Pakai `EnvironmentFile=` di systemd; atau ingat: sejak M39u admin utama dibuat via `/signup` |
| `403 SETUP_COMPLETED` saat akses `/signup` | Admin sudah pernah dibuat | Normal — setup memang terkunci permanen; gunakan `/login` |
| Caddy gagal terbit sertifikat | DNS record belum resolve di authoritative NS | Cek `dig +short <domain> @<ns-authoritative>`; baru `reload caddy` setelah resolve (hindari backoff rate-limit ACME) |
| Dashboard `/login` 200 tapi semua API 401 | Server di-restart → sesi admin in-memory hilang | Login ulang di dashboard (sesi disimpan di memori server) |
| `403 Forbidden` saat create record via API publik | Collection baru default locked | Buka rules dari dashboard → collection → API Rules (atau `PUT` rules via Admin API) |
