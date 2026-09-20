package id.wekanz.baseforge

import id.wekanz.baseforge.auth.AuthUser
import id.wekanz.baseforge.internal.BaseForgeJson
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Bentuk request/response tiap endpoint auth + paritas kontrak dengan SDK TypeScript. */
class AuthServiceTest {
    private lateinit var server: MockWebServer

    private fun json(body: String, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun sdk(store: AuthStore = MemoryAuthStore()) =
        BaseForge(server.url("/").toString(), "proj1", store)

    @BeforeTest fun setUp() { server = MockWebServer(); server.start() }
    @AfterTest fun tearDown() { server.shutdown() }

    @Test
    fun `login mengirim kredensial ke path project dan menyimpan sesi`() = runTest {
        val store = MemoryAuthStore()
        server.enqueue(json("""{"accessToken":"a1","refreshToken":"r1","user":{"id":"u1","email":"a@b.c","name":"Budi"}}"""))

        val res = sdk(store).auth.login("a@b.c", "rahasia")

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/p/proj1/auth/login", req.path)
        val sent = BaseForgeJson.parseToJsonElement(req.body.readUtf8()) as JsonObject
        assertEquals("a@b.c", sent["email"]!!.jsonPrimitive.content)
        assertEquals("rahasia", sent["password"]!!.jsonPrimitive.content)

        assertEquals("Budi", res.user?.name)
        assertEquals("a1", store.token)
        assertEquals("r1", store.refreshToken)
        assertTrue(store.isValid)
    }

    @Test
    fun `register mengembalikan token sehingga tidak perlu login lagi`() = runTest {
        val store = MemoryAuthStore()
        server.enqueue(json("""{"accessToken":"a1","refreshToken":"r1","user":{"id":"u2","email":"baru@b.c"}}""", 201))

        val res = sdk(store).auth.register("baru@b.c", "rahasia", name = "Siti")

        assertEquals("a1", res.accessToken)
        assertTrue(store.isValid, "register harus langsung membuat sesi (M09u)")
        val sent = BaseForgeJson.parseToJsonElement(server.takeRequest().body.readUtf8()) as JsonObject
        assertEquals("Siti", sent["name"]!!.jsonPrimitive.content)
        assertFalse(sent.containsKey("profile"), "profile null tidak boleh ikut terkirim")
    }

    @Test
    fun `register dapat mengisi custom field Ops-16`() = runTest {
        server.enqueue(json("""{"accessToken":"a1","refreshToken":"r1","user":{"id":"u2","email":"b@b.c","profile":{"bio":"halo"}}}""", 201))

        val res = sdk().auth.register(
            "b@b.c", "rahasia",
            profile = mapOf("bio" to JsonPrimitive("halo")),
        )

        val sent = BaseForgeJson.parseToJsonElement(server.takeRequest().body.readUtf8()) as JsonObject
        assertEquals("halo", (sent["profile"] as JsonObject)["bio"]!!.jsonPrimitive.content)
        assertEquals("halo", res.user?.profile?.get("bio")?.jsonPrimitive?.content)
    }

    @Test
    fun `user tanpa profile menghasilkan null bukan error`() = runTest {
        // Project yang belum mendefinisikan custom field TIDAK mengirim kunci `profile`.
        server.enqueue(json("""{"user":{"id":"u1","email":"a@b.c","verified":true,"mfaEnabled":false}}"""))
        val store = MemoryAuthStore().apply { save("t", "r", null) }

        val user = sdk(store).auth.me()

        assertNull(user.profile)
        assertTrue(user.verified)
    }

    @Test
    fun `field baru dari server tidak membuat klien lama crash`() = runTest {
        // Inilah yang membuat penambahan fitur server aman bagi APK yang sudah beredar.
        server.enqueue(json("""{"user":{"id":"u1","email":"a@b.c","fiturMasaDepan":{"x":1},"anotherNew":"v"}}"""))
        val store = MemoryAuthStore().apply { save("t", "r", null) }

        val user = sdk(store).auth.me()

        assertEquals("u1", user.id)
    }

    @Test
    fun `updateProfile bersifat partial - field yang tidak diisi tidak terkirim`() = runTest {
        server.enqueue(json("""{"user":{"id":"u1","email":"a@b.c","name":"Nama Baru"}}"""))
        val store = MemoryAuthStore().apply { save("t", "r", null) }

        sdk(store).auth.updateProfile(name = "Nama Baru")

        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/api/p/proj1/auth/me", req.path)
        val sent = BaseForgeJson.parseToJsonElement(req.body.readUtf8()) as JsonObject
        assertEquals("Nama Baru", sent["name"]!!.jsonPrimitive.content)
        assertEquals(setOf("name"), sent.keys, "hanya field yang diisi boleh terkirim")
    }

    @Test
    fun `updateProfileRaw dapat mengosongkan field dengan JsonNull`() = runTest {
        server.enqueue(json("""{"user":{"id":"u1","email":"a@b.c"}}"""))
        val store = MemoryAuthStore().apply { save("t", "r", null) }

        sdk(store).auth.updateProfileRaw(
            id.wekanz.baseforge.auth.UpdateProfileRequest(profile = mapOf("bio" to JsonNull)),
        )

        val sent = BaseForgeJson.parseToJsonElement(server.takeRequest().body.readUtf8()) as JsonObject
        assertTrue((sent["profile"] as JsonObject)["bio"] is JsonNull)
    }

    @Test
    fun `updateProfile field admin-only ditolak 403 FIELD_NOT_EDITABLE`() = runTest {
        server.enqueue(json("""{"error":{"code":"FIELD_NOT_EDITABLE","message":"Field 'tier' is not user-editable"}}""", 403))
        val store = MemoryAuthStore().apply { save("t", "r", null) }

        val ex = assertFailsWith<ClientResponseException> {
            sdk(store).auth.updateProfile(profile = mapOf("tier" to JsonPrimitive("pro")))
        }

        assertEquals(403, ex.status)
        assertEquals("FIELD_NOT_EDITABLE", ex.code)
        assertEquals("t", store.token, "403 tidak boleh mengakhiri sesi")
    }

    @Test
    fun `refresh menyimpan user dari respons`() = runTest {
        // Ops-10: /auth/refresh mengembalikan user — klien tidak perlu me() lagi.
        val store = MemoryAuthStore().apply { save("lama", "r1", null) }
        server.enqueue(json("""{"accessToken":"baru","refreshToken":"r2","user":{"id":"u1","email":"a@b.c","name":"Budi"}}"""))

        val res = sdk(store).auth.refresh()

        assertEquals("Budi", res.user?.name)
        assertEquals("Budi", store.user?.name, "user dari refresh harus tersimpan")
        assertEquals("baru", store.token)
    }

    @Test
    fun `logout membersihkan sesi meski server tidak terjangkau`() = runTest {
        val store = MemoryAuthStore().apply { save("t", "r1", AuthUser(id = "u1", email = "a@b.c")) }
        server.shutdown() // simulasi offline

        sdk(store).auth.logout()

        assertEquals("", store.token)
        assertNull(store.user)
        assertFalse(store.isValid)
    }

    @Test
    fun `login akun dinonaktifkan melaporkan USER_DISABLED`() = runTest {
        server.enqueue(json("""{"error":{"code":"USER_DISABLED","message":"Account is disabled"}}""", 403))

        val ex = assertFailsWith<ClientResponseException> { sdk().auth.login("a@b.c", "rahasia") }

        assertTrue(ex.isUserDisabled)
        assertFalse(ex.isSessionExpired, "jangan disamarkan sebagai sesi kedaluwarsa")
    }

    @Test
    fun `login salah password tetap INVALID_CREDENTIALS walau ada sesi lama`() = runTest {
        // Regresi: dulu 401 apa pun dianggap "sesi kedaluwarsa". Akibatnya user yang
        // salah ketik password di layar login melihat "sesi berakhir", dan SDK diam-diam
        // menembak /auth/refresh memakai sesi user LAMA.
        val store = MemoryAuthStore()
        store.save("token-lama", "r1", null)
        server.enqueue(json("""{"error":{"code":"INVALID_CREDENTIALS","message":"Invalid email or password"}}""", 401))

        val ex = assertFailsWith<ClientResponseException> { sdk(store).auth.login("a@b.c", "salah") }

        assertEquals("INVALID_CREDENTIALS", ex.code)
        assertFalse(ex.isSessionExpired)
        assertEquals(1, server.requestCount, "login gagal tidak boleh memicu refresh")
    }

    @Test
    fun `authStore onChange memberi tahu saat login dan logout`() = runTest {
        val store = MemoryAuthStore()
        val seen = mutableListOf<String?>()
        store.onChange { _, user -> seen.add(user?.id) }
        server.enqueue(json("""{"accessToken":"a1","refreshToken":"r1","user":{"id":"u1","email":"a@b.c"}}"""))

        val bf = sdk(store)
        bf.auth.login("a@b.c", "rahasia")
        bf.auth.logout()

        assertEquals(listOf("u1", null), seen)
    }
}
