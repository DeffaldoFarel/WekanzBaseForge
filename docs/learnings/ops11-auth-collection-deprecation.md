# Ops-11 (Tahap 3): deprecate auth-collection surface

**Tanggal:** 2026-09-19
**Commit:** (diisi saat commit)
**Konteks:** Tahap 3 dari 4 konsolidasi dua auth surface BaseForge menjadi satu.

## Kenapa "deprecate", bukan langsung hapus

Tahap 2 sudah memindahkan satu-satunya konsumen surface B (ExploreMaps) ke
platform auth. Godaannya adalah langsung menghapus route-nya karena hitungannya
kecil — 1 project, 1 user.

Justru itu yang tidak dilakukan. Jendela deprecation adalah **satu-satunya hal
yang membuat vonis salah bisa dipulihkan**: kalau ternyata ada konsumen yang
belum ketahuan (APK lama yang belum di-update, script, integrasi pihak ketiga),
menghapus route berarti mereka mati tanpa jalur balik. Menandai route berarti
mereka tetap hidup sambil ketahuan.

## Yang diubah

Tiga endpoint di `api/publicRoutes.ts` ditandai, **tanpa mengubah perilakunya**:

| Endpoint lama | Pengganti |
|---|---|
| `POST /collections/:name/auth-with-password` | `POST /auth/login` |
| `POST /collections/:name/auth-refresh` | `POST /auth/refresh` |
| `POST /collections/:name/auth-logout` | `POST /auth/logout` |

Helper `markDeprecated(req, res, replacement)` menambahkan:

- `Deprecation: true` — sinyal standar RFC 8594
- `Link: <pengganti>; rel="successor-version"` — mesin tahu harus ke mana
- `Warning: 299 - "..."` — terbaca manusia di DevTools/log
- satu baris `console.warn` berisi project, collection, dan **User-Agent**

User-Agent itu yang penting: kalau ada pemanggil tersisa, Tahap 4 bisa
mengidentifikasi *siapa* dari log, bukan menebak.

## Keputusan desain

**Header dipasang di awal handler, bukan di akhir.** Konsekuensinya respons
**gagal** (mis. 400 salah password) juga membawa header deprecation. Itu
disengaja: klien yang sedang gagal login justru paling perlu tahu bahwa
endpointnya usang. Kalau dipasang hanya pada jalur sukses, integrator yang
sedang men-debug kegagalan tidak akan pernah melihat peringatannya.

**CRUD record collection auth TIDAK ditandai.** Yang dipensiunkan adalah
mekanisme *autentikasi*-nya, bukan collection-nya. Menandai `/records` akan
memberi sinyal palsu bahwa datanya ikut mati.

**`res.raw.setHeader` dipakai langsung** alih-alih menambah method ke
`ForgeResponse`. Mengubah interface inti menyentuh semua handler; `res.raw`
sudah tersedia dan cukup. Perubahan terkecil yang menyelesaikan masalah.

## Bug yang ditemukan saat menulis test

Test awal memakai auth collection dengan field `nickname` (tanpa `name`) dan
`auth-refresh` gagal 400. Itu bukan kesalahan test — itu **bug nyata yang sudah
ada sejak M40**:

```
SELECT id, email, name, verified, created, updated FROM "<collection>"
                   ^^^^ tidak dijamin ada
```

Collection `type=auth` hanya menjamin `email`, `password_hash`, dan `verified`
(lihat `core/schema.ts`); field lain milik pemilik skema. Auth collection tanpa
field `name` karena itu **tidak bisa refresh sama sekali** — gagal dengan
`no such column: name`.

Direproduksi terisolasi sebelum diperbaiki:

```
fields: email, nickname, verified
punya field 'name'? false
SELECT name -> GAGAL: no such column: name
```

Perbaikannya `SELECT *` lalu membaca `name` secara opsional — pola yang sudah
dipakai `auth-with-password` di file yang sama, jadi ini sekaligus menyamakan
keduanya.

**Dampak produksi: nol.** `explore_users` kebetulan punya kolom `name`, jadi
jalur rollback Kakak tidak pernah terpengaruh. Diverifikasi langsung ke DB VPS
sebelum memutuskan, bukan diasumsikan.

Pelajarannya: menulis test untuk kode yang "cuma ditandai" tetap menemukan bug,
karena test memaksa mencoba bentuk input yang tidak pernah dicoba sebelumnya.

## Test

`server/tests/ops11-auth-collection-deprecation.test.ts` — 9/9 pass:

- ketiga endpoint **tetap 200** dan tetap menerbitkan token (rollback nyata)
- ketiganya membawa `Deprecation`/`Link`/`Warning` yang benar
- logout benar-benar mencabut token (bukan sekadar menandai)
- respons gagal pun tertandai
- surface A (pengganti) **tidak** tertandai
- CRUD record **tidak** tertandai
- regresi: refresh jalan untuk auth collection tanpa field `name`

Suite penuh: 640/640 pass (631 → 640).

## Tahap 4 (belum dikerjakan)

Hapus ketiga route, sederhanakan cabang `isAuth` di `core/schema.ts` dan
`core/records.ts`, flip `explore_users` ke `type=base`. Prasyarat: log server
bersih dari `[deprecated]` selama jendela deprecation.
