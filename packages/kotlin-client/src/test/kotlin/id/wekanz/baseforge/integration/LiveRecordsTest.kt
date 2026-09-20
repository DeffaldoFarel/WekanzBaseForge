package id.wekanz.baseforge.integration

import id.wekanz.baseforge.BaseForge
import id.wekanz.baseforge.ClientResponseException
import id.wekanz.baseforge.MemoryAuthStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Integrasi Records ke server BaseForge NYATA — meniru persis operasi yang
 * dilakukan SyncRepository ExploreMaps (baca 1 record fog by userId, tulis
 * create/patch, hapus). Membutuhkan koleksi `explore_fog`-seperti di project.
 *
 * Env: BASEFORGE_TEST_URL, BASEFORGE_TEST_PROJECT, dan koleksi
 * BASEFORGE_TEST_COLLECTION (default "m69_records_probe") yang dibuat test.
 */
class LiveRecordsTest {
    private val baseUrl = System.getenv("BASEFORGE_TEST_URL")?.takeIf { it.isNotBlank() }
    private val projectId = System.getenv("BASEFORGE_TEST_PROJECT")?.takeIf { it.isNotBlank() }
    private val adminToken = System.getenv("BASEFORGE_TEST_ADMIN_TOKEN")?.takeIf { it.isNotBlank() }
    private val collection = System.getenv("BASEFORGE_TEST_COLLECTION")?.takeIf { it.isNotBlank() }
        ?: "m69_records_probe"

    private fun ready(): Boolean {
        if (baseUrl == null || projectId == null || adminToken == null) {
            println("SKIP LiveRecordsTest — set BASEFORGE_TEST_URL/PROJECT/ADMIN_TOKEN")
            return false
        }
        return true
    }

    /** Pastikan koleksi probe ada dengan rules owner-based (idempotent). */
    private fun ensureCollection() {
        val owner = "@request.auth.id != \"\" && userId = @request.auth.id"
        val fields = """[
            |{"name":"userId","type":"text","required":true},
            |{"name":"quadkeys","type":"json"},
            |{"name":"total_cells","type":"number"},
            |{"name":"last_sync","type":"number"},
            |{"name":"settings","type":"json"}
            |]""".trimMargin().replace("\n", "")
        val rules = """"listRule":"$owner","viewRule":"$owner",
            |"createRule":"@request.auth.id != \"\"",
            |"updateRule":"$owner","deleteRule":"$owner"""".trimMargin().replace("\n", "")

        // Coba buat; bila sudah ada (400/409), PATCH untuk memastikan rules terbaru.
        val client = java.net.http.HttpClient.newHttpClient()
        fun send(method: String, url: String, body: String): Int {
            val req = java.net.http.HttpRequest.newBuilder()
                .uri(java.net.URI.create(url))
                .header("Authorization", "Bearer $adminToken")
                .header("Content-Type", "application/json")
                .method(method, java.net.http.HttpRequest.BodyPublishers.ofString(body))
                .build()
            return client.send(req, java.net.http.HttpResponse.BodyHandlers.ofString()).statusCode()
        }
        val createBody = """{"name":"$collection","type":"base","fields":$fields}"""
        var st = send("POST", "$baseUrl/api/admin/projects/$projectId/collections", createBody)
        // Rules punya ENDPOINT TERPISAH (/rules) — PATCH ke koleksi utama mengabaikannya.
        val rulesSt = send("PATCH", "$baseUrl/api/admin/projects/$projectId/collections/$collection/rules",
            """{$rules}""")
        println("ensureCollection: create=$st rules=$rulesSt")
    }

    @Test
    fun `siklus records meniru SyncRepository`() = runBlocking {
        if (!ready()) return@runBlocking
        ensureCollection()

        val store = MemoryAuthStore()
        val bf = BaseForge(baseUrl!!, projectId!!, store)

        // login sebagai user probe
        val email = "m69-records-${System.currentTimeMillis()}@test.local"
        bf.auth.register(email, "ProbeRec123!", "Records Probe")
        val uid = store.user!!.id
        val fog = bf.collection(collection)

        // 1. Baca record yang belum ada → 404 (persis perilaku SyncRepository saat first sync)
        val notFound = assertFailsWith<ClientResponseException> {
            fog.getFirstListItem("userId = \"$uid\"")
        }
        assertEquals(404, notFound.status)

        // 2. CREATE (first sync — recordId null → POST)
        val created = fog.create(buildJsonObject {
            put("userId", JsonPrimitive(uid))
            put("quadkeys", JsonPrimitive("[\"abc\",\"def\"]"))
            put("total_cells", JsonPrimitive(2))
            put("last_sync", JsonPrimitive(1000))
            put("settings", buildJsonObject { put("theme", JsonPrimitive("dark")) })
        })
        assertEquals(uid, created.getString("userId"))
        assertEquals(2L, created.getLong("total_cells"))

        // 3. READ kembali (sync berikutnya — recordId ditemukan)
        val fetched = fog.getFirstListItem("userId = \"$uid\"")
        assertEquals(created.id, fetched.id)
        assertEquals("[\"abc\",\"def\"]", fetched.getString("quadkeys"))

        // 4. UPDATE (merge — recordId ada → PATCH)
        val updated = fog.update(fetched.id, buildJsonObject {
            put("total_cells", JsonPrimitive(5))
            put("last_sync", JsonPrimitive(2000))
        })
        assertEquals(5L, updated.getLong("total_cells"))

        // 5. getOne by id
        val one = fog.getOne(fetched.id)
        assertEquals(5L, one.getLong("total_cells"))

        // 6. DELETE (reset cloud)
        assertTrue(fog.delete(fetched.id))
        assertFailsWith<ClientResponseException> { fog.getOne(fetched.id) }

        bf.auth.logout()
    }
}
