package app.gameguidego.android.scraper

import android.webkit.WebView
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import kotlin.coroutines.resume

enum class DetectedGuideKind(val label: String) {
    GAMEFAQS_TXT("GameFAQs TXT Guide"),
    GAMEFAQS_HTML("GameFAQs HTML Guide (TOC)"),
    NEOSEEKER_TXT("Neoseeker TXT Guide"),
    NEOSEEKER_HTML("Neoseeker HTML Guide"),
    ZELDA_DUNGEON_HTML("ZeldaDungeon Guide"),
    VGMAPS_PAGE("VGMaps Atlas"),
    PDF_DOCUMENT("PDF Document"),
    GENERIC_ARTICLE("Web Article / Guide")
}

data class PageDetectionResult(
    val url: String,
    val title: String,
    val kind: DetectedGuideKind,
    val isHighConfidenceGuide: Boolean
)

object GuidePageDetector {
    private val detectScript = """
        (function() {
            var url = window.location.href || '';
            var title = (document.querySelector('h1, h2.title, .page-title')?.innerText || document.title || '').trim();
            var hasGameFaqsTxt = document.getElementById('faqtext') !== null;
            var hasGameFaqsToc = document.querySelector('.ftoc') !== null;
            var hasNeoTxt = document.querySelector('#faqtxt.text_only pre') !== null || document.getElementById('faqtxt') !== null;
            var hasNeoHtml = url.indexOf('neoseeker.com') !== -1 && (url.indexOf('/faqs/') !== -1 || document.querySelector('.wiki-body, .faq_toc, #faq_content') !== null);
            var hasZd = url.indexOf('zeldadungeon.net') !== -1 && document.querySelector('article .entry-content, #mw-content-text .mw-parser-output, .entry-content') !== null;
            var isVgMaps = url.indexOf('vgmaps.com') !== -1;
            var isPdf = url.toLowerCase().endsWith('.pdf');
            return JSON.stringify({
                url: url,
                title: title,
                hasGameFaqsTxt: hasGameFaqsTxt,
                hasGameFaqsToc: hasGameFaqsToc,
                hasNeoTxt: hasNeoTxt,
                hasNeoHtml: hasNeoHtml,
                hasZd: hasZd,
                isVgMaps: isVgMaps,
                isPdf: isPdf
            });
        })();
    """.trimIndent()

    suspend fun detect(webView: WebView): PageDetectionResult? {
        val raw = evaluateJs(webView, detectScript) ?: return null
        val json = runCatching { JSONObject(unquoteJsonString(raw)) }.getOrNull() ?: return null
        val url = json.optString("url")
        if (url.isBlank() || url == "about:blank") return null

        val title = json.optString("title").ifBlank { "Untitled Guide" }
        val kind = when {
            json.optBoolean("isPdf") -> DetectedGuideKind.PDF_DOCUMENT
            json.optBoolean("hasGameFaqsTxt") -> DetectedGuideKind.GAMEFAQS_TXT
            json.optBoolean("hasGameFaqsToc") -> DetectedGuideKind.GAMEFAQS_HTML
            json.optBoolean("hasNeoTxt") -> DetectedGuideKind.NEOSEEKER_TXT
            json.optBoolean("hasNeoHtml") -> DetectedGuideKind.NEOSEEKER_HTML
            json.optBoolean("hasZd") -> DetectedGuideKind.ZELDA_DUNGEON_HTML
            json.optBoolean("isVgMaps") -> DetectedGuideKind.VGMAPS_PAGE
            else -> DetectedGuideKind.GENERIC_ARTICLE
        }
        val confident = kind != DetectedGuideKind.GENERIC_ARTICLE && kind != DetectedGuideKind.VGMAPS_PAGE
        return PageDetectionResult(url = url, title = title, kind = kind, isHighConfidenceGuide = confident)
    }

    suspend fun evaluateJs(webView: WebView, script: String): String? =
        suspendCancellableCoroutine { cont ->
            webView.evaluateJavascript(script) { value ->
                if (cont.isActive) cont.resume(value)
            }
        }

    fun unquoteJsonString(raw: String): String {
        if (raw == "null") return ""
        return runCatching {
            if (raw.startsWith("\"") && raw.endsWith("\"")) {
                JSONObject("{\"v\":$raw}").getString("v")
            } else {
                raw
            }
        }.getOrDefault(raw)
    }
}
