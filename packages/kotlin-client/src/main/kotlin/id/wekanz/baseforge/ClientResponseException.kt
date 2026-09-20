package id.wekanz.baseforge

/**
 * Error dari BaseForge.
 *
 * [status] 0 berarti kegagalan jaringan (tidak pernah sampai ke server) — bedakan dari
 * error HTTP asli saat memutuskan retry.
 *
 * [code] adalah kode mesin dari server (`error.code`), bukan teks untuk manusia.
 * Cabang yang penting untuk klien:
 *
 * | code | arti |
 * |---|---|
 * | `INVALID_CREDENTIALS` (401) | email/password salah |
 * | `USER_DISABLED` (403) | akun dinonaktifkan admin — **bukan** sesi kedaluwarsa |
 * | `SESSION_EXPIRED` (401) | refresh gagal/habis → user harus login ulang |
 * | `FIELD_NOT_EDITABLE` (403) | mencoba mengubah custom field admin-only (Ops-16) |
 * | `EMAIL_TAKEN` (409) | register dengan email yang sudah ada |
 */
public class ClientResponseException(
    public val status: Int,
    message: String,
    public val code: String? = null,
    public val rawBody: String? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {

    /** Kegagalan jaringan, bukan penolakan server. */
    public val isNetworkError: Boolean get() = status == 0

    /** Sesi tidak bisa dipulihkan otomatis — tampilkan layar login. */
    public val isSessionExpired: Boolean get() = code == "SESSION_EXPIRED"

    /** Akun dinonaktifkan admin. Login ulang TIDAK akan menolong. */
    public val isUserDisabled: Boolean get() = code == "USER_DISABLED"

    override fun toString(): String = "ClientResponseException(status=$status, code=$code, message=$message)"
}
