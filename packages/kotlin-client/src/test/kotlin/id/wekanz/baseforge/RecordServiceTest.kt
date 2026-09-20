package id.wekanz.baseforge

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Bentuk request/response tiap operasi Records. */
class RecordServiceTest {
    private lateinit var server: MockWebServer

    private fun json(body: String, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun sdk(store: AuthStore = MemoryAuthStore()) =
        BaseForge(server.url("/").toString(), "proj1", store)

    private fun loggedInSdk(): BaseForge {
        val store = MemoryAuthStore()
        store.save("tok", "r1", id.wekanz.baseforge.auth.AuthUser(id = "u1", email = "a@b.c"))
        return sdk(store)
    }

    @BeforeTest fun setUp() { server = MockWebServer(); server.start() }
    @AfterTest fun tearDown() { server.shutdown() }

    @Test
    fun `getList mengirim filter dan mem-parse item jadi RecordModel`() = runTest {
        server.enqueue(json("""{"page":1,"perPage":1,"totalItems":1,"totalPages":1,"items":[{"id":"r1","created":"2026-01-01","userId":"u1","quadkeys":"[\"a\",\"b\"]","total_cells":2}]}"""))

        val res = loggedInSdk().collection("explore_fog")
            .getList(1, 1, id.wekanz.baseforge.records.ListOptions(filter = "userId = \"u1\""))

        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertTrue(req.path!!.startsWith("/api/p/proj1/collections/explore_fog/records"))
        assertTrue(req.path!!.contains("filter=userId%20%3D%20%22u1%22") || req.path!!.contains("filter=userId"), "path: ${req.path}")
        assertEquals("Bearer tok", req.getHeader("Authorization"))

        assertEquals(1, res.totalItems)
        assertEquals("r1", res.items[0].id)
        assertEquals("u1", res.items[0].getString("userId"))
        assertEquals(2L, res.items[0].getLong("total_cells"))
    }

    @Test
    fun `getFirstListItem melempar 404 bila kosong`() = runTest {
        server.enqueue(json("""{"page":1,"perPage":1,"totalItems":0,"totalPages":0,"items":[]}"""))

        val ex = assertFailsWith<ClientResponseException> {
            loggedInSdk().collection("c").getFirstListItem("x = 1")
        }
        assertEquals(404, ex.status)
        assertEquals("NOT_FOUND", ex.code)
    }

    @Test
    fun `getOne mengambil dari envelope record`() = runTest {
        server.enqueue(json("""{"record":{"id":"r9","created":"2026-01-01","userId":"u1","note":"halo"}}"""))

        val rec = loggedInSdk().collection("c").getOne("r9")

        assertEquals("/api/p/proj1/collections/c/records/r9", server.takeRequest().path)
        assertEquals("r9", rec.id)
        assertEquals("halo", rec.getString("note"))
    }

    @Test
    fun `create mengirim JSON dan mengembalikan record`() = runTest {
        server.enqueue(json("""{"record":{"id":"new1","created":"2026-01-01","userId":"u1","total_cells":3}}""", 201))

        val rec = loggedInSdk().collection("c").create(buildJsonObject {
            put("userId", JsonPrimitive("u1"))
            put("total_cells", JsonPrimitive(3))
        })

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("new1", rec.id)
        assertEquals(3L, rec.getLong("total_cells"))
    }

    @Test
    fun `createWithId menyisipkan id ke payload`() = runTest {
        server.enqueue(json("""{"record":{"id":"custom-id-1","created":"2026-01-01"}}""", 201))

        loggedInSdk().collection("c").createWithId("custom-id-1", buildJsonObject {
            put("userId", JsonPrimitive("u1"))
        })

        val sent = server.takeRequest().body.readUtf8()
        assertTrue(sent.contains("\"id\":\"custom-id-1\""), "body: $sent")
    }

    @Test
    fun `update memakai PATCH ke path id`() = runTest {
        server.enqueue(json("""{"record":{"id":"r9","updated":"2026-01-02","total_cells":5}}"""))

        val rec = loggedInSdk().collection("c").update("r9", buildJsonObject {
            put("total_cells", JsonPrimitive(5))
        })

        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/api/p/proj1/collections/c/records/r9", req.path)
        assertEquals(5L, rec.getLong("total_cells"))
    }

    @Test
    fun `delete memakai DELETE dan true`() = runTest {
        server.enqueue(json("", 204))

        val ok = loggedInSdk().collection("c").delete("r9")

        assertEquals("DELETE", server.takeRequest().method)
        assertTrue(ok)
    }

    @Test
    fun `401 pada records memicu auto-refresh M37`() = runTest {
        // Records adalah endpoint terautentikasi → 401 harus auto-refresh + retry,
        // BUKAN langsung SESSION_EXPIRED.
        val store = MemoryAuthStore()
        store.save("basi", "r1", id.wekanz.baseforge.auth.AuthUser(id = "u1", email = "a@b.c"))
        server.enqueue(json("{}", 401))                                              // getList awal
        server.enqueue(json("""{"accessToken":"segar","refreshToken":"r2","user":{"id":"u1","email":"a@b.c"}}""")) // refresh
        server.enqueue(json("""{"page":1,"perPage":1,"totalItems":0,"totalPages":0,"items":[]}""")) // retry

        val res = sdk(store).collection("c").getList(1, 1)

        assertEquals(0, res.totalItems)
        assertEquals("segar", store.token)
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `kolom tak dikenal di record tidak crash`() = runTest {
        // Server boleh menambah kolom sistem/kustom kapan saja.
        server.enqueue(json("""{"record":{"id":"r1","created":"x","kolomMasaDepan":{"nested":[1,2]},"_system":true}}"""))

        val rec = loggedInSdk().collection("c").getOne("r1")
        assertEquals("r1", rec.id)
        assertTrue(rec.has("kolomMasaDepan"))
    }
}
