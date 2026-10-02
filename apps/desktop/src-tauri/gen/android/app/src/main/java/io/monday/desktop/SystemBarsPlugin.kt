package io.monday.desktop

import android.app.Activity
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class SystemBarsArgs {
  var dark: Boolean = false
}

// The status and navigation bars' icons (src-tauri/src/system_bars.rs). The
// webview draws edge to edge, so the bars sit over monday's own background:
// in the dark appearance their icons must be light, whatever the system's
// own appearance is.
@TauriPlugin
class SystemBarsPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun setSystemBars(invoke: Invoke) {
    val args = invoke.parseArgs(SystemBarsArgs::class.java)
    activity.runOnUiThread {
      val window = activity.window
      val controller = WindowCompat.getInsetsController(window, window.decorView)
      // "Light" bars carry dark icons: for monday's light appearance only.
      controller.isAppearanceLightStatusBars = !args.dark
      controller.isAppearanceLightNavigationBars = !args.dark
      invoke.resolve()
    }
  }
}
