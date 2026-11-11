use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

/// Checks the Downloads directory for in-progress download files (.crdownload, .part, etc.)
pub fn scan_downloads() -> DownloadProgressSummary {
    let Some(downloads_dir) = get_downloads_directory() else {
        return DownloadProgressSummary {
            active_count: 0,
            total_speed_bps: 0,
            overall_percentage: None,
            active_downloads: vec![],
            recent_completed: vec![],
        };
    };

    let Ok(entries) = fs::read_dir(&downloads_dir) else {
        return DownloadProgressSummary {
            active_count: 0,
            total_speed_bps: 0,
            overall_percentage: None,
            active_downloads: vec![],
            recent_completed: vec![],
        };
    };

    let now = get_now_ms();
    let samples_lock = PREV_SAMPLES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut prev_samples = samples_lock.lock().unwrap_or_else(|e| e.into_inner());

    let mut active = Vec::new();
    let mut current_ids = Vec::new();

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

        // Recognize download in-progress file extensions
        let is_download_tmp = lower.ends_with(".crdownload")
            || lower.ends_with(".part")
            || lower.ends_with(".!ut")
            || lower.ends_with(".downloading")
            || lower.ends_with(".download");

        if !is_download_tmp {
            continue;
        }

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

        // Derive clean original filename without the .crdownload/.part suffix
        let clean_name = if lower.ends_with(".crdownload") {
            file_name[..file_name.len() - 11].to_string()
        } else if lower.ends_with(".part") {
            file_name[..file_name.len() - 5].to_string()
        } else if lower.ends_with(".!ut") {
            file_name[..file_name.len() - 4].to_string()
        } else if lower.ends_with(".downloading") {
            file_name[..file_name.len() - 12].to_string()
        } else if lower.ends_with(".download") {
            file_name[..file_name.len() - 9].to_string()
        } else {
            file_name.clone()
        };

        // Compute speed from previous sample
        let mut speed = 0u64;
        if let Some(prev) = prev_samples.get(&file_name) {
            let elapsed_ms = now.saturating_sub(prev.timestamp);
            if elapsed_ms > 0 && bytes >= prev.bytes {
                speed = ((bytes - prev.bytes) * 1000) / elapsed_ms;
            }
        }
        prev_samples.insert(file_name.clone(), PrevSample { bytes, timestamp: now });
        current_ids.push(file_name.clone());

        active.push(DownloadItem {
            id: file_name.clone(),
            name: clean_name.clone(),
            original_name: file_name,
            path: path.to_string_lossy().to_string(),
            bytes_downloaded: bytes,
            total_bytes: None,
            speed_bytes_per_sec: speed,
            percentage: None,
            status: "downloading".into(),
            modified_ms,
        });
    }

    // Retain only currently active files in samples
    prev_samples.retain(|k, _| current_ids.contains(k));

    let total_speed: u64 = active.iter().map(|item| item.speed_bytes_per_sec).sum();

    // Check for recently completed downloads from the Downloads folder
    let completed_lock = RECENT_COMPLETED.get_or_init(|| Mutex::new(Vec::new()));
    let mut completed = completed_lock.lock().unwrap_or_else(|e| e.into_inner());

    // Also populate recent files if empty
    if completed.is_empty() {
        if let Ok(entries) = fs::read_dir(&downloads_dir) {
            let mut recent_files: Vec<_> = entries
                .flatten()
                .filter_map(|e| {
                    let p = e.path();
                    if p.is_file() {
                        let meta = e.metadata().ok()?;
                        let mod_time = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
                        let name = p.file_name()?.to_string_lossy().to_string();
                        let lower = name.to_lowercase();
                        if !lower.ends_with(".crdownload") && !lower.ends_with(".part") && !lower.ends_with(".tmp") {
                            return Some((p, name, meta.len(), mod_time));
                        }
                    }
                    None
                })
                .collect();
            recent_files.sort_by_key(|b| std::cmp::Reverse(b.3));
            for (p, name, len, mod_time) in recent_files.into_iter().take(5) {
                completed.push(DownloadItem {
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
        }
    }

    DownloadProgressSummary {
        active_count: active.len(),
        total_speed_bps: total_speed,
        overall_percentage: None,
        active_downloads: active,
        recent_completed: completed.clone(),
    }
}

pub fn start_download_monitor(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_active = 0usize;
        loop {
            std::thread::sleep(Duration::from_millis(1000));
            let summary = scan_downloads();
            // Emit if there are active downloads or if active count just changed to 0
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
