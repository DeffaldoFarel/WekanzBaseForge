# 🔒 API Rules (Row-Level Security)

API Rules adalah sistem otorisasi dan kontrol akses tingkat baris (*Row-Level Security / RLS*) di BaseForge. Setiap koleksi data memiliki 5 aturan keamanan yang dievaluasi secara atomik di lapisan query SQL.

---

## 🛡️ 5 Macam Aturan

Setiap koleksi memiliki 5 aturan independen:

| Aturan | Operasi yang Dikontrol | Deskripsi |
|---|---|---|
| **`listRule`** | `GET .../records` | Menentukan baris mana saja yang boleh muncul dalam daftar. |
| **`viewRule`** | `GET .../records/:id` | Menentukan apakah pengguna boleh melihat detail baris tertentu. |
| **`createRule`** | `POST .../records` | Menentukan apakah pengguna diizinkan menambah baris baru. |
| **`updateRule`** | `PATCH .../records/:id` | Menentukan apakah baris tersebut boleh diubah oleh pengguna. |
| **`deleteRule`** | `DELETE .../records/:id` | Menentukan apakah baris tersebut boleh dihapus oleh pengguna. |

---

## 🚦 Tiga Status Nilai Rule

Setiap rule bisa diisi salah satu dari 3 kondisi:

### 1. `null` (Terkunci / Khusus Admin) 🔒
* **Arti:** Hanya pengelola platform (Admin Console / Token Admin) yang bisa mengakses.
* **Perilaku End-User:** End-user biasa atau request publik akan ditolak dengan `403 Forbidden` (atau hasil kosong `0 items` pada `listRule`).
* *Ini adalah status bawaan (default) saat koleksi baru dibuat demi keamanan.*

### 2. `""` (String Kosong / Publik) 🌐
* **Arti:** Siapa saja di internet dapat mengakses operasi ini, baik pengguna yang sudah login maupun tamu anonim.
* *Contoh penggunaan:* `listRule` dan `viewRule` untuk artikel blog publik atau katalog produk toko online.

### 3. Ekspresi Kustom (Filter Kondisional) 🧮
* **Arti:** Operasi hanya diizinkan jika kondisi ekspresi bernilai `TRUE` untuk baris data tersebut.

---

## 🧩 Variabel Konteks Dinamis (`@request.*`)

Di dalam ekspresi rule, Anda dapat menggunakan variabel khusus yang merujuk pada identitas pemanggil dan data yang dikirimkan:

* **`@request.auth.id`** : ID unik pengguna yang sedang login (diekstrak dari payload JWT `sub`). Bernilai `""` jika pemanggil anonim.
* **`@request.auth.email`** : Alamat email pengguna yang sedang login.
* **`@request.data.<field>`** : Nilai field yang sedang dikirimkan dalam body request (biasanya dipakai pada `createRule` dan `updateRule`).

---

## 💡 Contoh Skenario Aturan Populer

### 1. Catatan Pribadi (Hanya Pemilik yang Boleh Akses)
Koleksi `notes` memiliki field relasi `user` yang merujuk ke pengguna:

* **`listRule`**: `user = @request.auth.id` *(hanya catatan miliknya yang muncul)*
* **`viewRule`**: `user = @request.auth.id` *(tidak bisa intip catatan orang lain via ID)*
* **`createRule`**: `@request.auth.id != "" && user = @request.auth.id` *(wajib login & mencatat dirinya sebagai pemilik)*
* **`updateRule`**: `user = @request.auth.id` *(hanya pemilik yang boleh edit)*
* **`deleteRule`**: `user = @request.auth.id` *(hanya pemilik yang boleh hapus)*

### 2. Forum Diskusi / Komentar
* **`listRule`**: `""` *(semua orang boleh membaca komentar)*
* **`viewRule`**: `""`
* **`createRule`**: `@request.auth.id != ""` *(wajib login untuk bisa komentar)*
* **`updateRule`**: `author = @request.auth.id` *(hanya penulis yang boleh edit)*
* **`deleteRule`**: `author = @request.auth.id`

### 3. Status Konten (Draft vs Published)
Koleksi `articles` memiliki field `status` ("draft" atau "published"):

* **`listRule`**: `status = "published" || author = @request.auth.id`
  *(Pengunjung umum hanya melihat artikel published, tetapi penulis tetap bisa melihat draft miliknya sendiri)*

---

## 🖥️ Cara Mengatur Rules

### Melalui Admin Dashboard Web
1. Buka dashboard di `http://localhost:7701`
2. Pilih project Anda, lalu klik menu **Database**
3. Pilih koleksi yang ingin diatur, klik tab **Settings / Rules**
4. Masukkan ekspresi aturan pada masing-masing field (atau ketik `null` untuk mengunci ke admin).

### Melalui Admin REST API
Kirim `PATCH` request dengan token admin:
```bash
curl -X PATCH "http://localhost:5100/api/admin/projects/:pid/collections/notes/rules" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "listRule": "user = @request.auth.id",
    "viewRule": "user = @request.auth.id",
    "createRule": "@request.auth.id != \"\" && user = @request.auth.id",
    "updateRule": "user = @request.auth.id",
    "deleteRule": "user = @request.auth.id"
  }'
```
