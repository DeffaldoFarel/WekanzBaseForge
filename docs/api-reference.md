# 📡 REST API Reference

Dokumentasi ini berisi panduan lengkap endpoint HTTP BaseForge untuk digunakan oleh aplikasi klien (Frontend Web, Mobile Android/iOS, dsb).

---

## 🌐 Struktur URL

Setiap project di BaseForge memiliki ID unik (`:pid`). Semua endpoint untuk aplikasi klien Anda berakar pada prefiks `/api/p/:pid`:

```text
http://localhost:5100/api/p/<PROJECT_ID>/...
```

*Contoh Project ID:* `q9tylwaruigffwr`

---

## 🔐 1. Authentication (End-User Auth)

BaseForge menyediakan sistem autentikasi lengkap berbasis **JWT (jose) + Persisted Refresh Tokens** dengan hashing kata sandi `scrypt`.

### A. Register User
Mendaftarkan akun baru untuk aplikasi Anda (otomatis login dan menghasilkan token):

* **Method:** `POST`
* **URL:** `/api/p/:pid/auth/register`
* **Headers:** `Content-Type: application/json`
* **Body:**
  ```json
  {
    "email": "budi@example.com",
    "password": "PasswordKuat123!",
    "name": "Budi Santoso"
  }
  ```
* **Response (201 Created):**
  ```json
  {
    "user": {
      "id": "7nd6z9x3wkbys22",
      "email": "budi@example.com",
      "name": "Budi Santoso",
      "verified": false,
      "created": "2026-09-12T16:56:24.312Z"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "7a8b9c...",
    "expiresIn": 900
  }
  ```

### B. Login User
Masuk dengan email dan kata sandi:

* **Method:** `POST`
* **URL:** `/api/p/:pid/auth/login`
* **Body:**
  ```json
  {
    "email": "budi@example.com",
    "password": "PasswordKuat123!"
  }
  ```
* **Response (200 OK):** Mengembalikan payload user dan token yang sama seperti register.
* *Keamanan:* Dilindungi rate limiter anti-brute force (maksimum 10 percobaan per menit).

### C. Refresh Token
Mendapatkan access token baru tanpa mengharuskan pengguna login ulang:

* **Method:** `POST`
* **URL:** `/api/p/:pid/auth/refresh`
* **Body:**
  ```json
  {
    "refreshToken": "7a8b9c..."
  }
  ```
* **Response (200 OK):**
  ```json
  {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "8b9c0d...",
    "expiresIn": 900
  }
  ```

### D. Get Current User Profile (`/me`)
Mendapatkan data pengguna yang sedang login dari bearer token:

* **Method:** `GET`
* **URL:** `/api/p/:pid/auth/me`
* **Headers:** `Authorization: Bearer <accessToken>`
* **Response (200 OK):**
  ```json
  {
    "user": {
      "id": "7nd6z9x3wkbys22",
      "email": "budi@example.com",
      "name": "Budi Santoso",
      "verified": false,
      "created": "2026-09-12T16:56:24.312Z"
    }
  }
  ```

### E. Logout (Revoke Token)
Mematikan refresh token agar tidak bisa digunakan kembali:

* **Method:** `POST`
* **URL:** `/api/p/:pid/auth/logout`
* **Headers:** `Authorization: Bearer <accessToken>`
* **Body:**
  ```json
  {
    "refreshToken": "7a8b9c..."
  }
  ```

---

## 📋 2. Records CRUD (Database Collections)

Operasi CRUD generik untuk membaca dan memanipulasi data di setiap koleksi tabel. Setiap request dievaluasi terhadap **API Rules (RLS)** yang ditetapkan untuk koleksi tersebut.

### A. List Records
Mengambil daftar data dengan dukungan pagination, sorting, filtering, searching, dan expand relasi:

* **Method:** `GET`
* **URL:** `/api/p/:pid/collections/:collection/records`
* **Headers (Opsional):** `Authorization: Bearer <accessToken>`
* **Query Parameters:**
  * `page` *(number)*: Nomor halaman (default: `1`).
  * `perPage` *(number)*: Jumlah item per halaman (default: `20`, max: `100`).
  * `sort` *(string)*: Pengurutan field. Gunakan tanda `-` untuk descending. Contoh: `-created` atau `streak,-created`.
  * `filter` *(string)*: Ekspresi filter data (lihat bagian Sintaks Filter di bawah).
  * `search` *(string)*: Pencarian teks FTS5. Contoh: `?search=kopi gayo`.
  * `expand` *(string)*: Relasi yang ingin di-expand (JOIN otomatis). Contoh: `user` atau `user,author.profile`.

* **Response (200 OK):**
  ```json
  {
    "page": 1,
    "perPage": 20,
    "totalItems": 45,
    "totalPages": 3,
    "items": [
      {
        "id": "p4obybxwkje4bf7",
        "created": "2026-09-12T17:09:02.306Z",
        "updated": "2026-09-12T17:09:02.306Z",
        "title": "Belajar BaseForge",
        "user": "7nd6z9x3wkbys22",
        "expand": {
          "user": {
            "id": "7nd6z9x3wkbys22",
            "name": "Budi Santoso",
            "email": "budi@example.com"
          }
        }
      }
    ]
  }
  ```

### B. Get Single Record
Mengambil satu baris data berdasarkan ID:

* **Method:** `GET`
* **URL:** `/api/p/:pid/collections/:collection/records/:id`
* **Query Parameters:** `expand` (opsional).
* **Response (200 OK):**
  ```json
  {
    "record": {
      "id": "p4obybxwkje4bf7",
      "title": "Belajar BaseForge",
      ...
    }
  }
  ```

### C. Create Record
Menambahkan data baru. Mendukung format **JSON** maupun **Multipart Form-Data** (untuk upload file):

* **Method:** `POST`
* **URL:** `/api/p/:pid/collections/:collection/records`
* **Headers:** `Content-Type: application/json` (atau multipart saat upload file).
* **JSON Body Contoh:**
  ```json
  {
    "title": "Catatan Hari Ini",
    "done": false,
    "tags": ["coding", "backend"]
  }
  ```
* **Response (201 Created):** Mengembalikan objek record yang baru dibuat beserta `id`, `created`, dan `updated`.

### D. Update Record
Mengubah sebagian field record:

* **Method:** `PATCH`
* **URL:** `/api/p/:pid/collections/:collection/records/:id`
* **Body:** JSON atau Multipart berisi field yang ingin diubah.
* **Response (200 OK):** Mengembalikan objek record ter-update.

### E. Delete Record
Menghapus record:

* **Method:** `DELETE`
* **URL:** `/api/p/:pid/collections/:collection/records/:id`
* **Response (204 No Content)**

---

## 🔍 3. Sintaks Filter Query

BaseForge memiliki parser query SQL sendiri (M04) yang mengonversi ekspresi aman menjadi prepared statement SQL parameterized:

### Operator Perbandingan Dasar
* `field = "nilai"` : Sama dengan.
* `field != "nilai"` : Tidak sama dengan.
* `field > 10`, `field >= 10` : Lebih besar / sama dengan.
* `field < 5`, `field <= 5` : Lebih kecil / sama dengan.
* `field ~ "kata"` : Pencarian substring (`LIKE '%kata%'`).
* `field !~ "kata"` : Tidak mengandung kata.

### Operator Any-Match (Array / Multi-Relation)
Untuk field berupa array JSON atau relasi ganda (`maxSelect > 1`):
* `tags ?= "backend"` : Benar jika **setidaknya satu** elemen bernilai "backend".
* `tags ?!= "legacy"` : Benar jika **tidak ada satu pun** elemen bernilai "legacy".
* `tags ?~ "dev"` : Benar jika setidaknya satu elemen mengandung teks "dev".

### Operator Logika & Pengelompokan
* `&&` : AND logika.
* `||` : OR logika.
* `( ... )` : Kurung untuk prioritas evaluasi.

*Contoh Kompleks:*
```text
?filter=(status = "active" || status = "pending") && streak >= 5 && user = @request.auth.id
```

---

## 📁 4. File Storage & Thumbnails

### Upload File
Kirim request `POST` atau `PATCH` ke endpoint record dengan header `multipart/form-data`:
```bash
curl -X POST "http://localhost:5100/api/p/:pid/collections/photos/records" \
  -H "Authorization: Bearer <TOKEN>" \
  -F "title=Liburan" \
  -F "image=@pantai.jpg"
```

### Mengakses File
URL penyajian file publik:
```text
GET /api/files/:pid/:collection/:recordId/:filename
```

### Image Thumbnails Otomatis (`?thumb=WxH`)
Jika file adalah gambar, tambahkan parameter `?thumb` di akhir URL untuk membuat thumbnail instan secara lazy (ditenagai oleh library `sharp` dengan disk-caching otomatis):

* **`?thumb=100x100`** : Crop tengah persegi 100×100 px.
* **`?thumb=300x0`** : Lebar 300 px, tinggi proporsional mengikuti rasio asli.
* **`?thumb=0x200`** : Tinggi 200 px, lebar proporsional.
* **`?thumb=200x200f`** : Fit di dalam kotak 200×200 px tanpa pemotongan (preserve aspect ratio).

---

## 🛑 Format Error Response

Semua endpoint mengembalikan error dalam format JSON seragam:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Field 'email' wajib diisi"
  }
}
```

Kode status HTTP umum:
* `400 Bad Request`: Validasi skema gagal atau parameter query tidak valid.
* `401 Unauthorized`: Token tidak disertakan, kedaluwarsa, atau tanda tangan tidak valid.
* `403 Forbidden`: Ditolak oleh API Rules (akses tidak diizinkan).
* `404 Not Found`: Project, koleksi, atau record tidak ditemukan.
* `409 Conflict`: Nilai field unique sudah digunakan (duplikat).
* `429 Too Many Requests`: Batas laju panggilan terlampaui (rate limit).
