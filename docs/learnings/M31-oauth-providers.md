# M31 — OAuth2 Multi-Provider: 7 Provider

## Apa yang kupikirkan sebelumnya

Menambah 5 OAuth provider = 5x copy-paste kode yang hampir identik, beda
URL + field response. Kubayangkan file oauth.ts membengkak ke 1000+ baris
dengan duplikasi di mana-mana.

## Apa yang ternyata benar

M10 sudah membangun **data-driven pattern yang tepat**: `OAUTH_PROVIDER_DEFS`
adalah Record<ProviderId, ProviderDef> — menambah provider = menambah satu
entry object dengan URL + scope + fetchProfile closure. Tidak perlu mengubah
route, state management, identity linking, atau konfigurasi — semuanya sudah
generik terhadap `provider` string.

**Perbedaan antar provider hanyalah: URL + scope + cara ekstrak profil.**
Sisanya (authorize redirect, token exchange, callback, linking, state) 100%
identik — sudah diabstraksi di M10.

## Aha! moment

**1. "7 provider" bukan "7x kerja" — tapi "1 pattern + 5 entry data".**
Google dan GitHub (M10) menulis POLA. Microsoft, Discord, GitLab, Facebook
hanya mengisi data. Total diff: ~200 baris (bukan 200×5=1000). Ini bukti
arsitektur yang benar membayar dividen berulang.

**2. Microsoft = OpenID Connect (seperti Google).**
`https://graph.microsoft.com/v1.0/me` dengan Bearer token — pola IDENTIK
dengan Google userinfo. Beda field name saja: `mail` vs `email`,
`userPrincipalName` vs `email`. Wrapper tipis.

**3. Discord = OpenID Connect (juga).**
`https://discord.com/api/users/@me` — sama lagi. Bearer + JSON. Avatar URL
perlu dikonstruksi dari CDN (`cdn.discordapp.com/avatars/{id}/{avatar}.png`).

**4. GitLab = GitHub-style (dengan confirmed_at).**
GitLab punya field `confirmed_at` yang berfungsi seperti `email_verified`
Google. Transparan mapping.

**5. Facebook = query param (bukan Bearer header).**
Facebook Graph API memakai `?access_token=` di URL, bukan Authorization
header. Ini satu-satunya provider yang beda transport. fetchProfile tetap
satu fungsi — perbedaan di dalam closure.

**6. Apple = jujur soal keterbatasan.**
Apple Sign-In memerlukan client_secret berupa **JWT yang di-sign ES256
(private key Apple Developer)** — ini bukan sekadar string secret. Butuh
generasi JWT runtime + private key management. v1: stub dengan error
informatif. Lebih jujur daripada fake implementation yang tidak bekerja.

## Provider Checklist

| Provider | authorizeUrl | tokenUrl | profileUrl | scope | email verified | Status |
|---|---|---|---|---|---|---|
| Google | accounts.google.com | oauth2.googleapis.com | userinfo (OIDC) | openid email profile | email_verified | ✅ Full |
| GitHub | github.com | github.com | /user + /user/emails | read:user user:email | emails[].verified | ✅ Full |
| Microsoft | login.microsoftonline.com | login.microsoftonline.com | graph /me | openid email profile User.Read | AD verified | ✅ Full |
| Discord | discord.com | discord.com/api | /users/@me | identify email | verified | ✅ Full |
| GitLab | gitlab.com | gitlab.com | /api/v4/user | read_user | confirmed_at | ✅ Full |
| Facebook | facebook.com | graph.facebook.com | /me?fields= | email public_profile | default | ✅ Full |
| Apple | appleid.apple.com | appleid.apple.com | id_token (JWT) | name email | — | ⏳ Stub (ES256) |

## Pertanyaan yang masih tersisa

- Apple: implement ES256 JWT client_secret generator (node:crypto generateKey + sign)
- Generic OAuth2 provider (self-hosted Keycloak, Authentik, etc.) — entry
  dengan URL custom
- LinkedIn, Twitter/X, Spotify — tinggal tambah entry
