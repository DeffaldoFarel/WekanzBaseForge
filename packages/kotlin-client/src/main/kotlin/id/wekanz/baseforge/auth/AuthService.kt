package id.wekanz.baseforge.auth

import id.wekanz.baseforge.AuthStore
import id.wekanz.baseforge.ClientResponseException
import id.wekanz.baseforge.internal.BaseForgeJson
import id.wekanz.baseforge.internal.HttpCore
import kotlinx.serialization.json.JsonElement

/**
 * Operasi autentikasi — paritas dengan `authService.ts` di SDK TypeScript.
 *
 * Semua metode `suspend` dan aman dipanggil dari `viewModelScope`.
 * Kegagalan dilaporkan sebagai [ClientResponseException] (lihat kolom `code`-nya).
 */
public class AuthService internal constructor(
    private val http: HttpCore,
    private val authStore: AuthStore,
    private val projectId: String,
) {
    private val base: String get() = "api/p/$projectId/auth"

    /** Sesi saat ini menurut store (tanpa memanggil jaringan). */
    public val currentUser: AuthUser? get() = authStore.user
    public val isLoggedIn: Boolean get() = authStore.isValid

    /**
     * Login email + password. Sesi langsung tersimpan ke [AuthStore].
     *
     * Error yang perlu dibedakan aplikasi:
     * - `401 INVALID_CREDENTIALS` — email/password salah.
     * - `403 USER_DISABLED` (Ops-15) — akun dinonaktifkan admin; mencoba lagi percuma,
     *   tampilkan pesan "hubungi admin", bukan "password salah".
     */
    public suspend fun login(email: String, password: String): AuthResponse {
        val body = BaseForgeJson.encodeToString(LoginRequest.serializer(), LoginRequest(email, password))
        val text = http.request("POST", "$base/login", body, allowAutoRefresh = false)
            ?: error("empty login response")
        return BaseForgeJson.decodeFromString(AuthResponse.serializer(), text).also { persist(it) }
    }

    /**
     * Daftar akun baru. Server mengembalikan token sekaligus (201) — **tidak perlu
     * login lagi** setelah ini (M09u).
     *
     * [profile] mengisi custom field Ops-16 saat register; field ber-`required` yang
     * didefinisikan admin ditegakkan di sini (dan hanya di sini).
     */
    public suspend fun register(
        email: String,
        password: String,
        name: String? = null,
        profile: Map<String, JsonElement>? = null,
    ): AuthResponse {
        val body = BaseForgeJson.encodeToString(
            RegisterRequest.serializer(),
            RegisterRequest(email, password, name, profile),
        )
        val text = http.request("POST", "$base/register", body, allowAutoRefresh = false)
            ?: error("empty register response")
        return BaseForgeJson.decodeFromString(AuthResponse.serializer(), text).also { persist(it) }
    }

    /**
     * Tukar refresh token dengan access token baru.
     *
     * Jarang dipanggil manual — [HttpCore] sudah melakukannya otomatis saat 401.
     * **Ops-10:** respons memuat `user`, jadi tidak perlu `me()` sesudahnya.
     */
    public suspend fun refresh(): AuthResponse {
        val rt = authStore.refreshToken
        if (rt.isEmpty()) throw ClientResponseException(401, "No refresh token", "SESSION_EXPIRED")
        val body = BaseForgeJson.encodeToString(RefreshRequest.serializer(), RefreshRequest(rt))
        val text = http.request("POST", "$base/refresh", body, allowAutoRefresh = false)
            ?: error("empty refresh response")
        return BaseForgeJson.decodeFromString(AuthResponse.serializer(), text).also { persist(it) }
    }

    /** Ambil user terbaru dari server dan segarkan store. */
    public suspend fun me(): AuthUser {
        val text = http.request("GET", "$base/me") ?: error("empty me response")
        val user = BaseForgeJson.decodeFromString(UserResponse.serializer(), text).user
        authStore.save(authStore.token, authStore.refreshToken, user)
        return user
    }

    /**
     * Ubah profil sendiri — **partial**: yang tidak disebut tidak berubah.
     *
     * [profile] hanya boleh memuat field yang ditandai `userEditable` oleh admin;
     * selain itu server menolak dengan `403 FIELD_NOT_EDITABLE` (Ops-16).
     *
     * Untuk MENGOSONGKAN field, pakai [updateProfileRaw] dengan `JsonNull`.
     */
    public suspend fun updateProfile(
        name: String? = null,
        avatarUrl: String? = null,
        profile: Map<String, JsonElement>? = null,
    ): AuthUser = updateProfileRaw(UpdateProfileRequest(name, avatarUrl, profile))

    /** Versi mentah [updateProfile] bila perlu mengirim `JsonNull` eksplisit. */
    public suspend fun updateProfileRaw(payload: UpdateProfileRequest): AuthUser {
        val body = BaseForgeJson.encodeToString(UpdateProfileRequest.serializer(), payload)
        val text = http.request("PATCH", "$base/me", body) ?: error("empty update response")
        val user = BaseForgeJson.decodeFromString(UserResponse.serializer(), text).user
        authStore.save(authStore.token, authStore.refreshToken, user)
        return user
    }

    /**
     * Akhiri sesi.
     *
     * Store **selalu** dibersihkan, bahkan bila panggilan server gagal: user yang menekan
     * "keluar" harus benar-benar keluar dari perangkatnya meski sedang offline.
     */
    public suspend fun logout() {
        val rt = authStore.refreshToken
        try {
            if (rt.isNotEmpty()) {
                val body = BaseForgeJson.encodeToString(RefreshRequest.serializer(), RefreshRequest(rt))
                http.request("POST", "$base/logout", body)
            }
        } catch (_: Exception) {
            // diabaikan dengan sengaja — lihat KDoc
        } finally {
            authStore.clear()
        }
    }

    private fun persist(res: AuthResponse) {
        authStore.save(res.accessToken, res.refreshToken, res.user)
    }
}
