{ pkgs ? import (fetchTarball "https://github.com/NixOS/nixpkgs/archive/nixos-unstable.tar.gz") {
    overlays = [
      # rust-overlay provides up-to-date Rust toolchains independent of the nixpkgs channel
      (import (fetchTarball "https://github.com/oxalica/rust-overlay/archive/master.tar.gz"))
    ];
  }
}:

let
  rustToolchain = pkgs.rust-bin.stable.latest.default.override {
    extensions = [ "rust-src" "rust-analyzer" "clippy" "rustfmt" ];
  };
in
pkgs.mkShell {
  nativeBuildInputs = with pkgs; [
    rustToolchain
    pkg-config
    gobject-introspection
    bun
  ];

  buildInputs = with pkgs; [
    # Tauri v2 Linux dependencies
    at-spi2-atk
    atkmm
    cairo
    gdk-pixbuf
    glib
    gtk3
    harfbuzz
    librsvg
    libsoup_3
    pango
    webkitgtk_4_1
    openssl

    # tray icon support
    libayatana-appindicator
  ];

  shellHook = ''
    # Make gsettings schemas visible to webkit/gtk (file dialogs, etc.)
    export XDG_DATA_DIRS=${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS

    # Uncomment if the window renders blank/black (common with NVIDIA drivers)
    # export WEBKIT_DISABLE_DMABUF_RENDERER=1

    echo "Tauri dev shell — rust $(rustc --version | cut -d' ' -f2), bun $(bun --version)"
  '';
}
