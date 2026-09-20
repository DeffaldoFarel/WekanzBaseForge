package id.wekanz.baseforge.files

import id.wekanz.baseforge.internal.HttpCore
import id.wekanz.baseforge.internal.BaseForgeJson
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody

/** Hasil upload ke bucket — identik dengan `BucketUploadResult` di SDK TS. */
@Serializable
public data class BucketUploadResult(
    val fileId: String,
    val filename: String,
    val contentType: String,
    val size: Long,
    val url: String,
)

/** Satu entri dari [FilesService.listBucketFiles]. */
@Serializable
public data class BucketFileInfo(
    val fileId: String,
    val filename: String,
    val contentType: String,
    val size: Long,
    val uploadedAt: String,
    val uploadedBy: String? = null,
)

@Serializable
private data class ListBucketResponse(val files: List<BucketFileInfo> = emptyList())

@Serializable
private data class DeleteResponse(val ok: Boolean = false)

/**
 * Operasi file (bucket storage) — paritas dengan `filesService.ts` di SDK TS.
 *
 * Didapat lewat [id.wekanz.baseforge.BaseForge.files], jangan di-new langsung.
 *
 * Dua jenis URL berbeda yang penting dibedakan:
 * - [getUrl] — file yang ter-attach ke sebuah RECORD (field type file).
 * - [getBucketUrl] — file di BUCKET (decoupled dari record, punya fileId sendiri).
 *   Inilah yang dipakai dashboard untuk lampiran.
 */
public class FilesService internal constructor(
    private val http: HttpCore,
    private val baseUrl: String,
    private val projectId: String,
) {
    /**
     * URL untuk file yang ter-attach ke record (field type file).
     * Hanya MENYUSUN string — tidak melakukan request; klien (Coil/Glide) yang memuatnya.
     */
    public fun getUrl(
        collection: String,
        recordId: String,
        filename: String,
        thumb: String? = null,
    ): String {
        val base = baseUrl.trimEnd('/')
        var url = "$base/api/files/$projectId/$collection/$recordId/$filename"
        if (thumb != null) url += "?thumb=" + java.net.URLEncoder.encode(thumb, "UTF-8")
        return url
    }

    /** URL untuk bucket file (decoupled, ala Appwrite getFileView). */
    public fun getBucketUrl(fileId: String): String {
        val base = baseUrl.trimEnd('/')
        return "$base/api/files/$projectId/bucket/$fileId"
    }

    /**
     * Upload file ke bucket → return fileId + URL.
     *
     * [bytes] adalah isi file (mis. dari Bitmap.compress ke ByteArrayOutputStream di
     * Android). [fileId] opsional untuk determinate ID (migrasi dari Appwrite/Firebase).
     */
    public suspend fun uploadToBucket(
        bytes: ByteArray,
        filename: String,
        contentType: String = "application/octet-stream",
        fileId: String? = null,
    ): BucketUploadResult {
        val bodyBuilder = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", filename, bytes.toRequestBody(contentType.toMediaType()))
        if (fileId != null) bodyBuilder.addFormDataPart("fileId", fileId)

        val text = http.requestRaw(
            "POST",
            "api/p/$projectId/storage/upload",
            rawBody = bodyBuilder.build(),
        ) ?: error("empty upload response")
        return BaseForgeJson.decodeFromString(BucketUploadResult.serializer(), text)
    }

    /** Hapus file dari bucket. User biasa hanya bisa hapus file miliknya sendiri. */
    public suspend fun deleteBucketFile(fileId: String): Boolean {
        val text = http.request("DELETE", "api/p/$projectId/storage/bucket/$fileId") ?: return true
        return runCatching {
            BaseForgeJson.decodeFromString(DeleteResponse.serializer(), text).ok
        }.getOrDefault(true)
    }

    /** List bucket files milik user yang sedang login. */
    public suspend fun listBucketFiles(): List<BucketFileInfo> {
        val text = http.request("GET", "api/p/$projectId/storage/bucket") ?: "{}"
        return BaseForgeJson.decodeFromString(ListBucketResponse.serializer(), text).files
    }
}
