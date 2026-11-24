package app.gameguidego.android.model

import android.net.Uri
import android.webkit.CookieManager

enum class GuideProvider(
    val id: String,
    val displayName: String
) {
    GAMEFAQS("gamefaqs", "GameFAQs"),
    NEOSEEKER("neoseeker", "Neoseeker"),
    ZELDA_DUNGEON("zelda_dungeon", "Zelda Dungeon"),
    WEB("web", "Browse Web");

    fun buildSearchUrl(gameName: String): String {
        val trimmed = gameName.trim()
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            return trimmed
        }
        return when (this) {
            GAMEFAQS -> {
                if (trimmed.isEmpty()) "https://gamefaqs.gamespot.com"
                else "https://gamefaqs.gamespot.com/search?game=${Uri.encode(trimmed)}"
            }
            NEOSEEKER -> {
                val cleaned = trimmed
                    .replace(Regex("[^\\p{L}\\p{N}\\s]"), " ")
                    .replace(Regex("\\s+"), " ")
                    .trim()
                if (cleaned.isEmpty()) "https://www.neoseeker.com"
                else "https://www.neoseeker.com/seeker.php?q=${Uri.encode(cleaned)}"
            }
            ZELDA_DUNGEON -> {
                if (trimmed.isEmpty()) "https://www.zeldadungeon.net"
                else "https://www.zeldadungeon.net/?s=${Uri.encode(trimmed)}"
            }
            WEB -> {
                if (trimmed.isEmpty()) "https://duckduckgo.com"
                else "https://duckduckgo.com/?q=${Uri.encode("$trimmed walkthrough guide")}"
            }
        }
    }

    companion object {
        fun fromId(id: String?): GuideProvider {
            return entries.firstOrNull { it.id == id } ?: GAMEFAQS
        }

        fun applyProviderCookies(provider: GuideProvider) {
            if (provider == NEOSEEKER) {
                val cm = CookieManager.getInstance()
                cm.setCookie(
                    "https://www.neoseeker.com/",
                    "mobile_mode=on; Domain=.neoseeker.com; Path=/; Secure; SameSite=None"
                )
                cm.flush()
            }
        }
    }
}
