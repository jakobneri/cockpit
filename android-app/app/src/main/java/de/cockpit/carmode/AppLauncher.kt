package de.cockpit.carmode

import android.content.Context
import android.content.Intent
import android.util.Log

object AppLauncher {

    fun launch(context: Context, packageName: String) {
        val intent = context.packageManager.getLaunchIntentForPackage(packageName)
        if (intent != null) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            context.startActivity(intent)
            Log.d("AppLauncher", "Launched: $packageName")
        } else {
            Log.w("AppLauncher", "Not installed: $packageName")
        }
    }
}
