package id.wekanz.baseforge.integration

import id.wekanz.baseforge.BaseForge
import id.wekanz.baseforge.ClientResponseException
import id.wekanz.baseforge.MemoryAuthStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Integrasi ke server BaseForge NYATA.
 *
 * MockWebServer membuktikan SDK berperilaku sesuai *anggapan* kita tentang server;
 * kelas ini membuktikan anggapan itu benar. Jalankan dengan:
 *
 * ```
 * BASEFORGE_TEST_URL=http://localhost:5100 \
 * BASEFORGE_TEST_PROJECT=<projectId> \
 * ./gradlew test --tests '*LiveAuthTest*'
 * ```
 *
 * Tanpa env tersebut, test ini **dilewati** (bukan gagal) supaya `./gradlew test` tetap
 * bisa jalan di mesin tanpa server.
 */
class LiveAuthTest {
    private val baseUrl: String? = System.getenv("BASEFORGE_TEST_URL")?.takeIf { it.isNotBlank() }
    private val projectId: String? = System.getenv("BASEFORGE_TEST_PROJECT")?.takeIf { it.isNotBlank() }

    private fun sdk(store: MemoryAuthStore = MemoryAuthStore()) =
        BaseForge(baseUrl!!, projectId!!, store)

    /** Email sekali pakai supaya test tidak bergantung pada data yang sudah ada. */
    private fun probeEmail() = "kt-sdk-probe-${System.currentTimeMillis()}@test.local"

    private fun requireServer(): Boolean {
        if (baseUrl == null || projectId == null) {
            println("SKIP LiveAuthTest — set BASEFORGE_TEST_URL & BASEFORGE_TEST_PROJECT untuk menjalankannya")
            return false
        }
        return true
    }

    @Test
    fun `siklus hidup sesi lengkap terhadap server nyata`() = runBlocking {
        if (!requireServer()) return@runBlocking
        val store = MemoryAuthStore()
        val bf = sdk(store)
        val email = probeEmail()

        // 1. register → langsung punya sesi (M09u)
        val reg = bf.auth.register(email, "ProbePass123!", name = "Probe Kotlin")
        assertTrue(reg.accessToken.isNotEmpty())
        assertEquals(email, reg.user?.email)
        assertTrue(store.isValid)

        // 2. me() memakai token dari store
        val me = bf.auth.me()
        assertEquals(email, me.email)
        assertEquals("Probe Kotlin", me.name)

        // 3. update parsial — hanya name yang berubah
        val updated = bf.auth.updateProfile(name = "Probe Diubah")
        assertEquals("Probe Diubah", updated.name)
        assertEquals(email, updated.email, "email tidak boleh ikut berubah")

        // 4. refresh membawa user (Ops-10) dan me-rotate token
        val tokenLama = store.token
        Thread.sleep(1100) // JWT exp beresolusi detik; hindari token identik
        val refreshed = bf.auth.refresh()
        assertNotNull(refreshed.user, "Ops-10: refresh harus mengembalikan user")
        assertEquals(email, refreshed.user?.email)
        assertTrue(store.token.isNotEmpty())
        assertTrue(store.token != tokenLama, "access token harus baru")

        // 5. token hasil refresh benar-benar dipakai
        assertEquals(email, bf.auth.me().email)

        // 6. logout mengakhiri sesi di server
        bf.auth.logout()
        assertNull(store.user)
        val ex = assertFailsWith<ClientResponseException> { bf.auth.me() }
        assertEquals(401, ex.status)
    }

    @Test
    fun `login salah password memberi INVALID_CREDENTIALS bukan SESSION_EXPIRED`() = runBlocking {
        if (!requireServer()) return@runBlocking
        val bf = sdk()
        val email = probeEmail()
        bf.auth.register(email, "ProbePass123!")

        // Sesi hasil register sengaja DIBIARKAN di store — inilah kondisi yang dulu
        // membuat 401 login disalahartikan sebagai sesi kedaluwarsa.
        val ex = assertFailsWith<ClientResponseException> { bf.auth.login(email, "SalahSekali!") }

        assertEquals(401, ex.status)
        assertEquals("INVALID_CREDENTIALS", ex.code)
        assertTrue(!ex.isSessionExpired)
    }

    @Test
    fun `user tanpa custom field mengembalikan profile null`() = runBlocking {
        if (!requireServer()) return@runBlocking
        // Project tanpa definisi auth-field tidak mengirim kunci `profile` sama sekali.
        val bf = sdk()
        bf.auth.register(probeEmail(), "ProbePass123!")
        val me = bf.auth.me()
        assertNull(me.profile, "tanpa custom field, profile harus null — bukan map kosong")
    }

    @Test
    fun `email ganda ditolak server`() = runBlocking {
        if (!requireServer()) return@runBlocking
        val email = probeEmail()
        sdk().auth.register(email, "ProbePass123!")

        val ex = assertFailsWith<ClientResponseException> {
            sdk().auth.register(email, "ProbePass123!")
        }
        assertTrue(ex.status == 409 || ex.status == 400, "status duplikat: ${ex.status} ${ex.code}")
    }

    @Test
    fun `custom field Ops-16 terbaca bila project mendefinisikannya`() = runBlocking {
        if (!requireServer()) return@runBlocking
        val fieldProject = System.getenv("BASEFORGE_TEST_PROJECT_FIELDS")?.takeIf { it.isNotBlank() }
        if (fieldProject == null) {
            println("SKIP — set BASEFORGE_TEST_PROJECT_FIELDS ke project yang punya auth-field 'bio'")
            return@runBlocking
        }
        val store = MemoryAuthStore()
        val bf = BaseForge(baseUrl!!, fieldProject, store)

        val reg = bf.auth.register(
            probeEmail(), "ProbePass123!",
            profile = mapOf("bio" to JsonPrimitive("halo dari kotlin")),
        )
        assertEquals("halo dari kotlin", reg.user?.profile?.get("bio")?.jsonPrimitive?.content)

        val updated = bf.auth.updateProfile(profile = mapOf("bio" to JsonPrimitive("diubah")))
        assertEquals("diubah", updated.profile?.get("bio")?.jsonPrimitive?.content)
    }
}
