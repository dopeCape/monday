# The Android build shell (docs/mobile.md): shell.nix plus the Android SDK and
# NDK on the environment, so `bun tauri android build` finds them. The SDK is
# not from nixpkgs: it is the one Android Studio or sdkmanager installed under
# ~/Android/Sdk (set ANDROID_HOME / NDK_HOME before entering to override).
{ pkgs ? import (fetchTarball "https://github.com/NixOS/nixpkgs/archive/nixos-unstable.tar.gz") {
    overlays = [
      (import (fetchTarball "https://github.com/oxalica/rust-overlay/archive/master.tar.gz"))
    ];
  }
}:

let
  desktop = import ./shell.nix { inherit pkgs; };
in
desktop.overrideAttrs (old: {
  nativeBuildInputs = old.nativeBuildInputs ++ [ pkgs.jdk21 ];

  shellHook = old.shellHook + ''

    export ANDROID_HOME=''${ANDROID_HOME:-$HOME/Android/Sdk}
    export ANDROID_SDK_ROOT=$ANDROID_HOME
    if [ -z "$NDK_HOME" ] && [ -d "$ANDROID_HOME/ndk" ]; then
      # The newest side-by-side NDK the SDK manager installed.
      NDK_HOME=$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | sort -V | tail -n 1)
    fi
    export NDK_HOME
    export JAVA_HOME=${pkgs.jdk21.home}
    export PATH=$ANDROID_HOME/platform-tools:$PATH
    echo "Android SDK $ANDROID_HOME, NDK ''${NDK_HOME:-missing (see docs/mobile.md)}"
  '';
})
