package id.wekanz.baseforge

import id.wekanz.baseforge.auth.AuthResponse
import id.wekanz.baseforge.auth.AuthService
import id.wekanz.baseforge.internal.HttpCore
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Titik masuk SDK BaseForge.
 *
 * ```kotlin
 * val bf = BaseForge(
 *     baseUrl = "https://baseforge.wekanz.id",
 *     projectId = "li0qp2ktpwi1wqc",
 *     authStore = DataStoreAuthStore(context), // atau MemoryAuthStore()
 * )
 *
 * val res = bf.auth.login("user@mail.com", "rahasia")
 * println(res.user?.name)
 * ```
 *
 * Instance ini **stateless kecuali [authStore]** dan aman dipakai bersama (thread-safe);
 * buat satu saja per aplikasi, misalnya sebagai singleton Hilt.
 *
 * Token disegarkan otomatis saat server menjawab 401; bila refresh gagal, SDK melempar
 * [ClientResponseException] dengan `code = "SESSION_EXPIRED"` dan membersihkan store.
 * Amati perubahan sesi lewat [AuthStore.onChange] untuk memicu navigasi ke layar login.
 */
public class BaseForge(
    baseUrl: String,
    projectId: String,
    public val authStore: AuthStore = MemoryAuthStore(),
    httpClient: OkHttpClient = defaultHttpClient(),
) {
    private val http: HttpCore

    public val auth: AuthService

    init {
        require(baseUrl.isNotBlank()) { "baseUrl must not be blank" }
        require(projectId.isNotBlank()) { "projectId must not be blank" }

        // Simpul lingkaran: HttpCore perlu cara me-refresh, AuthService perlu HttpCore.
        // Diselesaikan dengan lateinit lokal + lambda yang baru dievaluasi saat dipakai.
        lateinit var authRef: AuthService
        http = HttpCore(
            baseUrl = baseUrl,
            authStore = authStore,
            httpClient = httpClient,
            refreshTokens = {
                val res: AuthResponse = authRef.refresh()
                res.accessToken.isNotEmpty()
            },
        )
        authRef = AuthService(http, authStore, projectId)
        auth = authRef
    }

    public companion object {
        /** OkHttp dengan timeout yang masuk akal untuk jaringan seluler. */
        public fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
