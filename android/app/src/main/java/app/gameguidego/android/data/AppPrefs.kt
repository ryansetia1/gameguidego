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

    companion object {
        const val DEFAULT_SERVER_URL = "https://gameguidego.vercel.app"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_AUTH_TOKEN = "auth_token"
    }
}
