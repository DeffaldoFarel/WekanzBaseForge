package id.wekanz.baseforge

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Perilaku transport: auto-refresh 401, refresh singleton, dan batas-batasnya.
 * Ini aturan yang paling mahal bila salah, jadi diuji terhadap server HTTP nyata
 * (MockWebServer), bukan mock objek.
 */
class HttpCoreTest {
    private lateinit var server: MockWebServer

    private fun json(body: String, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun authBody(token: String, refresh: String = "r1") =
        """{"accessToken":"$token","refreshToken":"$refresh","user":{"id":"u1","email":"a@b.c"}}"""

    private fun sdk(store: AuthStore = MemoryAuthStore()) =
        BaseForge(server.url("/").toString(), "proj1", store)

    @BeforeTest fun setUp() { server = MockWebServer(); server.start() }
    @AfterTest fun tearDown() { server.shutdown() }

    @Test
    fun `401 memicu refresh lalu mengulang request sekali`() = runTest {
        val store = MemoryAuthStore()
        store.save("expired", "r1", null)
        server.enqueue(json("""{"error":{"code":"TOKEN_EXPIRED"}}""", 401))  // me() pertama
        server.enqueue(json(authBody("fresh", "r2")))                        // refresh
        server.enqueue(json("""{"user":{"id":"u1","email":"a@b.c"}}"""))     // me() diulang

        val user = sdk(store).auth.me()

        assertEquals("u1", user.id)
        assertEquals(3, server.requestCount)
        val r1 = server.takeRequest(); val r2 = server.takeRequest(); val r3 = server.takeRequest()
        assertTrue(r1.path!!.endsWith("/auth/me"))
        assertTrue(r2.path!!.endsWith("/auth/refresh"))
        assertTrue(r3.path!!.endsWith("/auth/me"))
        // Retry HARUS memakai token baru, bukan token basi.
        assertEquals("Bearer fresh", r3.getHeader("Authorization"))
        assertEquals("fresh", store.token)
        assertEquals("r2", store.refreshToken) // rotasi refresh token ikut tersimpan
    }

    @Test
    fun `401 dua kali berturut-turut menyerah dan tidak mengulang tanpa batas`() = runTest {
        val store = MemoryAuthStore()
        store.save("expired", "r1", null)
        server.enqueue(json("{}", 401))
        server.enqueue(json(authBody("fresh")))
        server.enqueue(json("{}", 401)) // masih 401 setelah refresh

        val ex = assertFailsWith<ClientResponseException> { sdk(store).auth.me() }

        assertEquals(401, ex.status)
        assertEquals(3, server.requestCount) // tepat satu retry, bukan loop
    }

    @Test
    fun `refresh gagal membersihkan sesi dan melaporkan SESSION_EXPIRED`() = runTest {
        val store = MemoryAuthStore()
        store.save("expired", "bad-refresh", null)
        server.enqueue(json("{}", 401))
        server.enqueue(json("""{"error":{"code":"INVALID_REFRESH"}}""", 401)) // refresh ditolak

        val ex = assertFailsWith<ClientResponseException> { sdk(store).auth.me() }

        assertTrue(ex.isSessionExpired, "harus SESSION_EXPIRED, dapat ${ex.code}")
        assertEquals("", store.token)
        assertNull(store.user)
    }

    @Test
    fun `banyak 401 serentak hanya memicu SATU refresh`() = runTest {
        val store = MemoryAuthStore()
        store.save("expired", "r1", null)
        // 5 request paralel semuanya 401, lalu satu refresh, lalu 5 retry sukses.
        val dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            val refreshHits = java.util.concurrent.atomic.AtomicInteger(0)
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    path.endsWith("/auth/refresh") -> {
                        refreshHits.incrementAndGet()
                        Thread.sleep(150) // beri waktu request lain menabrak lock
                        json(authBody("fresh", "r2"))
                    }
                    request.getHeader("Authorization") == "Bearer fresh" ->
                        json("""{"user":{"id":"u1","email":"a@b.c"}}""")
                    else -> json("{}", 401)
                }
            }
        }
        server.dispatcher = dispatcher

        val bf = sdk(store)
        val results = (1..5).map { async { bf.auth.me() } }.awaitAll()

        assertEquals(5, results.size)
        assertEquals(1, dispatcher.refreshHits.get(), "refresh harus singleton (M37)")
    }

    @Test
    fun `403 USER_DISABLED tidak memicu refresh dan tidak menghapus sesi`() = runTest {
        // Ops-15: akun dinonaktifkan itu 403, bukan 401. Me-refresh tidak akan menolong,
        // dan menghapus store akan menyamarkannya sebagai "sesi habis".
        val store = MemoryAuthStore()
        store.save("valid", "r1", null)
        server.enqueue(json("""{"error":{"code":"USER_DISABLED","message":"Account is disabled"}}""", 403))

        val ex = assertFailsWith<ClientResponseException> { sdk(store).auth.me() }

        assertEquals(403, ex.status)
        assertTrue(ex.isUserDisabled)
        assertEquals(1, server.requestCount, "403 tidak boleh memicu refresh")
        assertEquals("valid", store.token, "sesi tidak boleh dihapus oleh 403")
    }

    @Test
    fun `401 pada endpoint refresh tidak me-refresh dirinya sendiri`() = runTest {
        val store = MemoryAuthStore()
        store.save("t", "r1", null)
        server.enqueue(json("""{"error":{"code":"INVALID_REFRESH"}}""", 401))

        assertFailsWith<ClientResponseException> { sdk(store).auth.refresh() }

        assertEquals(1, server.requestCount, "tidak boleh rekursi ke /auth/refresh")
    }

    @Test
    fun `tanpa refresh token 401 langsung jadi SESSION_EXPIRED`() = runTest {
        val store = MemoryAuthStore()
        store.save("t", "", null) // mis. sesi dipulihkan sebagian
        server.enqueue(json("{}", 401))

        val ex = assertFailsWith<ClientResponseException> { sdk(store).auth.me() }

        assertTrue(ex.isSessionExpired)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `kegagalan jaringan dilaporkan sebagai status 0`() = runTest {
        server.shutdown() // tidak ada yang mendengarkan
        val ex = assertFailsWith<ClientResponseException> { sdk().auth.login("a@b.c", "x") }

        assertEquals(0, ex.status)
        assertTrue(ex.isNetworkError)
    }

    @Test
    fun `pesan error diambil dari envelope server`() = runTest {
        server.enqueue(json("""{"error":{"code":"INVALID_CREDENTIALS","message":"Invalid email or password"}}""", 401))

        // login() tidak punya token, jadi 401 di sini bukan urusan auto-refresh
        val ex = assertFailsWith<ClientResponseException> { sdk().auth.login("a@b.c", "salah") }

        assertEquals("INVALID_CREDENTIALS", ex.code)
        assertEquals("Invalid email or password", ex.message)
    }
}
