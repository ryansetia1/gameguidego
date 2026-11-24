package app.gameguidego.android.web

import android.net.Uri
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream

object AdBlockFilter {
    private val blockedHosts = setOf(
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "adservice.google.com",
        "google-analytics.com",
        "googletagmanager.com",
        "amazon-adsystem.com",
        "taboola.com",
        "outbrain.com",
        "pubmatic.com",
        "criteo.com",
        "criteo.net",
        "rubiconproject.com",
        "openx.net",
        "scorecardresearch.com",
        "quantserve.com",
        "moatads.com",
        "adnxs.com",
        "casalemedia.com",
        "adsrvr.org",
        "zemanta.com",
        "33across.com",
        "sharethrough.com",
        "media.net",
        "yieldmo.com",
        "lijit.com",
        "bidswitch.net",
        "revcontent.com",
        "mgid.com",
        "teads.tv",
        "smartadserver.com",
        "indexww.com",
        "facebook.net"
    )

    fun isBlocked(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        val host = runCatching { Uri.parse(url).host?.lowercase() }.getOrNull() ?: return false
        return blockedHosts.any { blocked ->
            host == blocked || host.endsWith(".$blocked")
        }
    }

    fun emptyResponse(): WebResourceResponse {
        return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
    }
}
