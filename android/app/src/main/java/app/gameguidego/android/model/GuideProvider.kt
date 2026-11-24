package app.gameguidego.android.model

import android.net.Uri
import android.webkit.CookieManager

enum class GuideProvider(
    val displayName: String,
    val baseUrl: String
) {
    GAMEFAQS("GameFAQs", "https://gamefaqs.gamespot.com"),
    NEOSEEKER("Neoseeker", "https://www.neoseeker.com"),
    ZELDA_DUNGEON("ZeldaDungeon", "https://www.zeldadungeon.net"),
    VGMAPS("VGMaps", "https://www.vgmaps.com/Atlas/index.htm"),
    CUSTOM_URL("URL", "https://");

    fun buildSearchUrl(query: String): String {
        val trimmed = query.trim()
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            return trimmed
        }
        val encoded = Uri.encode(trimmed)
        return when (this) {
            GAMEFAQS -> "https://gamefaqs.gamespot.com/search?game=$encoded"
            NEOSEEKER -> "https://www.neoseeker.com/seeker.php?q=$encoded"
            ZELDA_DUNGEON -> {
                if (trimmed.isEmpty()) "https://www.zeldadungeon.net"
                else "https://www.zeldadungeon.net/?s=$encoded"
            }
            VGMAPS -> "https://www.vgmaps.com/Atlas/index.htm"
            CUSTOM_URL -> if (trimmed.isEmpty()) "https://gamefaqs.gamespot.com" else "https://$trimmed"
        }
    }

    companion object {
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
