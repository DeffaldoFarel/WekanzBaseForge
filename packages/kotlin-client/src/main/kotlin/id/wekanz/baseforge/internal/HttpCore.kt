package id.wekanz.baseforge.internal

import id.wekanz.baseforge.AuthStore
import id.wekanz.baseforge.ClientResponseException
import id.wekanz.baseforge.auth.ServerErrorEnvelope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * Konfigurasi JSON tunggal untuk seluruh SDK.
 *
 * - `ignoreUnknownKeys = true` — **wajib**. Server menambah field ke objek user
 *   (Ops-16 `profile` adalah contohnya) dan klien lama harus tetap jalan.
 * - `encodeDefaults = false` — membuat `PATCH /auth/me` benar-benar partial: properti
 *   yang tidak diisi hilang dari body, bukan terkirim sebagai `null`.
 * - `explicitNulls = false` — `null` tidak ikut diserialisasi kecuali sengaja dikirim
 *   sebagai `JsonNull` lewat map mentah.
 */
internal val BaseForgeJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
    explicitNulls = false
    isLenient = true
}

private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

/**
 * Inti HTTP SDK — padanan `baseService.ts` di SDK TypeScript.
 *
 * Tanggung jawab: menyusun URL, melampirkan Bearer token, mengubah error server jadi
 * [ClientResponseException], dan **auto-refresh 401 + retry sekali** (M37).
 */
internal class HttpCore(
    private val baseUrl: String,
    private val authStore: AuthStore,
    private val httpClient: OkHttpClient,
    /**
     * Cara melakukan refresh. Disuntik (bukan dipanggil langsung) agar `HttpCore` tidak
     * bergantung pada `AuthService` — `AuthService` sendiri memakai `HttpCore`, jadi
     * memanggilnya langsung akan menjadi lingkaran.
     */
    private val refreshTokens: suspend () -> Boolean,
) {
    // M37: refresh SINGLETON. Sepuluh request yang 401 bersamaan hanya boleh memicu
    // SATU POST /auth/refresh; sisanya menunggu lalu memakai token hasilnya. Tanpa ini,
    // setiap request akan me-rotate refresh token dan saling membatalkan.
    private val refreshMutex = Mutex()

    /**
     * @param allowAutoRefresh setel `false` untuk endpoint ANONIM (login, register,
     *   refresh). Pada endpoint itu, 401 berarti kredensial ditolak — bukan sesi
     *   kedaluwarsa — sehingga kode error asli server harus diteruskan apa adanya.
     */
    suspend fun request(
        method: String,
        path: String,
        body: Any? = null,
        bodySerializer: ((Any) -> String)? = null,
        headers: Map<String, String> = emptyMap(),
        query: Map<String, String?> = emptyMap(),
        allowAutoRefresh: Boolean = true,
    ): String? = requestInternal(method, path, body, bodySerializer, headers, query, allowAutoRefresh, isRetry = false)

    private suspend fun requestInternal(
        method: String,
        path: String,
        body: Any?,
        bodySerializer: ((Any) -> String)?,
        headers: Map<String, String>,
        query: Map<String, String?>,
        allowAutoRefresh: Boolean,
        isRetry: Boolean,
    ): String? {
        val url = buildUrl(path, query)

        val builder = Request.Builder().url(url).header("Accept", "application/json")
        headers.forEach { (k, v) -> builder.header(k, v) }

        // Baca token ULANG setiap percobaan — pada retry, nilainya sudah token baru.
        val token = authStore.token
        if (token.isNotEmpty() && !headers.containsKey("Authorization")) {
            builder.header("Authorization", "Bearer $token")
        }

        val reqBody = when {
            body == null -> null
            bodySerializer != null -> bodySerializer(body).toRequestBody(JSON_MEDIA)
            body is String -> body.toRequestBody(JSON_MEDIA)
            else -> error("body needs a serializer")
        }
        when (method.uppercase()) {
            "GET" -> builder.get()
            "DELETE" -> if (reqBody != null) builder.delete(reqBody) else builder.delete()
            else -> builder.method(method.uppercase(), reqBody ?: "".toRequestBody(JSON_MEDIA))
        }

        val response = try {
            withContext(Dispatchers.IO) { httpClient.newCall(builder.build()).execute() }
        } catch (e: IOException) {
            // status 0 = tidak pernah sampai ke server. Aplikasi offline-first memakai ini
            // untuk membedakan "belum tersinkron" dari "ditolak server".
            throw ClientResponseException(0, e.message ?: "Network request failed", "NETWORK_ERROR", cause = e)
        }

        val code = response.code
        val text = response.body?.string()
        response.close()

        // M37: 401 → refresh → retry SEKALI.
        //
        // HANYA untuk endpoint terautentikasi. Pada login/register/refresh
        // ([allowAutoRefresh] = false), 401 berarti kredensial ditolak: mengubahnya jadi
        // SESSION_EXPIRED akan menyembunyikan `INVALID_CREDENTIALS`, menampilkan "sesi
        // berakhir" di layar login, dan — bila ada sesi lama yang masih tersimpan —
        // diam-diam menembak /auth/refresh milik user LAIN saat login gagal.
        //
        // `token.isNotEmpty()` adalah sabuk pengaman kedua: tanpa token, request ini tidak
        // pernah mengatasnamakan sesi mana pun, jadi tidak ada yang perlu di-refresh.
        val refreshable = allowAutoRefresh && !path.contains("/auth/refresh")
        if (code == 401 && !isRetry && refreshable && token.isNotEmpty()) {
            val refreshed = tryRefresh()
            if (refreshed) {
                return requestInternal(method, path, body, bodySerializer, headers, query, allowAutoRefresh, isRetry = true)
            }
            throw ClientResponseException(401, "Session expired. Please sign in again.", "SESSION_EXPIRED", text)
        }

        if (!response.isSuccessful) throw toException(code, text)
        if (code == 204 || text.isNullOrBlank()) return null
        return text
    }

    /**
     * Refresh di bawah [refreshMutex].
     *
     * Setelah mendapatkan lock, token dibaca ULANG: bila request lain sudah menyelesaikan
     * refresh selagi kita menunggu, tidak ada gunanya me-refresh lagi (double-checked).
     * Ini yang membuat sepuluh 401 serentak hanya menghasilkan satu POST.
     */
    private suspend fun tryRefresh(): Boolean {
        if (authStore.refreshToken.isEmpty()) return false
        val tokenBefore = authStore.token
        return refreshMutex.withLock {
            if (authStore.token.isNotEmpty() && authStore.token != tokenBefore) return@withLock true
            if (authStore.refreshToken.isEmpty()) return@withLock false
            try {
                refreshTokens()
            } catch (_: Exception) {
                authStore.clear()
                false
            }
        }
    }

    private fun buildUrl(path: String, query: Map<String, String?>): String {
        val base = baseUrl.trimEnd('/')
        val p = path.trimStart('/')
        val sb = StringBuilder("$base/$p")
        val entries = query.filterValues { !it.isNullOrEmpty() }
        if (entries.isNotEmpty()) {
            sb.append(if (sb.contains('?')) '&' else '?')
            sb.append(entries.entries.joinToString("&") { (k, v) ->
                "${java.net.URLEncoder.encode(k, "UTF-8")}=${java.net.URLEncoder.encode(v, "UTF-8")}"
            })
        }
        return sb.toString()
    }

    private fun toException(status: Int, text: String?): ClientResponseException {
        var message = "HTTP error $status"
        var code: String? = null
        if (!text.isNullOrBlank()) {
            runCatching {
                val env = BaseForgeJson.decodeFromString(ServerErrorEnvelope.serializer(), text)
                env.error?.message?.let { message = it }
                env.error?.code?.let { code = it }
                if (env.error == null) env.message?.let { message = it }
            }
        }
        return ClientResponseException(status, message, code, text)
    }
}
