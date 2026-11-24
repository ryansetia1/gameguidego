package app.gameguidego.android.scraper

import android.webkit.CookieManager
import android.webkit.WebView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import java.util.concurrent.TimeUnit

data class ExtractedGuide(
    val title: String,
    val extension: String,
    val textContent: String? = null,
    val binaryContent: ByteArray? = null,
    val pagesFetched: Int = 1,
    val totalTocLinks: Int = 1
)

class GuideExtractor {
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    suspend fun extractCurrentGuide(
        webView: WebView,
        detection: PageDetectionResult,
        maxPages: Int,
        onProgress: (done: Int, total: Int) -> Unit = { _, _ -> }
    ): ExtractedGuide {
        val userAgent = withContext(Dispatchers.Main) { webView.settings.userAgentString }
        return when (detection.kind) {
            DetectedGuideKind.GAMEFAQS_TXT -> extractGameFaqsTxt(webView, detection)
            DetectedGuideKind.NEOSEEKER_TXT -> extractNeoseekerTxt(webView, detection)
            DetectedGuideKind.GAMEFAQS_HTML -> extractMultiPageHtml(
                webView = webView,
                detection = detection,
                linkSelector = ".ftoc a[href]",
                userAgent = userAgent,
                maxPages = maxPages,
                onProgress = onProgress
            )
            DetectedGuideKind.NEOSEEKER_HTML -> extractMultiPageHtml(
                webView = webView,
                detection = detection,
                linkSelector = "div.wiki-toc a[href]",
                userAgent = userAgent,
                maxPages = maxPages,
                onProgress = onProgress
            )
            DetectedGuideKind.IGN_WIKI_HTML -> extractIgnWikiHtml(
                webView = webView,
                detection = detection,
                userAgent = userAgent,
                maxPages = maxPages,
                onProgress = onProgress
            )
            DetectedGuideKind.ZELDA_DUNGEON_HTML -> extractMultiPageHtml(
                webView = webView,
                detection = detection,
                linkSelector = ".entry-content a[href*='walkthrough'], #mw-content-text a[href*='/wiki/']",
                userAgent = userAgent,
                maxPages = maxPages,
                onProgress = onProgress
            )
            DetectedGuideKind.PDF_DOCUMENT -> downloadPdf(detection, userAgent)
            DetectedGuideKind.WEB_ARTICLE,
            DetectedGuideKind.BROWSING -> extractSingleHtmlAsMarkdown(webView, detection)
        }
    }

    private suspend fun extractGameFaqsTxt(
        webView: WebView,
        detection: PageDetectionResult
    ): ExtractedGuide {
        val raw = withContext(Dispatchers.Main) {
            GuidePageDetector.evaluateJs(
                webView,
                "(function(){ var el = document.getElementById('faqtext'); return el ? el.innerText : ''; })();"
            )
        } ?: ""
        val text = GuidePageDetector.unquoteJsonString(raw).trim()
        require(text.isNotEmpty()) { "Could not extract #faqtext content from GameFAQs." }
        return ExtractedGuide(
            title = detection.title,
            extension = "txt",
            textContent = "# ${detection.title}\nSource: ${detection.url}\n\n$text"
        )
    }

    private suspend fun extractNeoseekerTxt(
        webView: WebView,
        detection: PageDetectionResult
    ): ExtractedGuide {
        val raw = withContext(Dispatchers.Main) {
            GuidePageDetector.evaluateJs(
                webView,
                "(function(){ var el = document.querySelector('#faqtxt.text_only pre') || document.getElementById('faqtxt'); return el ? el.innerText : ''; })();"
            )
        } ?: ""
        val text = GuidePageDetector.unquoteJsonString(raw).replace("\r\n", "\n").trim()
        require(text.isNotEmpty()) { "Could not extract #faqtxt content from Neoseeker." }
        return ExtractedGuide(
            title = detection.title,
            extension = "txt",
            textContent = "# ${detection.title}\nSource: ${detection.url}\n\n$text"
        )
    }

    private suspend fun extractMultiPageHtml(
        webView: WebView,
        detection: PageDetectionResult,
        linkSelector: String,
        userAgent: String,
        maxPages: Int,
        onProgress: (done: Int, total: Int) -> Unit
    ): ExtractedGuide {
        if (maxPages <= 1) {
            onProgress(1, 1)
            return extractSingleHtmlAsMarkdown(webView, detection)
        }

        val selectorJson = JSONObject.quote(linkSelector)
        val tocJsonRaw = withContext(Dispatchers.Main) {
            GuidePageDetector.evaluateJs(
                webView,
                """
                (function() {
                    var links = Array.from(document.querySelectorAll($selectorJson));
                    var seen = new Set();
                    var out = [];
                    for (var i = 0; i < links.length; i++) {
                        var link = links[i];
                        var rawHref = link.getAttribute('href') || '';
                        var onclick = link.getAttribute('onclick') || '';
                        if (!rawHref.trim() || rawHref.trim().startsWith('#')) continue;
                        if (onclick && (onclick.indexOf('show()') !== -1 || onclick.indexOf('hide()') !== -1)) continue;
                        var href = (link.href || '').split('#')[0];
                        if (href && href.startsWith('http') && !seen.has(href)) {
                            seen.add(href);
                            out.push({ title: (link.innerText || '').trim(), href: href });
                        }
                    }
                    return JSON.stringify(out);
                })();
                """.trimIndent()
            )
        } ?: "[]"

        val tocArray = runCatching {
            JSONArray(GuidePageDetector.unquoteJsonString(tocJsonRaw))
        }.getOrElse { JSONArray() }

        return fetchTocPagesToMarkdown(
            webView = webView,
            detection = detection,
            tocArray = tocArray,
            userAgent = userAgent,
            maxPages = maxPages,
            onProgress = onProgress
        )
    }

    private suspend fun extractIgnWikiHtml(
        webView: WebView,
        detection: PageDetectionResult,
        userAgent: String,
        maxPages: Int,
        onProgress: (done: Int, total: Int) -> Unit
    ): ExtractedGuide {
        if (maxPages <= 1) {
            onProgress(1, 1)
            return extractSingleHtmlAsMarkdown(webView, detection)
        }

        val tocJsonRaw = withContext(Dispatchers.Main) {
            GuidePageDetector.evaluateJs(
                webView,
                """
                (function() {
                    ${GuidePageDetector.IGN_COLLECT_LINKS_FN}
                    var match = (window.location.pathname || '').match(/^\/wikis\/([^\/]+)/i);
                    var slug = match ? match[1].toLowerCase() : '';
                    return JSON.stringify(collectIgnWikiLinks(slug));
                })();
                """.trimIndent()
            )
        } ?: "[]"

        val tocArray = runCatching {
            JSONArray(GuidePageDetector.unquoteJsonString(tocJsonRaw))
        }.getOrElse { JSONArray() }

        return fetchTocPagesToMarkdown(
            webView = webView,
            detection = detection,
            tocArray = tocArray,
            userAgent = userAgent,
            maxPages = maxPages,
            onProgress = onProgress
        )
    }

    private suspend fun fetchTocPagesToMarkdown(
        webView: WebView,
        detection: PageDetectionResult,
        tocArray: JSONArray,
        userAgent: String,
        maxPages: Int,
        onProgress: (done: Int, total: Int) -> Unit
    ): ExtractedGuide {
        if (tocArray.length() <= 1) {
            onProgress(1, 1)
            return extractSingleHtmlAsMarkdown(webView, detection)
        }

        val totalLinks = tocArray.length()
        val limit = totalLinks.coerceAtMost(maxPages)
        val sb = StringBuilder()
        sb.append("# ").append(detection.title).append("\n")
        sb.append("Source: ").append(detection.url).append("\n")
        if (totalLinks > limit) {
            sb.append("> Note: Extracted $limit of $totalLinks pages.\n")
        }
        sb.append("\n")

        var fetched = 0
        withContext(Dispatchers.IO) {
            for (i in 0 until limit) {
                val item = tocArray.optJSONObject(i) ?: continue
                val chapterTitle = item.optString("title").ifBlank { "Page ${i + 1}" }
                val chapterUrl = item.optString("href")
                if (chapterUrl.isBlank()) continue

                withContext(Dispatchers.Main) { onProgress(i + 1, limit) }
                val html = fetchUrlWithCookies(chapterUrl, userAgent, detection.url) ?: continue
                val md = htmlToCleanMarkdown(Jsoup.parse(html, chapterUrl))
                if (md.isNotBlank()) {
                    sb.append("## ").append(chapterTitle).append("\n\n")
                    sb.append(md).append("\n\n---\n\n")
                    fetched++
                }
            }
        }

        if (fetched == 0) {
            return extractSingleHtmlAsMarkdown(webView, detection)
        }

        return ExtractedGuide(
            title = detection.title,
            extension = "md",
            textContent = sb.toString().trim(),
            pagesFetched = fetched,
            totalTocLinks = totalLinks
        )
    }

    private suspend fun extractSingleHtmlAsMarkdown(
        webView: WebView,
        detection: PageDetectionResult
    ): ExtractedGuide {
        val rawHtml = withContext(Dispatchers.Main) {
            GuidePageDetector.evaluateJs(
                webView,
                "(function(){ return document.documentElement ? document.documentElement.outerHTML : ''; })();"
            )
        } ?: ""
        val html = GuidePageDetector.unquoteJsonString(rawHtml)
        require(html.isNotBlank()) { "Current page HTML was empty." }

        val doc = Jsoup.parse(html, detection.url)
        val bodyMd = htmlToCleanMarkdown(doc)
        require(bodyMd.isNotBlank()) { "Could not extract readable text from this page." }

        val markdown = "# ${detection.title}\nSource: ${detection.url}\n\n$bodyMd"
        return ExtractedGuide(
            title = detection.title,
            extension = "md",
            textContent = markdown
        )
    }

    private suspend fun downloadPdf(
        detection: PageDetectionResult,
        userAgent: String
    ): ExtractedGuide = withContext(Dispatchers.IO) {
        val cookies = CookieManager.getInstance().getCookie(detection.url)
        val reqBuilder = Request.Builder()
            .url(detection.url)
            .header("User-Agent", userAgent)
        if (!cookies.isNullOrBlank()) reqBuilder.header("Cookie", cookies)

        client.newCall(reqBuilder.build()).execute().use { resp ->
            require(resp.isSuccessful) { "PDF download failed: HTTP ${resp.code}" }
            val bytes = resp.body?.bytes() ?: ByteArray(0)
            require(bytes.isNotEmpty()) { "Downloaded PDF was empty." }
            ExtractedGuide(
                title = detection.title,
                extension = "pdf",
                binaryContent = bytes
            )
        }
    }

    private fun fetchUrlWithCookies(url: String, userAgent: String, referer: String): String? {
        val cookies = CookieManager.getInstance().getCookie(url)
        val reqBuilder = Request.Builder()
            .url(url)
            .header("User-Agent", userAgent)
            .header("Referer", referer)
        if (!cookies.isNullOrBlank()) {
            reqBuilder.header("Cookie", cookies)
        }
        return runCatching {
            client.newCall(reqBuilder.build()).execute().use { resp ->
                if (!resp.isSuccessful) return null
                resp.body?.string()
            }
        }.getOrNull()
    }

    private fun htmlToCleanMarkdown(doc: Document): String {
        doc.select(
            "script, style, noscript, aside, nav, footer, header, iframe, form, " +
                ".comments-area, #comments, .comment-respond, a[href*=/nplus/][href*=adblock], .ftoc, " +
                ".wiki-comments, .wiki-sidebar, .wiki-toc, .wiki-paging-buttons, .wiki-page-tabs-nav-mobile, .byline, [data-cy='site-breadcrumb']"
        ).remove()

        val root: Element = doc.selectFirst(
            ".wiki-html, #faqwrap, .ffaq, article#wiki-content, article .entry-content, #mw-content-text .mw-parser-output, " +
                ".entry-content, .post-content, .wiki-body, main article, article, main"
        ) ?: doc.body() ?: return ""

        val lines = mutableListOf<String>()
        for (el in root.select("h1, h2, h3, h4, p, div[data-paragraph]:not(:has(p)), li, pre, tr")) {
            val text = el.text().trim()
            if (text.isEmpty()) continue
            when (el.tagName().lowercase()) {
                "h1" -> lines.add("\n# $text\n")
                "h2" -> lines.add("\n## $text\n")
                "h3" -> lines.add("\n### $text\n")
                "h4" -> lines.add("\n#### $text\n")
                "li" -> lines.add("- $text")
                "pre" -> lines.add("\n```\n${el.wholeText().trim()}\n```\n")
                "tr" -> {
                    val cells = el.select("th, td").map { it.text().trim() }.filter { it.isNotEmpty() }
                    if (cells.isNotEmpty()) lines.add("| " + cells.joinToString(" | ") + " |")
                }
                else -> lines.add(text)
            }
        }
        if (lines.isEmpty()) {
            return root.text().trim()
        }
        return lines.joinToString("\n").replace(Regex("\n{3,}"), "\n\n").trim()
    }

    companion object {
        fun buildSafeUploadFilename(
            gameName: String,
            providerId: String,
            guideTitle: String,
            extension: String
        ): String {
            fun slug(s: String) = s
                .lowercase()
                .replace(Regex("[^a-z0-9]+"), "_")
                .trim('_')

            val parts = listOf(slug(gameName), slug(providerId), slug(guideTitle))
                .filter { it.isNotEmpty() }
            val joined = parts.joinToString("_").ifEmpty { "guide_${System.currentTimeMillis()}" }
            val ext = extension.trimStart('.').lowercase().ifEmpty { "md" }
            return "${joined.take(72).trimEnd('_')}.$ext"
        }
    }
}
