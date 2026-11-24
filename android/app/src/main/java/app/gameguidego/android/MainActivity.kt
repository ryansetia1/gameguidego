package app.gameguidego.android

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.gameguidego.android.data.AppPrefs
import app.gameguidego.android.databinding.ActivityMainBinding
import app.gameguidego.android.scraper.GuidePageDetector
import app.gameguidego.android.web.GuideWebViewClient
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: AppPrefs
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
    }

    private val findGuideLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode != RESULT_OK) return@registerForActivityResult
        val data = result.data ?: return@registerForActivityResult
        val payload = JSONObject().apply {
            put("guideUrl", data.getStringExtra(FindGuideActivity.EXTRA_GUIDE_URL).orEmpty())
            put("title", data.getStringExtra(FindGuideActivity.EXTRA_GUIDE_TITLE).orEmpty())
            put("filename", data.getStringExtra(FindGuideActivity.EXTRA_FILENAME).orEmpty())
            put("chunkCount", data.getIntExtra(FindGuideActivity.EXTRA_CHUNK_COUNT, 0))
            val err = data.getStringExtra(FindGuideActivity.EXTRA_ERROR)
            if (!err.isNullOrBlank()) put("error", err)
        }
        val script = "if (typeof window.__ggOnNativeGuideAdded === 'function') { window.__ggOnNativeGuideAdded($payload); }"
        binding.pwaWebView.evaluateJavascript(script, null)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        ViewCompat.setOnApplyWindowInsetsListener(binding.rootPwaContainer) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        prefs = AppPrefs(this)
        setupPwaWebView()
        setupBackHandler()

        binding.pwaWebView.loadUrl(prefs.serverUrl)
        handleAuthDeepLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAuthDeepLink(intent)
    }

    private fun handleAuthDeepLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "gameguidego" || data.host != "auth") return
        val accessToken = data.getQueryParameter("access_token").orEmpty()
        val refreshToken = data.getQueryParameter("refresh_token").orEmpty()
        if (accessToken.isBlank() || refreshToken.isBlank()) return

        prefs.authToken = accessToken
        val aJson = JSONObject.quote(accessToken)
        val rJson = JSONObject.quote(refreshToken)
        val js = """
            (function() {
                if (typeof window.__ggSetSession === 'function') {
                    window.__ggSetSession($aJson, $rJson).then(function(ok) {
                        if (ok) window.location.reload();
                    });
                } else {
                    window.location.href = ${JSONObject.quote(prefs.serverUrl)} + '/#access_token=' + encodeURIComponent($aJson) + '&refresh_token=' + encodeURIComponent($rJson) + '&token_type=bearer&type=magiclink';
                }
            })();
        """.trimIndent()
        binding.pwaWebView.evaluateJavascript(js, null)
        Toast.makeText(this, "Signed in!", Toast.LENGTH_SHORT).show()
    }

    private fun isExternalOAuthUrl(url: String): Boolean {
        return url.contains("accounts.google.com") ||
            url.contains("steamcommunity.com/openid") ||
            url.contains("/auth/v1/authorize") ||
            url.contains("/api/steam/login")
    }

    private fun openInCustomTab(url: String) {
        val customTabs = CustomTabsIntent.Builder().setShowTitle(true).build()
        runCatching {
            customTabs.launchUrl(this, Uri.parse(url))
        }.onFailure {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupPwaWebView() {
        val settings: WebSettings = binding.pwaWebView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        settings.userAgentString = "${settings.userAgentString} GameGuideGoAPK/1"

        binding.pwaWebView.addJavascriptInterface(AndroidBridge(), "GameGuideGoAndroid")

        binding.pwaWebView.webViewClient = GuideWebViewClient(
            adBlockEnabled = false,
            overrideUrlCallback = { url ->
                if (isExternalOAuthUrl(url)) {
                    openInCustomTab(url)
                    true
                } else {
                    false
                }
            }
        ) {
            syncSupabaseTokenFromPwa()
        }

        binding.pwaWebView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                binding.pwaProgressBar.visibility =
                    if (newProgress in 1..99) View.VISIBLE else View.GONE
                binding.pwaProgressBar.progress = newProgress
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback
                val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "*/*"
                }
                runCatching { fileChooserLauncher.launch(intent) }.onFailure {
                    this@MainActivity.filePathCallback = null
                }
                return true
            }
        }
    }

    private fun syncSupabaseTokenFromPwa() {
        val script = """
            (function() {
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') !== -1) {
                        return localStorage.getItem(k);
                    }
                }
                return '';
            })();
        """.trimIndent()
        binding.pwaWebView.evaluateJavascript(script) { raw ->
            val unquoted = GuidePageDetector.unquoteJsonString(raw ?: "")
            if (unquoted.isNotBlank()) {
                val token = runCatching { JSONObject(unquoted).optString("access_token") }.getOrDefault("")
                if (token.isNotBlank()) {
                    prefs.authToken = token
                }
            }
        }
    }

    private fun setupBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.pwaWebView.canGoBack()) {
                    binding.pwaWebView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    inner class AndroidBridge {
        @JavascriptInterface
        fun openFindGuide(
            providerId: String,
            gameName: String,
            platform: String,
            accessToken: String
        ) {
            runOnUiThread {
                val resolvedToken = accessToken.ifBlank { prefs.authToken }
                val intent = Intent(this@MainActivity, FindGuideActivity::class.java).apply {
                    putExtra(FindGuideActivity.EXTRA_PROVIDER_ID, providerId)
                    putExtra(FindGuideActivity.EXTRA_GAME_NAME, gameName)
                    putExtra(FindGuideActivity.EXTRA_PLATFORM, platform)
                    putExtra(FindGuideActivity.EXTRA_ACCESS_TOKEN, resolvedToken)
                    putExtra(FindGuideActivity.EXTRA_SERVER_URL, prefs.serverUrl)
                }
                findGuideLauncher.launch(intent)
            }
        }
    }
}
