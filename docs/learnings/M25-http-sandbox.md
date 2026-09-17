# M25 — `$http` di Sandbox Functions

## Apa yang kupikirkan sebelumnya

Menambahkan HTTP ke sandbox terasa seperti mengebiri keamanan M18a: seluruh
poin isolate V8 adalah "tanpa akses host". Kubayangkan harus membongkar jail
dan mulai membagikan References ke fetch — dan setiap Reference yang bocor
adalah celah RCE.

## Apa yang ternyata benar

Network access bisa jadi **layanan yang di-host**, bukan **kemampuan yang
diberikan**. Isolate tetap buta jaringan — ia hanya bisa memanggil SATU
fungsi host (`__httpSend`) yang menerapkan seluruh kebijakan sebelum fetch
jalan: allowlist → SSRF check → redirect re-check → cap. Kode user tidak
pernah melihat `fetch`; ia melihat `$http` yang bentuknya sudah disaring.

Pola bridge isolated-vm yang benar (setelah 2 probe empiris):
```
guest: __httpSend.apply(null, [jsonOpts, callbackFn],
                        { arguments: [{copy: true}, {reference: true}], async: true })
host : callback.apply(null, [err, json], { arguments: {copy: true}, async: true })
```

## Aha! moment

**1. `copy` menolak function; `reference` menolak string biasa? Tidak —
per-argument transfer array.**
Probe pertama gagal: "could not be cloned" — `{arguments: {copy: true}}`
menyalin SEMUA argumen, dan function tidak cloneable. Solusinya: **array
per-argumen** `[{copy: true}, {reference: true}]` — opts disalin (aman),
callback dikirim sebagai Reference. API transfer ivm ternyata granular.

**2. Reference fungsi guest hanya punya `.apply` — bukan `applyIgnored`.**
Dokumentasi menyiratkan keduanya; kenyataan (v7): hanya `.apply`. Dan
`.apply` async mengembalikan Promise — error di callback guest harus
ditelan manual `.catch(() => {})` agar tidak jadi unhandled rejection.
Kedua fakta ini hanya ketemu karena probe — d.ts-nya tidak menjelaskan.

**3. Timeout isolate TIDAK men-tick saat await.**
ivm `timeout` menjaga CPU sync. Begitu guest `await` host callback, isolate
parkir — `while(true)` tertangkap, tapi `await $http.lambat()` tidak! Maka
timeout jadi dua lapis: ivm timeout (CPU) + **wall-clock race** (Promise.race
dengan timer host). Wall-clock juga otomatis menangani "function menggantung
menunggu HTTP". Dispose isolate di finally mematikan semuanya.

**4. `*` ≠ "semua host". `*` = "semua host PUBIK".**
Desain allowlist: wildcard/`*` tidak pernah mengizinkan IP privat/loopback.
Hanya **entry literal** (mis. `192.168.1.10`, `localhost`) yang mengizinkan
internal — opt-in eksplisit, terlihat di audit. Ini membuat default aman
tanpa membuat internal integration mustahil.

**5. Redirect = SSRF kedua.**
`fetch` default mengikuti redirect otomatis — allowed-host bisa redirect ke
`169.254.169.254` (metadata AWS). Maka `redirect: 'manual'` + loop max 3 hop
+ **validasi ulang allowlist & SSRF di setiap hop**. Request yang "sah" bisa
berubah jadi serangan di hop kedua.

**6. Cap body = berhenti MEMBACA, bukan slice setelah baca.**
Stream dibaca sampai 1MB lalu `reader.cancel()` — 2GB respons tidak pernah
diunduh. Beda nyata untuk bandwidth, bukan cuma memori.

## Keputusan yang dipertahankan

- **Fail-safe default**: tanpa httpAllow → `$http.send` melempar error
  informatif. Jaringan OFF sampai diaktifkan.
- **JSON string sebagai batas transfer**: hasil dikirim sebagai string JSON
  + `json()` helper disuntik di guest — tidak ada object graph Reference
  yang bisa dimainkan user.
- **`json()` tidak lolos serialisasi** — method yang dilampirkan di guest
  hilang saat hasil di-stringify untuk keluar. Itu fitur, bukan bug:
  response dihost adalah data murni.

## Pertanyaan yang masih tersisa

- DNS rebinding (TOCTOU antara resolve-check dan fetch connect) — v1
  menerima jendela ini, mitigasi penuh butuh custom agent dengan IP pinning.
- Per-second rate limit per function untuk $http (anti abuse outbound).
- `$http.request` streaming untuk webhook besar? Tidak — isolates bukan
  tempat streaming.
