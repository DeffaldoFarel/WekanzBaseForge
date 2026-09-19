# Ops-12 (Tahap 4): hapus auth-collection surface

**Tanggal:** 2026-09-19
**Commit:** (diisi saat commit)
**Konteks:** Tahap terakhir konsolidasi dua auth surface BaseForge menjadi satu.

## Yang dihapus

`api/publicRoutes.ts` menyusut 804 → 572 baris:

- `POST /api/p/:pid/collections/:name/auth-with-password`
- `POST /api/p/:pid/collections/:name/auth-refresh`
- `POST /api/p/:pid/collections/:name/auth-logout`
- helper yatim `refreshCollectionUserId()` dan `revokeRefreshTokenByHash()`
- import mati: `verifyPassword`, `issueTokens`, `initAuthTokensTable`,
  `hashToken`, `ForgeRequest`, `ForgeResponse`

Autentikasi end-user kini **hanya** lewat platform auth `/api/p/:pid/auth/*`.

## Test yang pecah = peta cakupan, bukan gangguan

Setelah penghapusan, 12 test gagal. Runbook bilang "test yang pecah berarti ada
pemanggil hidup yang terlewat" — jadi setiap satu diperiksa, bukan dimatikan
borongan. Semuanya ternyata memang menguji endpoint yang baru dihapus:

- `auth-collection.test.ts` — 5 test (94 baris) dihapus; 2 test sisanya menguji
  skema dan CRUD collection auth, yang justru harus tetap hidup.
- `ops11-auth-collection-deprecation.test.ts` — seluruh file digantikan
  `ops12-auth-collection-removal.test.ts` (kontraknya terbalik: dulu "masih
  hidup + tertandai", sekarang "benar-benar 404").
- `m26-apikeys.test.ts` — niat ujinya masih valid (API key bukan identitas
  end-user), jadi target dipindah ke `GET /auth/me`, bukan dibuang. Ternyata
  file itu tidak me-mount `createProjectAuthRouter`; ditambahkan.

## Keputusan: `type='auth'` TIDAK di-flip ke `base`

Rencana Tahap 4 semula termasuk mengubah `explore_users` menjadi `type='base'`
karena jalur login lewat collection sudah tidak ada. **Itu dibatalkan.**

Penyaring hash password di `core/records.ts` berbunyi:

```ts
if (meta.type === 'auth') {
  delete result.password_hash;
}
```

Kolom `password_hash` tetap ada di tabel apa pun tipenya — yang hilang saat
di-flip adalah **penyaringnya**. Direproduksi terisolasi:

```
type=auth  -> password_hash: undefined
type=base  -> password_hash: BOCOR: scrypt:16384:8:1:46ee059...
```

Jadi flip tersebut = membocorkan hash password seluruh pengguna lewat API
record biasa. Dampaknya tidak terjadi di produksi hari ini hanya karena
`explore_users` punya rules `null` (admin-only) — perlindungan yang kebetulan,
bukan yang disengaja. Sekali rules-nya dilonggarkan, hash langsung terekspos.

Keputusan ini dikunci `Ops-12: collection type=auth TIDAK di-flip ke base`
supaya tidak ada yang "merapikan" ini di kemudian hari tanpa tahu alasannya.

Konsekuensi yang diterima: `_collections` masih menyimpan baris bertipe `auth`
meski tidak ada lagi endpoint login untuknya. Itu sisa yang disengaja, dan
lebih murah daripada membocorkan kredensial. Membersihkannya dengan benar
berarti menghapus kolom `password_hash` lebih dulu — pekerjaan terpisah.

## Test

`server/tests/ops12-auth-collection-removal.test.ts` — 9/9 pass:

- ketiga endpoint **404** (hilang, bukan sekadar menolak)
- collection `type=auth` tetap bisa dibuat, CRUD record utuh
- `password_hash` tidak pernah ikut terkirim
- flip ke `base` dilarang (mengunci keputusan di atas)
- platform auth utuh: register → login → refresh (Ops-10) → PATCH /me (Ops-9) → logout
- token yang sudah terbit tetap sah (mesin token kedua surface memang sama)

Suite penuh: **635/635 pass** (640 → 635). Turun 5 karena Tahap 4 membuang lebih
banyak test lama daripada yang ditambahkan: −9 (file deprecation Ops-11 diganti),
−5 (test endpoint di `auth-collection.test.ts`), +9 (Ops-12) = −5.

## Status konsolidasi

Selesai. Satu surface auth: `_auth_users` via `/api/p/:pid/auth/*`.

| Tahap | Isi | Commit |
|---|---|---|
| 1 | paritas `PATCH /auth/me` | `c8be4c7` |
| 2 | paritas `/auth/refresh` + migrasi ExploreMaps | `6fa92f6`, `32d8a92` |
| 3 | deprecate surface B | `cf80812` |
| 4 | hapus surface B | (commit ini) |
