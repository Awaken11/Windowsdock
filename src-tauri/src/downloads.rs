use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use windows::Win32::UI::Shell::{FOLDERID_Downloads, KF_FLAG_DEFAULT, SHGetKnownFolderPath};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadItem {
    pub id: String,
    pub name: String,
    pub original_name: String,
    pub path: String,
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub speed_bytes_per_sec: u64,
    pub percentage: Option<f32>,
    pub status: String, // "downloading" | "completed"
    pub modified_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadProgressSummary {
    pub active_count: usize,
    pub total_speed_bps: u64,
    pub overall_percentage: Option<f32>,
    pub active_downloads: Vec<DownloadItem>,
    pub recent_completed: Vec<DownloadItem>,
}

struct PrevSample {
    bytes: u64,
    timestamp: u64,
}

static PREV_SAMPLES: OnceLock<Mutex<HashMap<String, PrevSample>>> = OnceLock::new();
static RECENT_COMPLETED: OnceLock<Mutex<Vec<DownloadItem>>> = OnceLock::new();

fn get_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn get_downloads_directory() -> Option<PathBuf> {
    unsafe {
        use windows::Win32::System::Com::CoTaskMemFree;
        if let Ok(pwstr) = SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None) {
            let s = pwstr.to_string().ok();
            CoTaskMemFree(Some(pwstr.0 as *const core::ffi::c_void));
            if let Some(path_str) = s {
                if !path_str.is_empty() {
                    return Some(PathBuf::from(path_str));
                }
            }
        }
    }
    std::env::var_os("USERPROFILE")
        .map(|up| PathBuf::from(up).join("Downloads"))
        .filter(|p| p.exists())
}

/// Discovers all download destinations across Windows default folders, Free Download Manager,
/// custom storage directories, and active drives.
pub fn get_all_download_directories() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();

    // 1. Windows default Downloads folder
    if let Some(d) = get_downloads_directory() {
        if seen.insert(d.clone()) {
            dirs.push(d);
        }
    }

    // 2. Desktop
    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        let desktop = PathBuf::from(&user_profile).join("Desktop");
        if desktop.exists() && seen.insert(desktop.clone()) {
            dirs.push(desktop);
        }
    }

    // 3. Free Download Manager (FDM) folders from settings.ini and db.sqlite
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let fdm_dir = PathBuf::from(local_app_data)
            .join("Softdeluxe")
            .join("Free Download Manager");

        // Parse paths from settings.ini
        let ini_path = fdm_dir.join("settings.ini");
        if let Ok(ini_content) = fs::read_to_string(&ini_path) {
            for line in ini_content.lines() {
                if line.contains("Path=") || line.contains("Dir=") {
                    if let Some(val) = line.split('=').nth(1) {
                        let cleaned = val.trim().trim_start_matches("file:///").replace('/', "\\");
                        let p = PathBuf::from(cleaned);
                        if p.exists() && p.is_dir() && seen.insert(p.clone()) {
                            dirs.push(p);
                        }
                    }
                }
            }
        }

        // Scan raw strings from FDM's db.sqlite to find configured destination paths (e.g. E:/movies, D:/movies)
        let db_path = fdm_dir.join("db.sqlite");
        if let Ok(bytes) = fs::read(&db_path) {
            let mut i = 0;
            while i + 3 < bytes.len() {
                let b = bytes[i];
                if b.is_ascii_alphabetic()
                    && bytes[i + 1] == b':'
                    && (bytes[i + 2] == b'/' || bytes[i + 2] == b'\\')
                {
                    let start = i;
                    i += 3;
                    while i < bytes.len()
                        && bytes[i] >= 32
                        && bytes[i] < 127
                        && bytes[i] != b'"'
                        && bytes[i] != b'\''
                        && bytes[i] != b';'
                        && bytes[i] != b'?'
                    {
                        i += 1;
                    }
                    if let Ok(s) = std::str::from_utf8(&bytes[start..i]) {
                        let p = PathBuf::from(s.replace('/', "\\"));
                        if p.exists() && p.is_dir() && seen.insert(p.clone()) {
                            dirs.push(p);
                        }
                    }
                } else {
                    i += 1;
                }
            }
        }
    }

    // 4. Common root folders across active drive letters (C, D, E, F, G)
    for letter in [b'C', b'D', b'E', b'F', b'G'] {
        let drive = format!("{}:\\", letter as char);
        for sub in &["Downloads", "movies", "Movies", "Torrents", "Videos"] {
            let p = PathBuf::from(&drive).join(sub);
            if p.exists() && p.is_dir() && seen.insert(p.clone()) {
                dirs.push(p);
            }
        }
    }

    dirs
}

/// Checks all download directories for active in-progress downloads and recently completed files.
pub fn scan_downloads() -> DownloadProgressSummary {
    let now = get_now_ms();
    let samples_lock = PREV_SAMPLES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut prev_samples = samples_lock.lock().unwrap_or_else(|e| e.into_inner());

    let mut active = Vec::new();
    let mut current_ids = Vec::new();
    let mut all_completed_candidates = Vec::new();

    let directories = get_all_download_directories();

    for dir in &directories {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                continue;
            }

            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            let lower = file_name.to_lowercase();

            let Ok(meta) = entry.metadata() else {
                continue;
            };

            let bytes = meta.len();
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(now);

            let age_ms = now.saturating_sub(modified_ms);

            // Recognize download in-progress file extensions
            let is_download_tmp = lower.ends_with(".crdownload")
                || lower.ends_with(".part")
                || lower.ends_with(".!ut")
                || lower.ends_with(".!fdm")
                || lower.ends_with(".fdmdownload")
                || lower.ends_with(".fdmdl")
                || lower.ends_with(".downloading")
                || lower.ends_with(".download");

            // Also detect direct file writes (e.g. FDM, torrent, or browser writing directly to final file)
            // if modified in the last 15 seconds
            let is_recently_modified_candidate = !is_download_tmp
                && age_ms < 15_000
                && (lower.ends_with(".mkv")
                    || lower.ends_with(".mp4")
                    || lower.ends_with(".zip")
                    || lower.ends_with(".iso")
                    || lower.ends_with(".bin")
                    || lower.ends_with(".exe")
                    || lower.ends_with(".rar")
                    || lower.ends_with(".7z"));

            let mut is_active = false;
            let mut speed = 0u64;

            if let Some(prev) = prev_samples.get(&file_name) {
                let elapsed_ms = now.saturating_sub(prev.timestamp);
                if elapsed_ms > 0 && bytes > prev.bytes {
                    speed = ((bytes - prev.bytes) * 1000) / elapsed_ms;
                    is_active = true;
                }
            }

            if is_download_tmp {
                // Ignore abandoned/stale temporary files (e.g. not modified in > 45 seconds and 0 speed)
                if age_ms <= 45_000 || speed > 0 {
                    is_active = true;
                }
            } else if is_recently_modified_candidate && speed > 0 {
                is_active = true;
            }

            // Always update sample for tracking speed across ticks
            prev_samples.insert(file_name.clone(), PrevSample { bytes, timestamp: now });

            if is_active {
                // Derive clean original filename without the temporary suffix
                let clean_name = if lower.ends_with(".crdownload") {
                    file_name[..file_name.len() - 11].to_string()
                } else if lower.ends_with(".part") {
                    file_name[..file_name.len() - 5].to_string()
                } else if lower.ends_with(".!ut") {
                    file_name[..file_name.len() - 4].to_string()
                } else if lower.ends_with(".!fdm") {
                    file_name[..file_name.len() - 5].to_string()
                } else if lower.ends_with(".fdmdownload") {
                    file_name[..file_name.len() - 12].to_string()
                } else if lower.ends_with(".fdmdl") {
                    file_name[..file_name.len() - 6].to_string()
                } else if lower.ends_with(".downloading") {
                    file_name[..file_name.len() - 12].to_string()
                } else if lower.ends_with(".download") {
                    file_name[..file_name.len() - 9].to_string()
                } else {
                    file_name.clone()
                };

                current_ids.push(file_name.clone());

                active.push(DownloadItem {
                    id: file_name.clone(),
                    name: clean_name,
                    original_name: file_name,
                    path: path.to_string_lossy().to_string(),
                    bytes_downloaded: bytes,
                    total_bytes: None,
                    speed_bytes_per_sec: speed,
                    percentage: None,
                    status: "downloading".into(),
                    modified_ms,
                });
            } else if !is_download_tmp && !lower.ends_with(".tmp") {
                // Collect candidates for recently completed downloads (e.g. modified in the last 7 days)
                let one_week_ms = 7 * 24 * 60 * 60 * 1000;
                if age_ms < one_week_ms {
                    all_completed_candidates.push((path, file_name, bytes, modified_ms));
                }
            }
        }
    }

    // Retain only currently tracked files in samples
    prev_samples.retain(|k, _| current_ids.contains(k));

    let total_speed: u64 = active.iter().map(|item| item.speed_bytes_per_sec).sum();

    // Sort completed files newest first, take the top 8
    all_completed_candidates.sort_by_key(|b| std::cmp::Reverse(b.3));

    let mut completed_items = Vec::new();
    for (p, name, len, mod_time) in all_completed_candidates.into_iter().take(8) {
        completed_items.push(DownloadItem {
            id: format!("completed-{}", name),
            name: name.clone(),
            original_name: name,
            path: p.to_string_lossy().to_string(),
            bytes_downloaded: len,
            total_bytes: Some(len),
            speed_bytes_per_sec: 0,
            percentage: Some(100.0),
            status: "completed".into(),
            modified_ms: mod_time,
        });
    }

    // Store in global cache
    let completed_lock = RECENT_COMPLETED.get_or_init(|| Mutex::new(Vec::new()));
    if let Ok(mut lock) = completed_lock.lock() {
        *lock = completed_items.clone();
    }

    DownloadProgressSummary {
        active_count: active.len(),
        total_speed_bps: total_speed,
        overall_percentage: None,
        active_downloads: active,
        recent_completed: completed_items,
    }
}

pub fn start_download_monitor(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_active = 0usize;
        loop {
            std::thread::sleep(Duration::from_millis(1000));
            let summary = scan_downloads();
            // Emit if there are active downloads or if active count just transitioned
            if summary.active_count > 0 || last_active > 0 {
                let _ = app.emit("downloads-update", &summary);
            }
            last_active = summary.active_count;
        }
    });
}

#[tauri::command]
pub async fn get_download_summary() -> DownloadProgressSummary {
    tauri::async_runtime::spawn_blocking(scan_downloads)
        .await
        .unwrap_or(DownloadProgressSummary {
            active_count: 0,
            total_speed_bps: 0,
            overall_percentage: None,
            active_downloads: vec![],
            recent_completed: vec![],
        })
}

#[tauri::command]
pub async fn open_download_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let wide_open: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
        let res = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(wide_open.as_ptr()),
                PCWSTR(wide_path.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if res.0 as usize <= 32 {
            return Err(format!("Could not open file: {}", path));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn show_download_in_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", path))
            .spawn();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_downloads_folder() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(dir) = get_downloads_directory() {
            let _ = std::process::Command::new("explorer.exe")
                .arg(dir)
                .spawn();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
