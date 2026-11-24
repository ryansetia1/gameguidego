package app.gameguidego.android.data

import android.content.Context

class AppPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("gameguidego_prefs", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(value) {
            val cleaned = value.trim().trimEnd('/')
            prefs.edit().putString(KEY_SERVER_URL, cleaned.ifEmpty { DEFAULT_SERVER_URL }).apply()
        }

    var authToken: String
        get() = prefs.getString(KEY_AUTH_TOKEN, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_AUTH_TOKEN, value.trim()).apply()
        }

    var maxChapters: Int
        get() = prefs.getInt(KEY_MAX_CHAPTERS, DEFAULT_MAX_CHAPTERS).coerceIn(1, 100)
        set(value) {
            prefs.edit().putInt(KEY_MAX_CHAPTERS, value.coerceIn(1, 100)).apply()
        }

    companion object {
        const val DEFAULT_SERVER_URL = "https://gameguidego.vercel.app"
        const val DEFAULT_MAX_CHAPTERS = 10
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_MAX_CHAPTERS = "max_chapters"
    }
}
