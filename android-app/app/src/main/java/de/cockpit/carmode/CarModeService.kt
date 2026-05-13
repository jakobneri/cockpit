package de.cockpit.carmode

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService

class CarModeService : LifecycleService() {

    private lateinit var audioManager: AudioManager
    private val handler = Handler(Looper.getMainLooper())

    private val audioDeviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<AudioDeviceInfo>) {
            val hasWiredOutput = addedDevices.any {
                it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET
            }
            if (hasWiredOutput) {
                updateNotification(getString(R.string.status_connected))
                launchCarApps()
            }
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<AudioDeviceInfo>) {
            val hadWiredOutput = removedDevices.any {
                it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET
            }
            if (hadWiredOutput) {
                updateNotification(getString(R.string.status_waiting))
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.status_waiting)))
        audioManager.registerAudioDeviceCallback(audioDeviceCallback, handler)
    }

    override fun onDestroy() {
        audioManager.unregisterAudioDeviceCallback(audioDeviceCallback)
        super.onDestroy()
    }

    private fun launchCarApps() {
        // Kurze Verzögerung damit der Audio-Stack hochfährt
        handler.postDelayed({
            AppLauncher.launch(this, YOUTUBE_MUSIC_PACKAGE)
        }, 500)
        handler.postDelayed({
            AppLauncher.launch(this, BLITZER_PRO_PACKAGE)
        }, 1500)
        handler.postDelayed({
            AppLauncher.launch(this, MAPS_PACKAGE)
        }, 2500)
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.notification_channel_desc)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(status: String): Notification {
        val openAppIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(status)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(openAppIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(status: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(status))
    }

    companion object {
        const val CHANNEL_ID = "car_mode_channel"
        const val NOTIFICATION_ID = 1
        const val YOUTUBE_MUSIC_PACKAGE = "com.google.android.apps.youtube.music"
        const val BLITZER_PRO_PACKAGE = "de.raketenknecht.blitzerpro"
        const val MAPS_PACKAGE = "com.google.android.apps.maps"
    }
}
