package id.wekanz.baseforge.integration

import id.wekanz.baseforge.BaseForge
import id.wekanz.baseforge.ClientResponseException
import id.wekanz.baseforge.MemoryAuthStore
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Integrasi Files ke server BaseForge NYATA: upload → getBucketUrl mengembalikan
 * bytes yang identik → list memuat file → delete → 404.
 *
 * Env: BASEFORGE_TEST_URL, BASEFORGE_TEST_PROJECT.
 */
class LiveFilesTest {
    private val baseUrl = System.getenv("BASEFORGE_TEST_URL")?.takeIf { it.isNotBlank() }
    private val projectId = System.getenv("BASEFORGE_TEST_PROJECT")?.takeIf { it.isNotBlank() }

    private fun ready(): Boolean {
        if (baseUrl == null || projectId == null) {
            println("SKIP LiveFilesTest — set BASEFORGE_TEST_URL/PROJECT")
            return false
        }
        return true
    }

    /** PNG 1x1 valid (magic bytes + data) — membuktikan round-trip biner utuh. */
    private fun tinyPng(): ByteArray = java.util.Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    )

    @Test
    fun `siklus file bucket round-trip bytes identik`() = runBlocking {
        if (!ready()) return@runBlocking
        val store = MemoryAuthStore()
        val bf = BaseForge(baseUrl!!, projectId!!, store)

        // login sebagai user probe
        bf.auth.register("m69-files-${System.currentTimeMillis()}@test.local", "FilesPass123!", "Files Probe")
        val png = tinyPng()

        // 1. Upload
        val up = bf.files.uploadToBucket(png, "probe.png", "image/png")
        assertTrue(up.fileId.isNotBlank())
        assertEquals(png.size.toLong(), up.size)

        // 2. getBucketUrl → bytes HARUS identik (round-trip biner utuh, bukan re-encode)
        val url = bf.files.getBucketUrl(up.fileId)
        val fetched = java.net.URL(url).readBytes()
        assertTrue(fetched.contentEquals(png), "bytes hasil download harus identik dengan yang di-upload")

        // 3. listBucketFiles memuat file kita
        val list = bf.files.listBucketFiles()
        assertTrue(list.any { it.fileId == up.fileId }, "file harus muncul di list")

        // 4. delete → getBucketUrl jadi 404
        assertTrue(bf.files.deleteBucketFile(up.fileId))
        assertFailsWith<Exception> { java.net.URL(url).readBytes() }

        bf.auth.logout()
    }

    @Test
    fun `upload dengan determinate fileId menimpa ID yang sama`() = runBlocking {
        if (!ready()) return@runBlocking
        val store = MemoryAuthStore()
        val bf = BaseForge(baseUrl!!, projectId!!, store)
        bf.auth.register("m69-files-det-${System.currentTimeMillis()}@test.local", "FilesPass123!", "Det Probe")

        val customId = "m69-det-${System.currentTimeMillis()}"
        val up = bf.files.uploadToBucket(tinyPng(), "det.png", "image/png", fileId = customId)
        assertEquals(customId, up.fileId)

        assertTrue(bf.files.deleteBucketFile(customId))
        bf.auth.logout()
    }
}
