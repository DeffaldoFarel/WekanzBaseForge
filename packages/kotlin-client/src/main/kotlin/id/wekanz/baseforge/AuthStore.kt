package id.wekanz.baseforge

import id.wekanz.baseforge.auth.AuthUser
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Tempat SDK menyimpan token & user.
 *
 * SDK sengaja TIDAK bergantung pada AndroidX: aplikasi Android mengimplementasikan
 * interface ini di atas DataStore, aplikasi lain bisa memakai [MemoryAuthStore].
 *
 * **Kontrak yang harus dipenuhi implementasi:**
 * - [token] dan [refreshToken] dibaca ULANG pada setiap request; jangan cache di SDK.
 * - [save] dipanggil dari thread mana pun → implementasi harus aman untuk itu.
 * - [clear] dipanggil saat refresh gagal; setelahnya SDK melempar `SESSION_EXPIRED`.
 */
public interface AuthStore {
    public val token: String
    public val refreshToken: String
    public val user: AuthUser?

    /** Ada token DAN user — cukup untuk dianggap sesi hidup. */
    public val isValid: Boolean get() = token.isNotEmpty() && user != null

    public fun save(token: String, refreshToken: String, user: AuthUser?)
    public fun clear()

    /** Daftarkan pengamat perubahan; kembalikan fungsi untuk berhenti mengamati. */
    public fun onChange(listener: (token: String, user: AuthUser?) -> Unit): () -> Unit
}

/** Implementasi in-memory (default). Hilang saat proses mati — untuk test & server. */
public class MemoryAuthStore : AuthStore {
    @Volatile private var _token: String = ""
    @Volatile private var _refreshToken: String = ""
    @Volatile private var _user: AuthUser? = null
    private val listeners = CopyOnWriteArrayList<(String, AuthUser?) -> Unit>()

    override val token: String get() = _token
    override val refreshToken: String get() = _refreshToken
    override val user: AuthUser? get() = _user

    @Synchronized
    override fun save(token: String, refreshToken: String, user: AuthUser?) {
        _token = token
        _refreshToken = refreshToken
        _user = user
        notifyListeners()
    }

    @Synchronized
    override fun clear() {
        _token = ""
        _refreshToken = ""
        _user = null
        notifyListeners()
    }

    override fun onChange(listener: (String, AuthUser?) -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    private fun notifyListeners() {
        val t = _token
        val u = _user
        // Listener yang melempar tidak boleh menggagalkan penyimpanan sesi.
        listeners.forEach { runCatching { it(t, u) } }
    }
}
