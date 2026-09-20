package id.wekanz.baseforge

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Bentuk request/response tiap operasi Files (bucket). */
class FilesServiceTest {
    private lateinit var server: MockWebServer

    private fun json(body: String, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun loggedInSdk(server: MockWebServer): BaseForge {
        val store = MemoryAuthStore()
        store.save("tok", "r1", id.wekanz.baseforge.auth.AuthUser(id = "u1", email = "a@b.c"))
        return BaseForge(server.url("/").toString(), "proj1", store)
    }

    @BeforeTest fun setUp() { server = MockWebServer(); server.start() }
    @AfterTest fun tearDown() { server.shutdown() }

    @Test
    fun `getUrl menyusun URL record-file dengan thumb`() {
        val bf = loggedInSdk(server)
        val url = bf.files.getUrl("explore_fog", "rec1", "foto.png", thumb = "100x100")
        assertTrue(url.startsWith(server.url("/").toString().removeSuffix("/") + "/api/files/proj1/explore_fog/rec1/foto.png"), "url: $url")
        assertTrue(url.contains("thumb=100x100"), "url: $url")
    }

    @Test
    fun `getBucketUrl menyusun URL bucket`() {
        val bf = loggedInSdk(server)
        val url = bf.files.getBucketUrl("abc123")
        assertEquals(server.url("/").toString().removeSuffix("/") + "/api/files/proj1/bucket/abc123", url)
    }

    @Test
    fun `uploadToBucket mengirim multipart dengan fileId opsional`() = runTest {
        server.enqueue(json("""{"fileId":"fid-1","filename":"foto.jpg","contentType":"image/jpeg","size":4,"url":"http://x"}""", 201))
        val bf = loggedInSdk(server)

        val res = bf.files.uploadToBucket(byteArrayOf(1, 2, 3, 4), "foto.jpg", "image/jpeg", fileId = "fid-1")

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertTrue(req.path!!.endsWith("/api/p/proj1/storage/upload"), "path: ${req.path}")
        assertTrue(req.getHeader("Content-Type")!!.startsWith("multipart/form-data"), "ct: ${req.getHeader("Content-Type")}")
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        val body = req.body.readUtf8()
        assertTrue(body.contains("name=\"fileId\""), "body harus mengandung fileId")
        assertTrue(body.contains("filename=\"foto.jpg\""), "body harus mengandung filename")
        assertEquals("fid-1", res.fileId)
        assertEquals(4L, res.size)
    }

    @Test
    fun `uploadToBucket tanpa fileId tidak mengirim field fileId`() = runTest {
        server.enqueue(json("""{"fileId":"auto-1","filename":"a.bin","contentType":"application/octet-stream","size":2,"url":"http://x"}""", 201))
        val bf = loggedInSdk(server)

        bf.files.uploadToBucket(byteArrayOf(9, 9), "a.bin")

        val body = server.takeRequest().body.readUtf8()
        assertTrue(!body.contains("name=\"fileId\""), "fileId tidak boleh dikirim bila null")
    }

    @Test
    fun `deleteBucketFile memakai DELETE ke path bucket`() = runTest {
        server.enqueue(json("""{"ok":true}"""))
        val bf = loggedInSdk(server)

        val ok = bf.files.deleteBucketFile("fid-9")

        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertTrue(req.path!!.endsWith("/api/p/proj1/storage/bucket/fid-9"), "path: ${req.path}")
        assertTrue(ok)
    }

    @Test
    fun `listBucketFiles mem-parse daftar file`() = runTest {
        server.enqueue(json("""{"files":[{"fileId":"f1","filename":"a.png","contentType":"image/png","size":10,"uploadedAt":"2026-01-01","uploadedBy":"u1"}]}"""))
        val bf = loggedInSdk(server)

        val files = bf.files.listBucketFiles()

        assertEquals("GET", server.takeRequest().method)
        assertEquals(1, files.size)
        assertEquals("f1", files[0].fileId)
        assertEquals("a.png", files[0].filename)
        assertEquals("u1", files[0].uploadedBy)
    }

    @Test
    fun `401 pada upload memicu auto-refresh M37`() = runTest {
        val store = MemoryAuthStore()
        store.save("basi", "r1", id.wekanz.baseforge.auth.AuthUser(id = "u1", email = "a@b.c"))
        server.enqueue(json("{}", 401))
        server.enqueue(json("""{"accessToken":"segar","refreshToken":"r2","user":{"id":"u1","email":"a@b.c"}}"""))
        server.enqueue(json("""{"fileId":"f1","filename":"a.png","contentType":"image/png","size":2,"url":"http://x"}""", 201))

        val bf = BaseForge(server.url("/").toString(), "proj1", store)
        val res = bf.files.uploadToBucket(byteArrayOf(1, 2), "a.png")

        assertEquals("f1", res.fileId)
        assertEquals("segar", store.token)
        assertEquals(3, server.requestCount)
    }
}
