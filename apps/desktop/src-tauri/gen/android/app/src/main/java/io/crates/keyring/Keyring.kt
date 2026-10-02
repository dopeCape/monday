package io.crates.keyring

import android.content.Context

// The keychain on Android (src-tauri/src/secrets.rs) is the
// android-native-keyring-store crate, which reaches the Android Keystore and
// SharedPreferences through the ndk-context crate. Tauri does not fill that
// context in, so MainActivity hands over the application context here. The
// native function is the crate's own, linked into libmonday_lib.so, which
// TauriActivity has already loaded; the class and package name are fixed by
// its JNI symbol.
class Keyring {
  companion object {
    init {
      System.loadLibrary("monday_lib")
    }

    external fun initializeNdkContext(context: Context)
  }
}
