# M30 — S3/R2 Storage Backend

## Apa yang kupikirkan sebelumnya

S3 storage = install `@aws-sdk/client-s3` (50MB dependency) atau `aws4fetch`.
Bayangan: dependency tree besar, build native, konfigurasi rumit.

## Apa yang ternyata benar

AWS Signature V4 adalah **algoritma kriptografi yang terdokumentasi sempurna**
(RFC-level). 30 baris node:crypto: HMAC chain → canonical request → string to
sign → signature. Seluruh S3 REST API hanya butuh 4 HTTP verbs: PUT, GET,
DELETE, LIST. Native `fetch` sudah cukup. **Zero dependency baru.**

## Aha! moment

**1. Path-style vs virtual-host — pilih path-style.**
S3 punya dua addressing: `bucket.s3.amazonaws.com/key` (virtual) dan
`s3.amazonaws.com/bucket/key` (path). MinIO dan R2 memerlukan path-style;
AWS mendukung keduanya. Path-style = satu pola untuk semua provider.

**2. StorageAdapter = interface yang tepat, bukan over-engineering.**
Lokal dan S3 punya semanti IDENTIK untuk use case BaseForge: save(bytes) →
storedName, read(bytes) → Buffer|null, delete(idempotent), list(prefix).
Tidak butuh streaming, multipart upload, presigned URLs — YET. Interface
minimal = implementasi minimal = bug minimal.

**3. Async refactor adalah "biggest bang for the buck" decision.**
Storage sync → async memaksa semua call site berubah. Tapi: (a) semua route
handler SUDAH async, (b) node:test file m14 cuma 28 replacement, (c) tsc
catch SEMUA mismatch. TypeScript compiler = refactoring safety net yang
sesungguhnya. Nol runtime error setelah refactor — semua caught at compile time.

**4. Mock S3 server = 50 baris.**
S3 API surface yang BaseForge pakai (PUT/GET/DELETE/LIST/HEAD) begitu
sempit sehingga mock server untuk testing hanya butuh switch statement + Map.
Tanpa dependency mocking library. Tanpa Docker. Tanpa network.

**5. Thumbnail tetap cache lokal.**
Saat backend = S3: original file di S3, thumbnail di-cache ke disk lokal.
Alasan: thumbnail adalah derivatif yang bisa di-regenerate kapan saja;
menaruhnya di S3 = latency tambahan untuk sesuatu yang murah dibuat ulang.

## Pertanyaan yang masih tersisa

- Presigned URLs (direct upload dari browser → S3, skip server)
- Multipart upload untuk file > 5GB
- S3 versioning / lifecycle policies
- Encryption at-rest untuk credentials di platform.db (saat ini plaintext)
- CDN integration (Cloudflare in front of R2)
