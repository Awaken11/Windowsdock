# Awaken Rebranding & Transformation Changelog

**Product Name:** Awaken  
**Target Repository:** [https://github.com/Awaken11/Windowsdock](https://github.com/Awaken11/Windowsdock)  
**Maintainer:** Awaken11 (`Akhil.Aafriya0987@outlook.com`)  
**Base Upstream Project:** Bloom by Sehajveer Singh and contributors  
**License:** GNU General Public License v3.0 (GPL-3.0)

---

## 1. Executive Summary

This document records the complete, systematic transformation of the desktop shell application into **Awaken**, establishing product ownership, custom visual branding, independent Git repositories, safe settings migration, and a verified Windows executable.

All architectural invariants (Win32 AppBar reservations, low-level mouse hooks, WASAPI audio loopback visualizers, fail-safe taskbar restoration watchdog, multi-window layout, and custom feature enhancements) have been 100% preserved.

---

## 2. Git & Repository Changes

- **Repository Remotes:**
  - `origin`: Set to `https://github.com/Awaken11/Windowsdock.git`
  - `upstream`: Retained pointing to `https://github.com/SehajveerSingh2005/bloom.git` for upstream reference tracking.
- **Commit History & Authorship:**
  - Complete git history from upstream has been preserved intact without history rewrites.
  - User and local feature additions have been committed cleanly under the new author identity:
    `Awaken11 <Akhil.Aafriya0987@outlook.com>`.

---

## 3. Application Identity & Packaging

| Component | Legacy Value (Bloom) | New Value (Awaken) | Purpose |
| :--- | :--- | :--- | :--- |
| **Package Name** | `bloom` | `awaken` | `package.json` |
| **Rust Crate** | `bloom`, `bloom_lib` | `awaken`, `awaken_lib` | `src-tauri/Cargo.toml` |
| **Tauri Product Name** | `bloom` | `Awaken` | `src-tauri/tauri.conf.json` |
| **Application Identifier** | `com.sehaz.bloom` | `com.akhil.awaken` | Sandboxed app data isolation |
| **Executable Name** | `bloom.exe` | `awaken.exe` | Windows binary artifact |
| **Single-Instance Mutex** | `BloomSingleInstance` | `AwakenSingleInstance` | Prevent duplicate instances |
| **Single-Instance Event** | `BloomOpenSettings` | `AwakenOpenSettings` | Signal to bring settings to focus |
| **Windows Startup Registry** | `"Bloom"` | `"Awaken"` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` |

---

## 4. Visual Identity & Brand Assets

- **Master Visual Asset:** Generated [`assets/branding/awaken-logo.png`](../assets/branding/awaken-logo.png) featuring a luminous letter **A** with deep violet-to-cyan gradient, celestial orbital ring, and glowing planetary node.
- **Vector Icons:** Created [`public/awaken.svg`](../public/awaken.svg) and [`src-tauri/icons/logo.svg`](../src-tauri/icons/logo.svg).
- **Windows Multi-Resolution Icon:** Built [`src-tauri/icons/icon.ico`](../src-tauri/icons/icon.ico) containing 16x16, 24x24, 32x32, 48x48, 64x64, 128x128, and 256x256 mipmaps.
- **Tauri Icon Bundle:** Generated all high-DPI and Windows Store tile assets:
  - `1024x1024.png`, `512x512.png`, `256x256.png`, `128x128.png`, `128x128@2x.png`, `64x64.png`, `32x32.png`, `32x32@2x.png`, `icon.png`
  - `Square30x30Logo.png`, `Square44x44Logo.png`, `Square71x71Logo.png`, `Square89x89Logo.png`, `Square107x107Logo.png`, `Square142x142Logo.png`, `Square150x150Logo.png`, `Square284x284Logo.png`, `Square310x310Logo.png`, `StoreLogo.png`
- **Web / Favicon Assets:** Created `public/awaken.png` and `public/favicon.ico`.

---

## 5. Frontend & UI Rebranding

- **Entrypoints:**
  - `index.html`: Title updated to `Awaken`, favicon updated to `/awaken.svg`.
  - `settings.html`: Title updated to `Awaken Settings`, loading screen badge updated to `/awaken.png`.
  - `dock.html`: Title updated to `Awaken Dock`, favicon updated to `/awaken.svg`.
  - `overlay.html`: Title updated to `Awaken App Switcher`, favicon updated to `/awaken.svg`.
- **Settings Application:**
  - `AboutTab.tsx`: Branded as `Awaken`, showing Awaken version banner, maintainer links to `Awaken11/Windowsdock`, and clear attribution to upstream Bloom contributors under GPL-3.0.
  - `GeneralTab.tsx`: "Launch Awaken on Windows startup", "Restart Awaken", "Quit Awaken".
  - `OverlaysTab.tsx` & `NotchTab.tsx`: Updated HUD descriptions and shelf retention tooltips.
  - `useSettings.ts`: Confirmation dialogs updated to "Reset Awaken to Defaults".
- **Dock & Island Context Menus:**
  - `src/Dock.tsx`: "Bloom Options" replaced with "Awaken Options", "Restart Awaken", "Quit Awaken".
  - `src/App.tsx`: Quick controls action buttons updated to "Awaken Settings" and "Restart Awaken".

---

## 6. Settings & Data Migration Engine

Implemented `migrate_legacy_data()` in `src-tauri/src/utils.rs`:
- Automatically detects legacy Bloom data at `%APPDATA%\com.sehaz.bloom` and `%APPDATA%\bloom`.
- Safely copies over:
  - `settings.json`
  - `clipboard_history.json`
  - `pinned_apps.json`
  - `icons_cache.json`
  - `custom_icons/` directory
- Non-destructive guarantee: Existing Awaken settings are **never overwritten**, and original Bloom files are preserved untouched.
- Clean up legacy `"Bloom"` autostart registry value from `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

---

## 7. Updater & Release Infrastructure

- Updated `.github/workflows/release.yml` with Awaken release naming templates.
- Reconfigured updater endpoints to `https://github.com/Awaken11/Windowsdock/releases/latest/download/latest.json`.
- Safely set updater active state to `false` in `src-tauri/tauri.conf.json` until the maintainer creates and publishes the first release tag and Minisign key, preventing updater errors on startup.

---

## 8. Architectural Invariants Preserved

1. **Window Labels:** `main`, `dock`, `overlay`, `settings` remain strictly unchanged to preserve Tauri window router and IPC routing.
2. **IPC Events:** `settings-changed`, `settings-external-changed`, `app-notification`, `volume-change`, `notch-overlap`, `dock-overlap` remain intact.
3. **Taskbar Restoration Watchdog:** The watchdog mechanism dynamically invokes `std::env::current_exe()` with `--taskbar-watchdog <PID> <marker>` to safeguard Windows Explorer taskbar restoration even if `awaken.exe` is force-killed.

