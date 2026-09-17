# 🚀 Production Deployment Guide

Panduan ini menjelaskan cara melakukan *deployment* BaseForge ke server VPS (Linux / Ubuntu) menggunakan **Systemd** (service manager resmi Linux), **Caddy** (reverse proxy otomatis HTTPS), dan opsi **Redis** untuk rate limiting terdistribusi.

---

## 🛠️ 1. Persiapan Server VPS

### A. Install Node.js v22.x
BaseForge membutuhkan Node.js `>= 22.5.0` (karena modul `node:sqlite`). Di Ubuntu/Debian, gunakan repository resmi NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v # pastikan versi v22.5.0 atau lebih tinggi
```

### B. Install Caddy Web Server
Caddy adalah reverse proxy modern yang secara otomatis menangani sertifikat SSL (HTTPS) dari Let's Encrypt:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

### C. Install Redis (Opsional — untuk Rate Limiter)
Jika Anda ingin rate limiter login anti-brute force tetap tersimpan saat server restart dan tersinkronisasi antar multi-instance:

```bash
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
```

---

## 📦 2. Clone Proyek & Build

Letakkan proyek di home directory pengguna server (misalnya `/home/ubuntu`):

```bash
cd /home/ubuntu
git clone https://github.com/DeffaldoFarel/WekanzBaseForge.git
cd WekanzBaseForge

# Install semua dependensi
npm install

# Build backend server (kompilasi TypeScript ke dist/)
npm run build:server

# Build dashboard Next.js untuk produksi
# (Set URL API publik sebelum melakukan build)
NEXT_PUBLIC_BASEFORGE_API=https://api-forge.domainanda.com npm run build:dashboard
```

---

## ⚙️ 3. Konfigurasi Environment Produksi

Buat file environment untuk server:
```bash
cp server/.env.example server/.env
nano server/.env
```

Isi dengan nilai produksi yang aman:
```ini
PORT=5100
ADMIN_EMAIL=admin@domainanda.com
ADMIN_PASSWORD=GantiDenganPasswordYangSangatKuat!
JWT_SECRET=BuatStringAcakPanjangMinimal32KarakterUntukKeamananJWT
REDIS_URL=redis://127.0.0.1:6379
DATA_DIR=../data

# M10/M23: enkripsi OAuth client secret & SMTP password (fallback: JWT_SECRET)
OAUTH_SECRET=StringAcakLainMinimal32Karakter

# M23: SMTP untuk verifikasi email & reset password (produksi WAJIB)
# Tanpa ini, email hanya masuk dev outbox — end-user tidak menerima email sungguhan
SMTP_HOST=smtp.domainanda.com
SMTP_PORT=587
SMTP_USER=no-reply@domainanda.com
SMTP_PASS=password-smtp
SMTP_SECURE=false
MAIL_FROM=BaseForge <no-reply@domainanda.com>
```

---

## 🤖 4. Menjalankan Service dengan Systemd (Linux Daemon)

Systemd memastikan service berjalan di background, otomatis *restart* jika crash, dan otomatis hidup kembali saat server VPS di-reboot.

Buat direktori user systemd (jika belum ada):
```bash
mkdir -p ~/.config/systemd/user
```

### A. Service Backend Server (`~/.config/systemd/user/baseforge-server.service`)
```ini
[Unit]
Description=WekanzBaseForge Core API Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/WekanzBaseForge/server
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

### B. Service Admin Dashboard (`~/.config/systemd/user/baseforge-dashboard.service`)
```ini
[Unit]
Description=WekanzBaseForge Admin Dashboard (Next.js)
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/WekanzBaseForge/dashboard
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

### C. Aktifkan & Jalankan Service
```bash
# Muat ulang konfigurasi systemd
systemctl --user daemon-reload

# Aktifkan service agar otomatis hidup saat booting
systemctl --user enable --now baseforge-server
systemctl --user enable --now baseforge-dashboard

# Pastikan proses user tetap berjalan saat logout dari SSH (Linger)
sudo loginctl enable-linger ubuntu
```

### D. Perintah Pemantauan Service
* Cek status: `systemctl --user status baseforge-server`
* Pantau log real-time: `journalctl --user -u baseforge-server -f`
* Restart server: `systemctl --user restart baseforge-server`

---

## 🔒 5. Konfigurasi Domain & HTTPS dengan Caddy

Buka file konfigurasi Caddy:
```bash
sudo nano /etc/caddy/Caddyfile
```

### Pilihan Rekomendasi: Dua Subdomain
Pisahkan domain Admin Dashboard dengan domain API publik:

```caddy
# 1. Admin Dashboard Console
forge.domainanda.com {
    reverse_proxy localhost:7701
}

# 2. Backend REST API, SSE Realtime, & File Storage
api-forge.domainanda.com {
    reverse_proxy localhost:5100
}
```

Terapkan konfigurasi Caddy:
```bash
sudo systemctl reload caddy
```

*Caddy akan secara otomatis mengambil sertifikat SSL dan mengaktifkan HTTPS gratis untuk kedua domain tersebut!*

---

## 💾 6. Strategi Backup & Pemulihan Data

Semua data tersimpan di satu folder induk: **`data/`**.

### Backup Lengkap (Full Snapshot)
Cukup kompres folder `data/`:
```bash
tar -czf /home/ubuntu/backups/baseforge_$(date +%Y%m%d).tar.gz /home/ubuntu/WekanzBaseForge/data
```

### Pemulihan di Server Baru (Migration)
1. Pasang Node.js 22 dan clone BaseForge di server baru.
2. Salin arsip backup `data/` ke direktori proyek di server baru.
3. Ekstrak folder `data/`.
4. Jalankan service — semua project, akun, file, dan relasi langsung aktif 100%!
