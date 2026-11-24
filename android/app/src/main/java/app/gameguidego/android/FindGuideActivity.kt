package app.gameguidego.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import app.gameguidego.android.databinding.ActivityFindGuideBinding
import app.gameguidego.android.model.GuideProvider
import app.gameguidego.android.network.GameGuideGoApi
import app.gameguidego.android.scraper.GuideExtractor
import app.gameguidego.android.scraper.GuidePageDetector
import app.gameguidego.android.scraper.PageDetectionResult
import app.gameguidego.android.service.GuideIngestService
import app.gameguidego.android.web.GuideWebViewClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

class FindGuideActivity : AppCompatActivity() {

    private lateinit var binding: ActivityFindGuideBinding
    private lateinit var provider: GuideProvider
    private lateinit var webClient: GuideWebViewClient
    private val extractor = GuideExtractor()
    private val api = GameGuideGoApi()

    private var gameName: String = ""
    private var platform: String = ""
    private var accessToken: String = ""
    private var serverUrl: String = ""
    private var currentDetection: PageDetectionResult? = null
    private var detectJob: Job? = null
    private var ingestJob: Job? = null

    private val notificationPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ -> }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityFindGuideBinding.inflate(layoutInflater)
        setContentView(binding.root)

        applyInsets()
        requestNotificationPermissionIfNeeded()

        provider = GuideProvider.fromId(intent.getStringExtra(EXTRA_PROVIDER_ID))
        gameName = intent.getStringExtra(EXTRA_GAME_NAME).orEmpty()
        platform = intent.getStringExtra(EXTRA_PLATFORM).orEmpty()
        accessToken = intent.getStringExtra(EXTRA_ACCESS_TOKEN).orEmpty()
        serverUrl = intent.getStringExtra(EXTRA_SERVER_URL).orEmpty()

        binding.txtProviderTitle.text = provider.displayName
        binding.findSearchInput.setText(gameName)

        setupBrowser()
        setupControls()
        setupBackHandler()
        renderDetectionState(null)

        GuideProvider.applyProviderCookies(provider)
        binding.guideBrowserWebView.loadUrl(provider.buildSearchUrl(gameName))
    }

    override fun onDestroy() {
        ingestJob?.cancel()
        GuideIngestService.stop(this)
        super.onDestroy()
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                notificationPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private fun applyInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(binding.findGuideRoot) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupBrowser() {
        val settings: WebSettings = binding.guideBrowserWebView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE

        webClient = GuideWebViewClient(
            adBlockEnabled = true,
            onPageStartedCallback = {
                currentDetection = null
                renderDetectionState(null)
                updateNavButtons()
            },
            onHistoryUpdatedCallback = {
                updateNavButtons()
                scheduleDetection()
            },
            onPageFinishedCallback = {
                updateNavButtons()
                scheduleDetection()
            }
        )
        binding.guideBrowserWebView.webViewClient = webClient
        binding.guideBrowserWebView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                binding.findProgressBar.visibility =
                    if (newProgress in 1..99) View.VISIBLE else View.GONE
                binding.findProgressBar.progress = newProgress
            }
        }
    }

    private fun setupControls() {
        binding.btnClose.setOnClickListener {
            if (ingestJob?.isActive == true) {
                confirmCancelActiveIngest(closeAfterCancel = true)
            } else {
                setResult(RESULT_CANCELED)
                finish()
            }
        }

        binding.btnCancelIngest.setOnClickListener {
            confirmCancelActiveIngest(closeAfterCancel = false)
        }

        binding.btnToggleSearch.setOnClickListener {
            val show = binding.searchBarRow.visibility != View.VISIBLE
            binding.searchBarRow.visibility = if (show) View.VISIBLE else View.GONE
        }

        binding.btnNavBack.setOnClickListener {
            if (binding.guideBrowserWebView.canGoBack()) {
                binding.guideBrowserWebView.goBack()
            }
        }

        binding.btnNavForward.setOnClickListener {
            if (binding.guideBrowserWebView.canGoForward()) {
                binding.guideBrowserWebView.goForward()
            }
        }

        binding.btnToggleAdBlock.setOnClickListener {
            webClient.adBlockEnabled = !webClient.adBlockEnabled
            val tintColor = if (webClient.adBlockEnabled) {
                ContextCompat.getColor(this, R.color.signal_emerald)
            } else {
                Color.parseColor("#64748B")
            }
            binding.btnToggleAdBlock.imageTintList = ColorStateList.valueOf(tintColor)
            binding.guideBrowserWebView.reload()
        }

        binding.btnSearchGo.setOnClickListener { runSearch() }
        binding.findSearchInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH || actionId == EditorInfo.IME_ACTION_DONE) {
                runSearch()
                true
            } else {
                false
            }
        }

        binding.btnDownloadGuide.setOnClickListener {
            val detection = currentDetection ?: return@setOnClickListener
            if (!detection.canDownload) return@setOnClickListener
            onDownloadClicked(detection)
        }
    }

    private fun confirmCancelActiveIngest(closeAfterCancel: Boolean) {
        AlertDialog.Builder(this)
            .setTitle("Cancel guide upload?")
            .setMessage("Uploading/indexing is still in progress. Cancel it now?")
            .setPositiveButton("Cancel upload") { _, _ ->
                ingestJob?.cancel()
                GuideIngestService.stop(this)
                setBusy(false, "")
                if (closeAfterCancel) {
                    setResult(RESULT_CANCELED)
                    finish()
                }
            }
            .setNegativeButton("Keep running", null)
            .show()
    }

    private fun runSearch() {
        val query = binding.findSearchInput.text?.toString().orEmpty()
        GuideProvider.applyProviderCookies(provider)
        binding.guideBrowserWebView.loadUrl(provider.buildSearchUrl(query))
        binding.searchBarRow.visibility = View.GONE
    }

    private fun scheduleDetection() {
        detectJob?.cancel()
        detectJob = lifecycleScope.launch {
            val first = GuidePageDetector.detect(binding.guideBrowserWebView, provider)
            currentDetection = first
            renderDetectionState(first)
            if (first == null || !first.canDownload) {
                delay(450)
                val second = GuidePageDetector.detect(binding.guideBrowserWebView, provider)
                currentDetection = second
                renderDetectionState(second)
            }
        }
    }

    private fun updateNavButtons() {
        val busy = ingestJob?.isActive == true
        val canBack = !busy && binding.guideBrowserWebView.canGoBack()
        val canForward = !busy && binding.guideBrowserWebView.canGoForward()
        binding.btnNavBack.isEnabled = canBack
        binding.btnNavBack.alpha = if (canBack) 1.0f else 0.35f
        binding.btnNavForward.isEnabled = canForward
        binding.btnNavForward.alpha = if (canForward) 1.0f else 0.35f
    }

    private fun renderDetectionState(detection: PageDetectionResult?) {
        val ready = detection != null && detection.canDownload
        binding.btnDownloadGuide.isEnabled = ready && ingestJob?.isActive != true

        if (detection != null && detection.canDownload) {
            binding.txtStatusIcon.text = "✓"
            binding.txtStatusIcon.setTextColor(ContextCompat.getColor(this, R.color.signal_emerald))
            binding.txtDetectionHeadline.text = "Guide page detected"
            if (detection.summaryLabel.isNotBlank()) {
                binding.txtDetectionSub.text = detection.summaryLabel
                binding.txtDetectionSub.visibility = View.VISIBLE
            } else {
                binding.txtDetectionSub.visibility = View.GONE
            }
            binding.btnDownloadGuide.backgroundTintList =
                ColorStateList.valueOf(ContextCompat.getColor(this, R.color.signal))
            binding.btnDownloadGuide.setTextColor(ContextCompat.getColor(this, R.color.on_signal))
        } else {
            binding.txtStatusIcon.text = "!"
            binding.txtStatusIcon.setTextColor(Color.parseColor("#FBBF24"))
            binding.txtDetectionHeadline.text = "Browse to a guide page"
            binding.txtDetectionSub.visibility = View.GONE
            binding.btnDownloadGuide.backgroundTintList =
                ColorStateList.valueOf(Color.parseColor("#1C2536"))
            binding.btnDownloadGuide.setTextColor(Color.parseColor("#64748B"))
        }
    }

    private fun onDownloadClicked(detection: PageDetectionResult) {
        if (ingestJob?.isActive == true) return
        if (detection.tocPageCount > 1) {
            val fullLimit = minOf(detection.tocPageCount, 50)
            val options = arrayOf(
                "Sample: First 2 pages (recommended for testing)",
                "Current page only",
                "Full guide ($fullLimit pages)"
            )
            AlertDialog.Builder(this)
                .setTitle("Download & Ingest Guide")
                .setItems(options) { _, which ->
                    val maxPages = when (which) {
                        0 -> 2
                        1 -> 1
                        else -> fullLimit
                    }
                    extractAndIngest(detection, maxPages)
                }
                .setNegativeButton("Cancel", null)
                .show()
        } else {
            extractAndIngest(detection, maxPages = 1)
        }
    }

    private fun extractAndIngest(detection: PageDetectionResult, maxPages: Int) {
        ingestJob?.cancel()
        setBusy(true, "Extracting guide...")
        ingestJob = lifecycleScope.launch {
            var tempFile: File? = null
            try {
                val extracted = extractor.extractCurrentGuide(
                    webView = binding.guideBrowserWebView,
                    detection = detection,
                    maxPages = maxPages
                ) { done, total ->
                    binding.txtProgressMessage.text = "Downloading page $done of $total…"
                }

                val safeName = GuideExtractor.buildSafeUploadFilename(
                    gameName = gameName,
                    providerId = provider.id,
                    guideTitle = extracted.title,
                    extension = extracted.extension
                )
                tempFile = File(cacheDir, safeName)
                if (extracted.binaryContent != null) {
                    tempFile.writeBytes(extracted.binaryContent)
                } else {
                    tempFile.writeText(extracted.textContent.orEmpty(), Charsets.UTF_8)
                }

                require(tempFile.length() <= MAX_UPLOAD_BYTES) {
                    "Extracted guide exceeds 4 MB upload limit. Choose a smaller page range."
                }

                binding.txtProgressMessage.text = "Uploading & indexing into GameGuideGo…"
                GuideIngestService.start(
                    this@FindGuideActivity,
                    "Uploading & indexing ${extracted.title}…"
                )
                val uploadRes = api.uploadGuideForIngest(
                    serverUrl = serverUrl,
                    authToken = accessToken,
                    file = tempFile,
                    game = gameName.ifBlank { null },
                    platform = platform.ifBlank { null }
                ).getOrThrow()

                val data = Intent().apply {
                    putExtra(EXTRA_GUIDE_URL, uploadRes.guideUrl)
                    putExtra(EXTRA_GUIDE_TITLE, extracted.title)
                    putExtra(EXTRA_FILENAME, uploadRes.filename)
                    putExtra(EXTRA_CHUNK_COUNT, uploadRes.chunkCount)
                }
                setResult(RESULT_OK, data)
                finish()
            } catch (ce: CancellationException) {
                throw ce
            } catch (err: Throwable) {
                if (!isFinishing && !isDestroyed) {
                    AlertDialog.Builder(this@FindGuideActivity)
                        .setTitle("Download / Ingest Failed")
                        .setMessage(err.message ?: "Unexpected error while processing guide.")
                        .setPositiveButton("OK", null)
                        .show()
                }
            } finally {
                GuideIngestService.stop(this@FindGuideActivity)
                tempFile?.delete()
                if (!isFinishing && !isDestroyed) {
                    setBusy(false, "")
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }
    }

    private fun setBusy(busy: Boolean, message: String) {
        if (busy) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        binding.progressOverlay.visibility = if (busy) View.VISIBLE else View.GONE
        binding.txtProgressMessage.text = message
        binding.btnToggleSearch.isEnabled = !busy
        binding.btnToggleAdBlock.isEnabled = !busy
        binding.btnDownloadGuide.isEnabled = !busy && (currentDetection?.canDownload == true)
        updateNavButtons()
    }

    private fun setupBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (ingestJob?.isActive == true) {
                    confirmCancelActiveIngest(closeAfterCancel = false)
                    return
                }
                if (binding.guideBrowserWebView.canGoBack()) {
                    binding.guideBrowserWebView.goBack()
                } else {
                    setResult(RESULT_CANCELED)
                    finish()
                }
            }
        })
    }

    companion object {
        private const val MAX_UPLOAD_BYTES = 4L * 1024L * 1024L
        const val EXTRA_PROVIDER_ID = "provider_id"
        const val EXTRA_GAME_NAME = "game_name"
        const val EXTRA_PLATFORM = "platform"
        const val EXTRA_ACCESS_TOKEN = "access_token"
        const val EXTRA_SERVER_URL = "server_url"

        const val EXTRA_GUIDE_URL = "guide_url"
        const val EXTRA_GUIDE_TITLE = "guide_title"
        const val EXTRA_FILENAME = "filename"
        const val EXTRA_CHUNK_COUNT = "chunk_count"
        const val EXTRA_ERROR = "error"
    }
}
