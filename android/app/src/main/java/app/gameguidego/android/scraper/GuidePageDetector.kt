package app.gameguidego.android.scraper

import android.webkit.WebView
import app.gameguidego.android.model.GuideProvider
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import kotlin.coroutines.resume

enum class DetectedGuideKind(val label: String) {
    BROWSING("Browsing"),
    GAMEFAQS_TXT("GameFAQs TXT"),
    GAMEFAQS_HTML("GameFAQs HTML"),
    NEOSEEKER_TXT("Neoseeker TXT"),
    NEOSEEKER_HTML("Neoseeker HTML"),
    IGN_WIKI_HTML("IGN Wiki"),
    ZELDA_DUNGEON_HTML("Zelda Dungeon"),
    PDF_DOCUMENT("PDF Document"),
    WEB_ARTICLE("Web Guide")
}

data class PageDetectionResult(
    val url: String,
    val title: String,
    val kind: DetectedGuideKind,
    val canDownload: Boolean,
    val tocPageCount: Int = 1,
    val summaryLabel: String = ""
)

object GuidePageDetector {
    const val IGN_COLLECT_LINKS_FN = """
        function collectIgnWikiLinks(slug) {
            if (!slug) return [];
            var prefix = '/wikis/' + slug + '/';
            var excluded = ['/checklists', '/map', '/interactive-map', '/how-to-wiki', 'special:', 'file:', 'category:', 'user:', '/edit', '/history', '/talk'];
            var seen = new Set();
            var out = [];
            var selectors = ['.wiki-html a[href]', '.wiki-toc a[href]'];
            for (var s = 0; s < selectors.length; s++) {
                var links = Array.from(document.querySelectorAll(selectors[s]));
                for (var i = 0; i < links.length; i++) {
                    var a = links[i];
                    var href = a.href || '';
                    if (!href || href.indexOf('?') !== -1) continue;
                    var parsed;
                    try { parsed = new URL(href); } catch (e) { continue; }
                    var h = parsed.hostname.toLowerCase();
                    if (h !== 'ign.com' && !h.endsWith('.ign.com')) continue;
                    var cleanPath = parsed.pathname.replace(/\/+$/, '');
                    var lowerPath = cleanPath.toLowerCase();
                    if (!lowerPath.startsWith(prefix) || lowerPath.length <= prefix.length) continue;
                    var isExcluded = excluded.some(function(ex) { return lowerPath.indexOf(ex) !== -1; });
                    if (isExcluded) continue;
                    var canonical = parsed.origin + cleanPath;
                    if (!seen.has(canonical)) {
                        seen.add(canonical);
                        out.push({ title: (a.innerText || a.getAttribute('title') || '').trim(), href: canonical });
                    }
                }
            }
            return out;
        }
    """

    private fun buildDetectScript(providerId: String): String = """
        (function() {
            $IGN_COLLECT_LINKS_FN
            var providerId = ${JSONObject.quote(providerId)};
            var url = window.location.href || '';
            var pathname = window.location.pathname || '';
            var search = window.location.search || '';
            var host = (window.location.hostname || '').toLowerCase();
            var titleEl = document.querySelector('h1.wiki-page-heading, h1.page-title, h1, h2.title, .page-title');
            var title = ((titleEl && titleEl.innerText) ? titleEl.innerText : (document.title || '')).trim();
            title = title.replace(/\s*-\s*(GameFAQs|Neoseeker|Zelda Dungeon|IGN).*$/i, '').trim();

            function countUniqueLinks(selector) {
                var links = Array.from(document.querySelectorAll(selector));
                var seen = new Set();
                for (var i = 0; i < links.length; i++) {
                    var a = links[i];
                    var rawHref = a.getAttribute('href') || '';
                    var onclick = a.getAttribute('onclick') || '';
                    if (!rawHref.trim() || rawHref.trim().startsWith('#')) continue;
                    if (onclick && (onclick.indexOf('show()') !== -1 || onclick.indexOf('hide()') !== -1)) continue;
                    var cleanHref = (a.href || '').split('#')[0];
                    if (cleanHref && cleanHref.startsWith('http')) {
                        seen.add(cleanHref);
                    }
                }
                return seen.size;
            }

            var hasGameFaqsTxt = document.getElementById('faqtext') !== null;
            var hasGameFaqsToc = document.querySelector('.ftoc') !== null;
            var gameFaqsTocCount = hasGameFaqsToc ? countUniqueLinks('.ftoc a[href]') : 0;

            var neoTxtPre = document.querySelector('#faqtxt.text_only pre');
            var hasNeoTxt = neoTxtPre !== null && (neoTxtPre.innerText || neoTxtPre.textContent || '').trim().length > 0;
            var hasNeoWikiContent = document.querySelector('article#wiki-content') !== null;
            var hasNeoWikiToc = document.querySelector('div.wiki-toc.section-spaced, div.wiki-toc') !== null;
            var isNeoFaqSubpage = pathname.indexOf('/faqs/') !== -1 && !/\/faqs\/?$/i.test(pathname);
            var hasNeoHtml = hasNeoWikiContent && (hasNeoWikiToc || isNeoFaqSubpage);
            var neoTocCount = hasNeoWikiToc ? countUniqueLinks('div.wiki-toc a[href]') : 0;

            var isIgnHost = host === 'ign.com' || host.endsWith('.ign.com');
            var ignSlugMatch = pathname.match(/^\/wikis\/([^\/]+)/i);
            var ignSlug = ignSlugMatch ? ignSlugMatch[1].toLowerCase() : '';
            var hasIgnWikiDom = document.querySelector('.wiki-html, .wiki-page, .wiki-guide-content') !== null;
            var hasIgnWiki = isIgnHost && ignSlug.length > 0 && hasIgnWikiDom;
            var ignTocCount = hasIgnWiki ? collectIgnWikiLinks(ignSlug).length : 0;

            var isZdHost = host === 'zeldadungeon.net' || host.endsWith('.zeldadungeon.net');
            var isZdSearchOrHome = pathname === '/' || search.indexOf('?s=') !== -1 || search.indexOf('&s=') !== -1;
            var isZdPath = pathname.toLowerCase().indexOf('walkthrough') !== -1 || pathname.toLowerCase().indexOf('/wiki/') !== -1;
            var zdRoot = document.querySelector('article .entry-content, #mw-content-text .mw-parser-output, .entry-content, .post-content');
            var zdTextLen = zdRoot ? (zdRoot.innerText || '').trim().length : 0;
            var hasZd = isZdHost && !isZdSearchOrHome && isZdPath && zdTextLen >= 500;
            var zdTocCount = hasZd ? countUniqueLinks('.entry-content a[href*="walkthrough"], #mw-content-text a[href*="/wiki/"]') : 0;

            var isSearchEngine = host.indexOf('duckduckgo.com') !== -1 ||
                host.indexOf('google.') !== -1 ||
                host.indexOf('bing.com') !== -1 ||
                host.indexOf('search.yahoo.') !== -1;
            var webRoot = document.querySelector('article, main, .mw-parser-output, .entry-content, #faqtext, pre');
            var webTextLen = webRoot ? (webRoot.innerText || '').trim().length : 0;
            var lowerUrl = url.toLowerCase().split('?')[0].split('#')[0];
            var isPdf = lowerUrl.endsWith('.pdf');
            var isTxt = lowerUrl.endsWith('.txt');

            return JSON.stringify({
                providerId: providerId,
                url: url,
                title: title,
                hasGameFaqsTxt: hasGameFaqsTxt,
                hasGameFaqsToc: hasGameFaqsToc,
                gameFaqsTocCount: gameFaqsTocCount,
                hasNeoTxt: hasNeoTxt,
                hasNeoHtml: hasNeoHtml,
                neoTocCount: neoTocCount,
                hasIgnWiki: hasIgnWiki,
                ignTocCount: ignTocCount,
                hasZd: hasZd,
                zdTocCount: zdTocCount,
                isSearchEngine: isSearchEngine,
                webTextLen: webTextLen,
                isPdf: isPdf,
                isTxt: isTxt
            });
        })();
    """.trimIndent()

    suspend fun detect(webView: WebView, provider: GuideProvider): PageDetectionResult? {
        val raw = evaluateJs(webView, buildDetectScript(provider.id)) ?: return null
        val json = runCatching { JSONObject(unquoteJsonString(raw)) }.getOrNull() ?: return null
        val url = json.optString("url")
        if (url.isBlank() || url == "about:blank") return null

        val title = json.optString("title").ifBlank { "Untitled Guide" }
        val isPdf = json.optBoolean("isPdf")
        val isTxt = json.optBoolean("isTxt")

        if (isPdf) {
            return PageDetectionResult(
                url = url,
                title = title,
                kind = DetectedGuideKind.PDF_DOCUMENT,
                canDownload = true,
                tocPageCount = 1,
                summaryLabel = DetectedGuideKind.PDF_DOCUMENT.label
            )
        }

        return when (provider) {
            GuideProvider.GAMEFAQS -> when {
                json.optBoolean("hasGameFaqsTxt") -> PageDetectionResult(
                    url = url,
                    title = title,
                    kind = DetectedGuideKind.GAMEFAQS_TXT,
                    canDownload = true,
                    tocPageCount = 1,
                    summaryLabel = "GameFAQs TXT"
                )
                json.optBoolean("hasGameFaqsToc") -> {
                    val count = json.optInt("gameFaqsTocCount", 1).coerceAtLeast(1)
                    val pagesLabel = if (count > 1) " · $count pages" else ""
                    PageDetectionResult(
                        url = url,
                        title = title,
                        kind = DetectedGuideKind.GAMEFAQS_HTML,
                        canDownload = true,
                        tocPageCount = count,
                        summaryLabel = "GameFAQs HTML$pagesLabel"
                    )
                }
                else -> browsingResult(url, title)
            }

            GuideProvider.NEOSEEKER -> when {
                json.optBoolean("hasNeoTxt") -> PageDetectionResult(
                    url = url,
                    title = title,
                    kind = DetectedGuideKind.NEOSEEKER_TXT,
                    canDownload = true,
                    tocPageCount = 1,
                    summaryLabel = "Neoseeker TXT"
                )
                json.optBoolean("hasNeoHtml") -> {
                    val count = json.optInt("neoTocCount", 1).coerceAtLeast(1)
                    val pagesLabel = if (count > 1) " · $count pages" else ""
                    PageDetectionResult(
                        url = url,
                        title = title,
                        kind = DetectedGuideKind.NEOSEEKER_HTML,
                        canDownload = true,
                        tocPageCount = count,
                        summaryLabel = "Neoseeker HTML$pagesLabel"
                    )
                }
                else -> browsingResult(url, title)
            }

            GuideProvider.IGN -> if (json.optBoolean("hasIgnWiki")) {
                ignWikiResult(url, title, json)
            } else {
                browsingResult(url, title)
            }

            GuideProvider.ZELDA_DUNGEON -> if (json.optBoolean("hasZd")) {
                val count = json.optInt("zdTocCount", 1).coerceAtLeast(1)
                val pagesLabel = if (count > 1) " · $count sections" else ""
                PageDetectionResult(
                    url = url,
                    title = title,
                    kind = DetectedGuideKind.ZELDA_DUNGEON_HTML,
                    canDownload = true,
                    tocPageCount = count,
                    summaryLabel = "Zelda Dungeon$pagesLabel"
                )
            } else {
                browsingResult(url, title)
            }

            GuideProvider.WEB -> when {
                json.optBoolean("hasIgnWiki") -> ignWikiResult(url, title, json)
                isTxt -> PageDetectionResult(
                    url = url,
                    title = title,
                    kind = DetectedGuideKind.WEB_ARTICLE,
                    canDownload = true,
                    tocPageCount = 1,
                    summaryLabel = "TXT Guide"
                )
                !json.optBoolean("isSearchEngine") && json.optInt("webTextLen", 0) >= 600 -> PageDetectionResult(
                    url = url,
                    title = title,
                    kind = DetectedGuideKind.WEB_ARTICLE,
                    canDownload = true,
                    tocPageCount = 1,
                    summaryLabel = "Web Article"
                )
                else -> browsingResult(url, title)
            }
        }
    }

    private fun ignWikiResult(url: String, title: String, json: JSONObject): PageDetectionResult {
        val count = json.optInt("ignTocCount", 1).coerceAtLeast(1)
        val pagesLabel = if (count > 1) " · $count pages" else ""
        return PageDetectionResult(
            url = url,
            title = title,
            kind = DetectedGuideKind.IGN_WIKI_HTML,
            canDownload = true,
            tocPageCount = count,
            summaryLabel = "IGN Wiki$pagesLabel"
        )
    }

    private fun browsingResult(url: String, title: String) = PageDetectionResult(
        url = url,
        title = title,
        kind = DetectedGuideKind.BROWSING,
        canDownload = false,
        tocPageCount = 0,
        summaryLabel = ""
    )

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
