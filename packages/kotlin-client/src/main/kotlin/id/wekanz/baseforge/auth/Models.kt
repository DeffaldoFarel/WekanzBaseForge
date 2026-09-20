package id.wekanz.baseforge.auth

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * User yang sedang login.
 *
 * **Ops-16 — `profile`:** custom profile field yang didefinisikan admin per project.
 * Kuncinya **tidak dikirim sama sekali** oleh server bila project belum mendefinisikan
 * field apa pun, jadi `null` di sini berarti "tidak ada custom field", BUKAN "gagal baca".
 *
 * **Ketahanan kontrak:** parser dikonfigurasi `ignoreUnknownKeys = true`
 * ([id.wekanz.baseforge.internal.BaseForgeJson]). Server yang menambah field baru pada
 * objek user TIDAK boleh membuat klien lama crash — ini yang membuat penambahan fitur
 * server (seperti Ops-16 sendiri) aman bagi aplikasi yang sudah beredar.
 */
@Serializable
public data class AuthUser(
    val id: String,
    val email: String,
    val name: String? = null,
    val avatarUrl: String? = null,
    val verified: Boolean = false,
    val mfaEnabled: Boolean = false,
    val created: String? = null,
    val profile: Map<String, JsonElement>? = null,
)

/**
 * Respons sukses dari login / register / refresh.
 *
 * **Ops-10:** `/auth/refresh` mengembalikan `user` juga — jangan dibuang; itulah alasan
 * endpoint-nya diubah, supaya klien tidak perlu memanggil `/auth/me` setelah refresh.
 */
@Serializable
public data class AuthResponse(
    val accessToken: String,
    val refreshToken: String = "",
    val expiresIn: Long? = null,
    val user: AuthUser? = null,
)

/** Respons `GET /auth/me` dan `PATCH /auth/me`. */
@Serializable
public data class UserResponse(
    val user: AuthUser,
)

/**
 * Payload `PATCH /auth/me` — **partial update**.
 *
 * Field yang tidak disertakan TIDAK disentuh server. Karena `encodeDefaults = false`,
 * properti yang dibiarkan `null` di sini hilang dari JSON, sehingga
 * `updateProfile(name = "Budi")` benar-benar hanya mengirim `{"name":"Budi"}`.
 *
 * Konsekuensinya: **mengosongkan** sebuah field tidak bisa lewat parameter biasa —
 * pakai [id.wekanz.baseforge.auth.AuthService.updateProfileRaw] dan kirim `JsonNull`
 * secara eksplisit.
 */
@Serializable
public data class UpdateProfileRequest(
    val name: String? = null,
    val avatarUrl: String? = null,
    val profile: Map<String, JsonElement>? = null,
)

@Serializable
internal data class LoginRequest(val email: String, val password: String)

@Serializable
internal data class RegisterRequest(
    val email: String,
    val password: String,
    val name: String? = null,
    val profile: Map<String, JsonElement>? = null,
)

@Serializable
internal data class RefreshRequest(val refreshToken: String)

/** Bentuk error server: `{"error":{"code":"...","message":"..."}}`. */
@Serializable
internal data class ServerErrorEnvelope(val error: ServerError? = null, val message: String? = null)

@Serializable
internal data class ServerError(
    val code: String? = null,
    val message: String? = null,
    @SerialName("details") val details: JsonElement? = null,
)
