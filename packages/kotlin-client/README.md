# BaseForge Kotlin Client

SDK Kotlin/JVM untuk [BaseForge](../../README.md) — paritas kontrak dengan SDK TypeScript
di `packages/client`.

**v0.3.1 — Auth + Records + Files.** Realtime menyusul di v0.4.0.

## Instalasi (JitPack — bisa dipakai siapa saja)

Repo BaseForge public, dan SDK didistribusikan lewat **JitPack** — tidak perlu clone atau
build manual:

```kotlin
// settings.gradle.kts konsumen
dependencyResolutionManagement {
    repositories {
        mavenCentral()
        maven { url = uri("https://jitpack.io") }
    }
}

// build.gradle.kts konsumen
dependencies {
    implementation("com.github.DeffaldoFarel:WekanzBaseForge:v0.3.1")
}
```

> **Catatan koordinat:** JitPack menerbitkan artifact dengan **nama repo** sebagai
> artifactId (`WekanzBaseForge`), BUKAN `kotlin-client` — meski `artifactId` di
> `build.gradle.kts` disetel `kotlin-client`. Selalu pakai
> `com.github.DeffaldoFarel:WekanzBaseForge:v<tag>`.

Android: `minSdk 26` aman (JVM 17 + desugaring AGP 8). Tidak ada dependensi AndroidX —
SDK ini JVM murni, jadi bisa dipakai juga dari Compose Desktop atau server Kotlin.

### Alternatif: mavenLocal (dev dengan perubahan belum di-tag)

Kalau sedang mengembangkan SDK dan ingin memakai perubahan yang belum di-tag di JitPack:

```bash
cd packages/kotlin-client && ./gradlew publishToMavenLocal
```

```kotlin
// settings.gradle.kts konsumen — mavenLocal() di ATAS jitpack agar didahulukan
repositories { mavenLocal(); maven { url = uri("https://jitpack.io") }; mavenCentral() }

// build.gradle.kts
implementation("id.wekanz.baseforge:kotlin-client:0.3.1")
```

## Pemakaian

```kotlin
val bf = BaseForge(
    baseUrl = "https://baseforge.wekanz.id",
    projectId = "li0qp2ktpwi1wqc",
    authStore = MemoryAuthStore(), // di Android: implementasi DataStore Anda
)

// Register langsung membuat sesi — tidak perlu login lagi sesudahnya.
val res = bf.auth.register("user@mail.com", "rahasia", name = "Budi")

val me = bf.auth.me()
bf.auth.updateProfile(name = "Budi Santoso")   // partial: hanya name yang dikirim
bf.auth.logout()
```

Semua metode `suspend` — panggil dari `viewModelScope` / coroutine apa pun.

### Menangani error

```kotlin
try {
    bf.auth.login(email, password)
} catch (e: ClientResponseException) {
    when {
        e.isNetworkError  -> "Tidak ada koneksi"          // status 0
        e.isUserDisabled  -> "Akun dinonaktifkan admin"   // 403 USER_DISABLED
        e.code == "INVALID_CREDENTIALS" -> "Email atau password salah"
        else -> e.message
    }
}
```

`SESSION_EXPIRED` hanya muncul ketika refresh otomatis gagal — itulah sinyal untuk
kembali ke layar login.

### Custom profile field (Ops-16)

Field yang didefinisikan admin muncul di `user.profile` sebagai `Map<String, JsonElement>`.
Bila project belum mendefinisikan field apa pun, `profile` bernilai **`null`** — bukan map
kosong.

```kotlin
bf.auth.register(email, pass, profile = mapOf("bio" to JsonPrimitive("halo")))
bf.auth.updateProfile(profile = mapOf("bio" to JsonPrimitive("diubah")))
// field admin-only → ClientResponseException 403 FIELD_NOT_EDITABLE
```

Untuk **mengosongkan** field, kirim `JsonNull` lewat `updateProfileRaw`.

### Menyimpan sesi di Android

`MemoryAuthStore` hilang saat aplikasi ditutup. Implementasikan `AuthStore` di atas
DataStore/EncryptedSharedPreferences, lalu suntikkan ke konstruktor. Amati perubahan
sesi dengan `authStore.onChange { token, user -> ... }` untuk memicu navigasi.

## Perilaku yang dijamin

| Perilaku | Alasan |
|---|---|
| 401 → refresh → **retry sekali** | M37 |
| Banyak 401 serentak → **satu** POST `/auth/refresh` | M37 (mutex + double-check) |
| Login/register/refresh **tidak pernah** auto-refresh | 401 di sana = kredensial salah, bukan sesi habis |
| `403 USER_DISABLED` tidak menghapus sesi | Ops-15 — beda dari sesi kedaluwarsa |
| `refresh()` menyimpan `user` dari respons | Ops-10 — tidak perlu `me()` sesudahnya |
| Field JSON tak dikenal diabaikan | Server boleh menambah field tanpa merusak APK lama |
| `logout()` membersihkan sesi walau offline | Tombol keluar harus selalu berhasil |

## Test

```bash
./gradlew test                      # 22 unit test (MockWebServer)

# + 5 integration test ke server BaseForge nyata:
BASEFORGE_TEST_URL=http://localhost:5100 \
BASEFORGE_TEST_PROJECT=<projectId> \
BASEFORGE_TEST_PROJECT_FIELDS=<projectId dgn auth-field 'bio'> \
./gradlew test --tests '*LiveAuthTest*'
```

Tanpa env, `LiveAuthTest` **dilewati**, bukan gagal.
