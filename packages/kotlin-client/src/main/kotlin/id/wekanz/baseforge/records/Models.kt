package id.wekanz.baseforge.records

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Satu baris record dari sebuah koleksi.
 *
 * Server BaseForge mengembalikan kolom sistem (`id`, `created`, `updated`) plus
 * kolom skema milik koleksi yang BEBAS — tidak ada skema tetap di sisi klien.
 * Karena itu [data] adalah `JsonObject` utuh, dan accessor [getString]/[getLong]/
 * [getBoolean] disediakan agar klien tidak bergulat dengan `JsonElement`.
 *
 * Pendekatan ini (bukan data class per-koleksi) disengaja: skema koleksi bisa
 * berubah dari dashboard kapan saja, dan `ignoreUnknownKeys` membuat klien lama
 * tetap jalan saat kolom baru ditambahkan.
 */
public class RecordModel(
    public val id: String,
    public val created: String?,
    public val updated: String?,
    /** Seluruh payload JSON record, termasuk `id`/`created`/`updated` di dalamnya. */
    public val data: JsonObject,
) {
    public fun getString(key: String): String? =
        (data[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    public fun getLong(key: String): Long? =
        data[key]?.jsonPrimitive?.longOrNull

    public fun getBoolean(key: String): Boolean? =
        data[key]?.jsonPrimitive?.content?.let {
            when (it) { "true" -> true; "false" -> false; else -> null }
        }

    /** True bila kolom ada dan bukan JSON null. */
    public fun has(key: String): Boolean =
        data.containsKey(key) && data[key] !is JsonNull

    override fun toString(): String = "RecordModel(id=$id, keys=${data.keys})"
}

internal fun jsonToRecord(obj: JsonObject): RecordModel = RecordModel(
    id = obj["id"]?.jsonPrimitive?.content.orEmpty(),
    created = obj["created"]?.jsonPrimitive?.content,
    updated = obj["updated"]?.jsonPrimitive?.content,
    data = obj,
)

/**
 * Hasil `getList` — halaman + item yang sudah diparse jadi [RecordModel].
 * Angka pagination identik dengan SDK TypeScript.
 */
public data class RecordList(
    val page: Int,
    val perPage: Int,
    val totalItems: Int,
    val totalPages: Int,
    val items: List<RecordModel>,
)

@Serializable
internal data class ListResultRaw(
    val page: Int = 1,
    val perPage: Int = 20,
    val totalItems: Int = 0,
    val totalPages: Int = 0,
    val items: List<JsonObject> = emptyList(),
)

@Serializable
internal data class RecordEnvelope(val record: JsonObject)

/** Opsi query untuk [RecordService.getList]. */
public data class ListOptions(
    val sort: String? = null,
    val filter: String? = null,
    val search: String? = null,
    val expand: String? = null,
)
