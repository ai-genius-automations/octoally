# OctoAlly Desktop — Tauri (Inactive)

This directory contains a Tauri-based native desktop app for OctoAlly. It builds and runs, but is **not currently used** in favor of the Electron app (`desktop-electron/`).

## Why Electron instead of Tauri?

Tauri's WebView pty integration causes persistent idle CPU usage (~10%) when running tmux-backed terminal sessions. The issue appears to be in how Tauri's event loop interacts with the pty polling — even when no terminal activity is happening, the process never fully idles.

Electron doesn't have this problem since it manages pty sessions through the Node.js server process rather than the native app shell.

## Current state

- Builds successfully with `cargo tauri build`
- Dashboard loads and works
- Terminal sessions work but with the CPU overhead described above
- All config points to the same server at `localhost:42010`

## Re-enabling Tauri

If Tauri resolves the pty idle CPU issue (or you find a workaround), this app can be used as-is:

```bash
cd desktop
cargo tauri dev    # Development mode
cargo tauri build  # Production build
```

The Tauri app connects to the same OctoAlly server as the Electron app — they're interchangeable frontends.
