package app.gameguidego.android.web

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

class GuideWebViewClient(
    var adBlockEnabled: Boolean,
    private val overrideUrlCallback: ((url: String) -> Boolean)? = null,
    private val onPageStartedCallback: ((url: String?) -> Unit)? = null,
    private val onHistoryUpdatedCallback: ((url: String?) -> Unit)? = null,
    private val onPageFinishedCallback: (url: String?) -> Unit
) : WebViewClient() {

    override fun shouldOverrideUrlLoading(
        view: WebView?,
        request: WebResourceRequest?
    ): Boolean {
        val url = request?.url?.toString() ?: return false
        return overrideUrlCallback?.invoke(url) == true
    }

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {
        if (adBlockEnabled && AdBlockFilter.isBlocked(request?.url?.toString())) {
            return AdBlockFilter.emptyResponse()
        }
        return super.shouldInterceptRequest(view, request)
    }

    override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
        super.onPageStarted(view, url, favicon)
        onPageStartedCallback?.invoke(url)
    }

    override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
        super.doUpdateVisitedHistory(view, url, isReload)
        onHistoryUpdatedCallback?.invoke(url)
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        super.onPageFinished(view, url)
        onPageFinishedCallback(url)
    }
}
