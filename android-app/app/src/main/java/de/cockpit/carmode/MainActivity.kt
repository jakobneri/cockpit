package de.cockpit.carmode

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import de.cockpit.carmode.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: android.content.SharedPreferences

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (!granted) {
            Toast.makeText(this, getString(R.string.notification_permission_hint), Toast.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = getSharedPreferences("settings", Context.MODE_PRIVATE)

        setupUI()
        requestNotificationPermissionIfNeeded()
    }

    override fun onResume() {
        super.onResume()
        updateAuxStatus()
    }

    private fun setupUI() {
        val isEnabled = prefs.getBoolean("service_enabled", true)
        binding.switchService.isChecked = isEnabled
        updateServiceState(isEnabled)

        binding.switchService.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean("service_enabled", checked).apply()
            updateServiceState(checked)
        }
    }

    private fun updateServiceState(enabled: Boolean) {
        val serviceIntent = Intent(this, CarModeService::class.java)
        if (enabled) {
            ContextCompat.startForegroundService(this, serviceIntent)
            binding.textServiceStatus.text = getString(R.string.service_active)
            binding.textServiceStatus.setTextColor(getColor(R.color.status_active))
        } else {
            stopService(serviceIntent)
            binding.textServiceStatus.text = getString(R.string.service_inactive)
            binding.textServiceStatus.setTextColor(getColor(R.color.status_inactive))
        }
    }

    private fun updateAuxStatus() {
        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        val wiredConnected = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
            it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
            it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET
        }
        binding.textAuxStatus.text = if (wiredConnected) {
            getString(R.string.aux_connected)
        } else {
            getString(R.string.aux_disconnected)
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }
}
