package id.wekanz.baseforge.records

import id.wekanz.baseforge.ClientResponseException
import id.wekanz.baseforge.internal.BaseForgeJson
import id.wekanz.baseforge.internal.HttpCore
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Operasi CRUD untuk satu koleksi — paritas dengan `recordService.ts` di SDK TS.
 *
 * Didapat lewat [id.wekanz.baseforge.BaseForge.collection], jangan di-new langsung.
 */
public class RecordService internal constructor(
    private val http: HttpCore,
    private val projectId: String,
    public val collectionName: String,
) {
    private val basePath: String get() = "api/p/$projectId/collections/$collectionName/records"

    /** Ambil daftar record dengan pagination/sort/filter/search/expand. */
    public suspend fun getList(
        page: Int = 1,
        perPage: Int = 20,
        options: ListOptions = ListOptions(),
    ): RecordList {
        val query = mapOf(
            "page" to page.toString(),
            "perPage" to perPage.toString(),
            "sort" to options.sort,
            "filter" to options.filter,
            "search" to options.search,
            "expand" to options.expand,
        )
        val text = http.request("GET", basePath, query = query) ?: "{}"
        val raw = BaseForgeJson.decodeFromString(ListResultRaw.serializer(), text)
        return RecordList(
            page = raw.page,
            perPage = raw.perPage,
            totalItems = raw.totalItems,
            totalPages = raw.totalPages,
            items = raw.items.map { jsonToRecord(it) },
        )
    }

    /**
     * Ambil record pertama yang cocok dengan [filter].
     * Melempar `404 NOT_FOUND` bila tidak ada — paritas `getFirstListItem` di SDK TS.
     */
    public suspend fun getFirstListItem(filter: String, expand: String? = null): RecordModel {
        val res = getList(1, 1, ListOptions(filter = filter, expand = expand))
        return res.items.firstOrNull()
            ?: throw ClientResponseException(404, "No record found matching filter: \"$filter\"", "NOT_FOUND")
    }

    /** Ambil satu record by id. 404 bila tidak ada. */
    public suspend fun getOne(id: String, expand: String? = null): RecordModel {
        val text = http.request("GET", "$basePath/$id", query = mapOf("expand" to expand))
            ?: error("empty getOne response")
        val env = BaseForgeJson.decodeFromString(RecordEnvelope.serializer(), text)
        return jsonToRecord(env.record)
    }

    /**
     * Buat record baru. Bila [data] punya `id`, server memakainya sebagai document ID
     * (untuk migrasi dengan existing IDs; duplikat → 409 DOCUMENT_ID_TAKEN).
     */
    public suspend fun create(data: JsonObject): RecordModel {
        val text = http.request("POST", basePath, body = data.toString()) ?: error("empty create response")
        val env = BaseForgeJson.decodeFromString(RecordEnvelope.serializer(), text)
        return jsonToRecord(env.record)
    }

    /** Buat record dengan custom document ID (M34). */
    public suspend fun createWithId(id: String, data: JsonObject): RecordModel {
        val merged = buildJsonObject {
            data.forEach { (k, v) -> put(k, v) }
            put("id", JsonPrimitive(id))
        }
        return create(merged)
    }

    /** Ubah record yang sudah ada. */
    public suspend fun update(id: String, data: JsonObject): RecordModel {
        val text = http.request("PATCH", "$basePath/$id", body = data.toString())
            ?: error("empty update response")
        val env = BaseForgeJson.decodeFromString(RecordEnvelope.serializer(), text)
        return jsonToRecord(env.record)
    }

    /** Hapus record. */
    public suspend fun delete(id: String): Boolean {
        http.request("DELETE", "$basePath/$id")
        return true
    }
}
