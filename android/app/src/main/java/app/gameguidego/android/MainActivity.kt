package app.gameguidego.android

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import app.gameguidego.android.data.AppPrefs
import app.gameguidego.android.data.GuideLocalStore
import app.gameguidego.android.data.LocalGuideFile
import app.gameguidego.android.databinding.ActivityMainBinding
import app.gameguidego.android.model.GuideProvider
import app.gameguidego.android.network.GameGuideGoApi
import app.gameguidego.android.scraper.GuideExtractor
import app.gameguidego.android.scraper.GuidePageDetector
import app.gameguidego.android.scraper.PageDetectionResult
import app.gameguidego.android.ui.LocalGuideAdapter
import app.gameguidego.android.web.GuideWebViewClient
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: AppPrefs
    private lateinit var localStore: GuideLocalStore
    private val extractor = GuideExtractor()
    private val api = GameGuideGoApi()

    private var selectedProvider = GuideProvider.GAMEFAQS
    private var currentDetection: PageDetectionResult? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var guideAdapter: LocalGuideAdapter

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = AppPrefs(this)
        localStore = GuideLocalStore(this)

        setupPwaWebView()
        setupFindGuidesBrowser()
        setupLibraryAndSettings()
        setupNavigation()
        setupBackHandler()

        binding.pwaWebView.loadUrl(prefs.serverUrl)
        binding.guideBrowserWebView.loadUrl(selectedProvider.buildSearchUrl(""))
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
        updateAuthStatusLabel()
        binding.bottomNav.selectedItemId = R.id.tab_pwa
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
        toast("Signed in!")
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
    private fun configureWebSettings(settings: WebSettings) {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
    }

    private fun setupPwaWebView() {
        configureWebSettings(binding.pwaWebView.settings)
        binding.pwaWebView.settings.userAgentString =
            "${binding.pwaWebView.settings.userAgentString} GameGuideGoAPK/1"
        binding.pwaWebView.webViewClient = GuideWebViewClient(
            enableAdBlock = false,
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
                binding.pwaProgressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
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

    private fun setupFindGuidesBrowser() {
        configureWebSettings(binding.guideBrowserWebView.settings)
        GuideProvider.applyProviderCookies(selectedProvider)

        binding.guideBrowserWebView.webViewClient = GuideWebViewClient(enableAdBlock = true) { url ->
            lifecycleScope.launch {
                val detected = GuidePageDetector.detect(binding.guideBrowserWebView)
                currentDetection = detected
                if (detected != null) {
                    val prefix = if (detected.isHighConfidenceGuide) "Ready: " else "Page: "
                    binding.txtDetectedStatus.text = "$prefix${detected.kind.label} — ${detected.title}"
                } else {
                    binding.txtDetectedStatus.text = url ?: "Browse a guide page to extract."
                }
            }
        }

        binding.guideBrowserWebView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                binding.findProgressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
                binding.findProgressBar.progress = newProgress
            }
        }

        binding.providerChipGroup.setOnCheckedStateChangeListener { _, checkedIds ->
            val id = checkedIds.firstOrNull() ?: return@setOnCheckedStateChangeListener
            selectedProvider = when (id) {
                R.id.chipGameFaqs -> GuideProvider.GAMEFAQS
                R.id.chipNeoseeker -> GuideProvider.NEOSEEKER
                R.id.chipZeldaDungeon -> GuideProvider.ZELDA_DUNGEON
                R.id.chipVgMaps -> GuideProvider.VGMAPS
                R.id.chipCustomUrl -> GuideProvider.CUSTOM_URL
                else -> GuideProvider.GAMEFAQS
            }
            GuideProvider.applyProviderCookies(selectedProvider)
            val query = binding.findSearchInput.text?.toString().orEmpty()
            binding.guideBrowserWebView.loadUrl(selectedProvider.buildSearchUrl(query))
        }

        binding.btnFindGo.setOnClickListener { runGuideSearch() }
        binding.findSearchInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH || actionId == EditorInfo.IME_ACTION_DONE) {
                runGuideSearch()
                true
            } else {
                false
            }
        }

        binding.btnSaveLocalOnly.setOnClickListener {
            extractCurrentPage(shouldIngest = false)
        }
        binding.btnDownloadAndIngest.setOnClickListener {
            extractCurrentPage(shouldIngest = true)
        }
    }

    private fun runGuideSearch() {
        val query = binding.findSearchInput.text?.toString().orEmpty()
        GuideProvider.applyProviderCookies(selectedProvider)
        binding.guideBrowserWebView.loadUrl(selectedProvider.buildSearchUrl(query))
    }

    private fun extractCurrentPage(shouldIngest: Boolean) {
        val detection = currentDetection ?: PageDetectionResult(
            url = binding.guideBrowserWebView.url.orEmpty(),
            title = binding.guideBrowserWebView.title ?: "Guide",
            kind = app.gameguidego.android.scraper.DetectedGuideKind.GENERIC_ARTICLE,
            isHighConfidenceGuide = false
        )
        if (detection.url.isBlank()) {
            toast("No page loaded yet.")
            return
        }

        setExtractButtonsEnabled(false)
        binding.txtDetectedStatus.text = "Extracting (${detection.kind.label})..."

        lifecycleScope.launch {
            val result = runCatching {
                extractor.extractCurrentGuide(
                    webView = binding.guideBrowserWebView,
                    detection = detection,
                    maxChapters = prefs.maxChapters
                )
            }
            setExtractButtonsEnabled(true)

            result.onFailure { err ->
                binding.txtDetectedStatus.text = "Extract failed: ${err.message}"
                toast("Extract failed: ${err.message}")
            }.onSuccess { extracted ->
                val savedFile = if (extracted.binaryContent != null) {
                    localStore.saveBinaryGuide(extracted.title, extracted.extension, extracted.binaryContent)
                } else {
                    localStore.saveTextGuide(extracted.title, extracted.extension, extracted.textContent.orEmpty())
                }
                refreshLibraryList()
                val chapterNote = if (extracted.totalTocLinks > 1) {
                    " (${extracted.pagesFetched}/${extracted.totalTocLinks} chapters)"
                } else ""
                binding.txtDetectedStatus.text = "Saved: ${savedFile.name}$chapterNote"

                if (shouldIngest) {
                    promptAndUploadForIngest(savedFile, defaultGame = binding.findSearchInput.text?.toString())
                } else {
                    toast("Saved locally: ${savedFile.name}")
                }
            }
        }
    }

    private fun promptAndUploadForIngest(file: File, defaultGame: String? = null) {
        syncSupabaseTokenFromPwa()
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 24, 48, 8)
        }
        val gameInput = EditText(this).apply {
            hint = "Game title (optional, e.g. Chrono Trigger)"
            setText(defaultGame.orEmpty())
        }
        val platformInput = EditText(this).apply {
            hint = "Platform (optional, e.g. SNES)"
        }
        container.addView(gameInput)
        container.addView(platformInput)

        AlertDialog.Builder(this)
            .setTitle("Ingest to GameGuideGo")
            .setMessage("Upload ${file.name} (${file.length() / 1024} KB) to ${prefs.serverUrl}/api/guide-upload?")
            .setView(container)
            .setPositiveButton("Upload & Ingest") { _, _ ->
                performIngestUpload(
                    file = file,
                    game = gameInput.text?.toString(),
                    platform = platformInput.text?.toString()
                )
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun performIngestUpload(file: File, game: String?, platform: String?) {
        toast("Uploading ${file.name} for ingest...")
        lifecycleScope.launch {
            val res = api.uploadGuideForIngest(
                serverUrl = prefs.serverUrl,
                authToken = prefs.authToken,
                file = file,
                game = game,
                platform = platform
            )
            res.onSuccess { info ->
                toast("Indexed ${info.chunkCount} chunks for ${info.filename}!")
            }.onFailure { err ->
                toast("Ingest failed: ${err.message}")
            }
        }
    }

    private fun setupLibraryAndSettings() {
        binding.inputServerUrl.setText(prefs.serverUrl)
        binding.inputMaxChapters.setText(prefs.maxChapters.toString())
        updateAuthStatusLabel()

        binding.btnSaveSettings.setOnClickListener {
            prefs.serverUrl = binding.inputServerUrl.text?.toString().orEmpty()
            prefs.maxChapters = binding.inputMaxChapters.text?.toString()?.toIntOrNull()
                ?: AppPrefs.DEFAULT_MAX_CHAPTERS
            val manual = binding.inputManualToken.text?.toString().orEmpty().trim()
            if (manual.isNotEmpty()) {
                prefs.authToken = manual
            }
            updateAuthStatusLabel()
            binding.pwaWebView.loadUrl(prefs.serverUrl)
            toast("Settings saved & PWA reloaded.")
        }

        guideAdapter = LocalGuideAdapter(
            onIngest = { item -> promptAndUploadForIngest(item.file) },
            onPreview = { item -> previewLocalGuide(item) },
            onDelete = { item ->
                localStore.deleteGuide(item.file)
                refreshLibraryList()
                toast("Deleted ${item.name}")
            }
        )
        binding.recyclerLocalGuides.layoutManager = LinearLayoutManager(this)
        binding.recyclerLocalGuides.adapter = guideAdapter
        refreshLibraryList()
    }

    private fun previewLocalGuide(item: LocalGuideFile) {
        val text = if (item.file.extension.lowercase() == "pdf") {
            "PDF file (${item.sizeBytes / 1024} KB). Ready to upload to GameGuideGo."
        } else {
            runCatching { item.file.readText(Charsets.UTF_8).take(3500) }
                .getOrElse { "Could not read file." }
        }
        AlertDialog.Builder(this)
            .setTitle(item.name)
            .setMessage(text)
            .setPositiveButton("Close", null)
            .show()
    }

    private fun refreshLibraryList() {
        val items = localStore.listGuides()
        guideAdapter.submitList(items)
        binding.txtEmptyLibrary.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
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
                    updateAuthStatusLabel()
                }
            }
        }
    }

    private fun updateAuthStatusLabel() {
        binding.txtAuthStatus.text = if (prefs.authToken.isNotBlank()) {
            "Auth Token: Synced (${prefs.authToken.take(12)}...)"
        } else {
            "Auth Token: Not synced yet (sign in on GameGuideGo tab)"
        }
    }

    private fun setupNavigation() {
        binding.bottomNav.setOnItemSelectedListener { item ->
            binding.tabPwaContainer.visibility = if (item.itemId == R.id.tab_pwa) View.VISIBLE else View.GONE
            binding.tabFindContainer.visibility = if (item.itemId == R.id.tab_find) View.VISIBLE else View.GONE
            binding.tabLibraryContainer.visibility = if (item.itemId == R.id.tab_library) View.VISIBLE else View.GONE

            if (item.itemId == R.id.tab_library) {
                syncSupabaseTokenFromPwa()
                refreshLibraryList()
            }
            true
        }
    }

    private fun setupBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    binding.tabPwaContainer.visibility == View.VISIBLE && binding.pwaWebView.canGoBack() -> {
                        binding.pwaWebView.goBack()
                    }
                    binding.tabFindContainer.visibility == View.VISIBLE && binding.guideBrowserWebView.canGoBack() -> {
                        binding.guideBrowserWebView.goBack()
                    }
                    else -> {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })
    }

    private fun setExtractButtonsEnabled(enabled: Boolean) {
        binding.btnDownloadAndIngest.isEnabled = enabled
        binding.btnSaveLocalOnly.isEnabled = enabled
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
}
