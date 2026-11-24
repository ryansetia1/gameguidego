package app.gameguidego.android.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

data class IngestUploadResult(
    val indexed: Boolean,
    val chunkCount: Int,
    val guideUrl: String,
    val filename: String
)

class GameGuideGoApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    suspend fun uploadGuideForIngest(
        serverUrl: String,
        authToken: String,
        file: File,
        game: String?,
        platform: String?
    ): Result<IngestUploadResult> = withContext(Dispatchers.IO) {
        runCatching {
            require(authToken.isNotBlank()) {
                "Sign in to GameGuideGo first (or paste Supabase Bearer token in Library > Settings)."
            }
            val mimeType = when (file.extension.lowercase()) {
                "pdf" -> "application/pdf"
                "md" -> "text/markdown"
                else -> "text/plain"
            }.toMediaType()

            val bodyBuilder = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", file.name, file.asRequestBody(mimeType))

            if (!game.isNullOrBlank()) {
                bodyBuilder.addFormDataPart("game", game.trim().take(120))
            }
            if (!platform.isNullOrBlank()) {
                bodyBuilder.addFormDataPart("platform", platform.trim().take(80))
            }

            val endpoint = "${serverUrl.trimEnd('/')}/api/guide-upload"
            val request = Request.Builder()
                .url(endpoint)
                .header("Authorization", "Bearer $authToken")
                .post(bodyBuilder.build())
                .build()

            client.newCall(request).execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                val json = runCatching { JSONObject(raw) }.getOrNull()
                if (!resp.isSuccessful) {
                    val err = json?.optString("error")?.takeIf { it.isNotBlank() }
                        ?: "Upload failed (HTTP ${resp.code})"
                    error(err)
                }
                IngestUploadResult(
                    indexed = json?.optBoolean("indexed", false) ?: false,
                    chunkCount = json?.optInt("chunkCount", 0) ?: 0,
                    guideUrl = json?.optString("guideUrl").orEmpty(),
                    filename = json?.optString("filename").orEmpty().ifBlank { file.name }
                )
            }
        }
    }
}
