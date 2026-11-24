package app.gameguidego.android.data

import android.content.Context
import java.io.File

data class LocalGuideFile(
    val file: File,
    val name: String,
    val sizeBytes: Long,
    val modifiedAt: Long
)

class GuideLocalStore(context: Context) {
    private val guidesDir = File(context.filesDir, "guides").apply { mkdirs() }

    fun saveTextGuide(title: String, extension: String, content: String): File {
        val safeName = sanitizeFilename(title).ifEmpty { "guide_${System.currentTimeMillis()}" }
        val ext = extension.trimStart('.').lowercase().ifEmpty { "txt" }
        val target = File(guidesDir, "${safeName}.$ext")
        target.writeText(content, Charsets.UTF_8)
        return target
    }

    fun saveBinaryGuide(title: String, extension: String, bytes: ByteArray): File {
        val safeName = sanitizeFilename(title).ifEmpty { "guide_${System.currentTimeMillis()}" }
        val ext = extension.trimStart('.').lowercase().ifEmpty { "bin" }
        val target = File(guidesDir, "${safeName}.$ext")
        target.writeBytes(bytes)
        return target
    }

    fun listGuides(): List<LocalGuideFile> {
        val files = guidesDir.listFiles() ?: return emptyList()
        return files
            .filter { it.isFile }
            .sortedByDescending { it.lastModified() }
            .map {
                LocalGuideFile(
                    file = it,
                    name = it.name,
                    sizeBytes = it.length(),
                    modifiedAt = it.lastModified()
                )
            }
    }

    fun deleteGuide(file: File): Boolean = file.exists() && file.delete()

    private fun sanitizeFilename(raw: String): String {
        return raw
            .replace(Regex("[^A-Za-z0-9._-]+"), "_")
            .trim('_')
            .take(64)
    }
}
