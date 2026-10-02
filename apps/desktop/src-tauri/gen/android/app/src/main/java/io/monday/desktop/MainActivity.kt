package io.monday.desktop

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Before the webview can ask for a secret: the keychain needs the app's context.
    Keyring.initializeNdkContext(applicationContext)
  }
}
