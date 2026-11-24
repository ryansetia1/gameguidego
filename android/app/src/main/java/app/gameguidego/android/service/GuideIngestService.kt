package app.gameguidego.android.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.gameguidego.android.R

class GuideIngestService : Service() {

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val message = intent?.getStringExtra(EXTRA_MESSAGE)
            ?.takeIf { it.isNotBlank() }
            ?: "Indexing guide…"
        val percent = intent?.getIntExtra(EXTRA_PERCENT, -1) ?: -1

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("GameGuideGo")
            .setContentText(message)
            .setOngoing(true)
            .setOnlyAlertOnce(true)

        if (percent in 0..100) {
            builder.setProgress(100, percent, false)
        } else {
            builder.setProgress(0, 0, true)
        }

        val serviceType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, builder.build(), serviceType)
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Guide Uploads",
                NotificationManager.IMPORTANCE_LOW
            )
            manager.createNotificationChannel(channel)
        }
    }

    companion object {
        private const val CHANNEL_ID = "guide_ingest"
        private const val NOTIFICATION_ID = 4201
        private const val ACTION_STOP = "app.gameguidego.android.action.STOP_INGEST"
        private const val EXTRA_MESSAGE = "message"
        private const val EXTRA_PERCENT = "percent"

        fun start(context: Context, message: String, percent: Int = -1) {
            val intent = Intent(context, GuideIngestService::class.java).apply {
                putExtra(EXTRA_MESSAGE, message)
                putExtra(EXTRA_PERCENT, percent)
            }
            runCatching { ContextCompat.startForegroundService(context, intent) }
        }

        fun stop(context: Context) {
            runCatching {
                context.stopService(Intent(context, GuideIngestService::class.java))
            }
        }
    }
}
