use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ClipboardItem {
    pub id: String,
    pub content: String,
    pub kind: String, // "url", "hex", "code", "text", "image"
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

static CLIPBOARD_HISTORY: LazyLock<Mutex<Vec<ClipboardItem>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));

static LAST_SELF_WRITE_SEQ: AtomicU32 = AtomicU32::new(0);
static LAST_SELF_WRITE_TIME_MS: AtomicU64 = AtomicU64::new(0);

fn get_history_file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|p| p.join("clipboard_history.json"))
}

pub fn load_history_from_disk(app: &AppHandle) {
    if let Some(path) = get_history_file_path(app) {
        if path.exists() {
            if let Ok(bytes) = std::fs::read(&path) {
                if let Ok(items) = serde_json::from_slice::<Vec<ClipboardItem>>(&bytes) {
                    let mut history = CLIPBOARD_HISTORY.lock().unwrap();
                    let mut seen = std::collections::HashSet::new();
                    let mut deduped = Vec::new();
                    for item in items {
                        let key = if item.kind == "image" {
                            format!("img_{}x{}", item.width.unwrap_or(0), item.height.unwrap_or(0))
                        } else {
                            format!("txt_{}", item.content.trim())
                        };
                        if seen.insert(key) {
                            deduped.push(item);
                        }
                    }
                    *history = deduped;
                }
            }
        }
    }
}

fn save_history_to_disk(app: &AppHandle, items: &[ClipboardItem]) {
    if let Some(path) = get_history_file_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(items) {
            let _ = std::fs::write(&path, json.as_bytes());
        }
    }
}

fn classify_text(text: &str) -> String {
    let trimmed = text.trim();
    if (trimmed.starts_with("http://") || trimmed.starts_with("https://") || trimmed.starts_with("www."))
        && !trimmed.contains('\n')
    {
        return "url".to_string();
    }
    if trimmed.starts_with('#')
        && (trimmed.len() == 4 || trimmed.len() == 7 || trimmed.len() == 9)
        && trimmed[1..].chars().all(|c| c.is_ascii_hexdigit())
    {
        return "hex".to_string();
    }
    if trimmed.contains("fn ")
        || trimmed.contains("function ")
        || trimmed.contains("const ")
        || trimmed.contains("let ")
        || trimmed.contains("var ")
        || trimmed.contains("import ")
        || trimmed.contains("class ")
        || trimmed.contains("def ")
        || trimmed.contains("return ")
        || (trimmed.contains('{') && trimmed.contains('}'))
        || (trimmed.contains("=>") && trimmed.contains(';'))
    {
        return "code".to_string();
    }
    "text".to_string()
}

fn image_to_base64_png(img: &tauri::image::Image) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    use base64::Engine;
    use image::codecs::png::PngEncoder;
    use image::ImageEncoder;

    let width = img.width();
    let height = img.height();
    let rgba = img.rgba();

    let mut png_bytes = Vec::new();
    let encoder = PngEncoder::new(&mut png_bytes);
    encoder.write_image(rgba, width, height, image::ExtendedColorType::Rgba8)?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    Ok(format!("data:image/png;base64,{}", b64))
}

pub fn start_clipboard_monitor(app: AppHandle) {
    load_history_from_disk(&app);

    std::thread::spawn(move || {
        unsafe {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let mut last_seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let cur_seq = unsafe { GetClipboardSequenceNumber() };
            if cur_seq != last_seq && cur_seq != 0 {
                last_seq = cur_seq;

                // Ignore clipboard changes triggered by Bloom itself clicking an item
                let now_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let last_self = LAST_SELF_WRITE_TIME_MS.load(Ordering::SeqCst);
                if now_ms.saturating_sub(last_self) < 1500 {
                    continue;
                }
                let self_seq = LAST_SELF_WRITE_SEQ.load(Ordering::SeqCst);
                if cur_seq == self_seq {
                    continue;
                }

                // Give the copying application 50ms to finish closing the clipboard
                std::thread::sleep(std::time::Duration::from_millis(50));

                // 1. Try reading text first
                let mut captured = false;
                for _ in 0..3 {
                    if let Some(text) = read_clipboard_text_win32().or_else(|| app.clipboard().read_text().ok()) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() && trimmed.len() <= 50_000 {
                            let mut history = CLIPBOARD_HISTORY.lock().unwrap();
                            let now = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs();
                            let kind = classify_text(&text);
                            let item = ClipboardItem {
                                id: format!("{}-{}", now, cur_seq),
                                content: text.clone(),
                                kind,
                                timestamp: now,
                                width: None,
                                height: None,
                            };

                            // Remove existing duplicate anywhere in history by trimmed content
                            history.retain(|i| i.content.trim() != trimmed);
                            history.insert(0, item);
                            if history.len() > 16 {
                                history.truncate(16);
                            }
                            let cloned = history.clone();
                            drop(history);
                            save_history_to_disk(&app, &cloned);
                            let _ = app.emit("clipboard-update", cloned);
                            captured = true;
                            break;
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }

                // 2. If no text captured, try reading image
                if !captured {
                    for _ in 0..3 {
                        if let Ok(img) = app.clipboard().read_image() {
                            let width = img.width();
                            let height = img.height();
                            if width > 0 && height > 0 {
                                if let Ok(data_url) = image_to_base64_png(&img) {
                                    let mut history = CLIPBOARD_HISTORY.lock().unwrap();
                                    let now = SystemTime::now()
                                        .duration_since(UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_secs();
                                    let item = ClipboardItem {
                                        id: format!("{}-{}", now, cur_seq),
                                        content: data_url.clone(),
                                        kind: "image".to_string(),
                                        timestamp: now,
                                        width: Some(width),
                                        height: Some(height),
                                    };

                                    // Deduplicate images by exact content OR matching dimensions with close data length
                                    history.retain(|i| {
                                        if i.kind != "image" {
                                            return true;
                                        }
                                        if i.content == data_url {
                                            return false;
                                        }
                                        if i.width == Some(width) && i.height == Some(height) {
                                            let diff = (i.content.len() as i64 - data_url.len() as i64).abs();
                                            if diff < 128 {
                                                return false;
                                            }
                                        }
                                        true
                                    });
                                    history.insert(0, item);
                                    if history.len() > 16 {
                                        history.truncate(16);
                                    }
                                    let cloned = history.clone();
                                    drop(history);
                                    save_history_to_disk(&app, &cloned);
                                    let _ = app.emit("clipboard-update", cloned);
                                    break;
                                }
                            }
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                }
            }
        }
    });
}

#[tauri::command]
pub fn get_clipboard_history() -> Vec<ClipboardItem> {
    CLIPBOARD_HISTORY.lock().unwrap().clone()
}

#[tauri::command]
pub fn clear_clipboard_history(app: AppHandle) -> bool {
    let mut history = CLIPBOARD_HISTORY.lock().unwrap();
    history.clear();
    drop(history);
    save_history_to_disk(&app, &[]);
    let _ = app.emit("clipboard-update", Vec::<ClipboardItem>::new());
    true
}

#[tauri::command]
pub fn remove_clipboard_item(app: AppHandle, id: String) -> bool {
    let mut history = CLIPBOARD_HISTORY.lock().unwrap();
    history.retain(|item| item.id != id);
    let cloned = history.clone();
    drop(history);
    save_history_to_disk(&app, &cloned);
    let _ = app.emit("clipboard-update", cloned);
    true
}

#[tauri::command]
pub fn copy_clipboard_item(app: AppHandle, id: String) -> Result<bool, String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    LAST_SELF_WRITE_TIME_MS.store(now_ms, Ordering::SeqCst);

    let item = {
        let history = CLIPBOARD_HISTORY.lock().unwrap();
        history.iter().find(|i| i.id == id).cloned()
    };

    let item = match item {
        Some(it) => it,
        None => return Err("Item not found".to_string()),
    };

    if item.kind == "image" {
        use base64::Engine;
        let prefix = "data:image/png;base64,";
        let b64_str = if item.content.starts_with(prefix) {
            &item.content[prefix.len()..]
        } else {
            &item.content
        };

        let png_bytes = base64::engine::general_purpose::STANDARD
            .decode(b64_str)
            .map_err(|e| e.to_string())?;

        let dyn_img = image::load_from_memory(&png_bytes).map_err(|e| e.to_string())?;
        let rgba_img = dyn_img.to_rgba8();
        let (w, h) = rgba_img.dimensions();
        let tauri_img = tauri::image::Image::new_owned(rgba_img.into_raw(), w, h);

        app.clipboard()
            .write_image(&tauri_img)
            .map_err(|e| e.to_string())?;
    } else {
        app.clipboard()
            .write_text(item.content)
            .map_err(|e| e.to_string())?;
    }

    // Suppress re-capturing our own write into the history
    let new_seq = unsafe { GetClipboardSequenceNumber() };
    LAST_SELF_WRITE_SEQ.store(new_seq, Ordering::SeqCst);
    let now_ms_after = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    LAST_SELF_WRITE_TIME_MS.store(now_ms_after, Ordering::SeqCst);

    Ok(true)
}

fn read_clipboard_text_win32() -> Option<String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    unsafe {
        // CF_UNICODETEXT = 13
        if OpenClipboard(None).is_ok() {
            let handle = GetClipboardData(13);
            let res = if let Ok(h) = handle {
                if !h.0.is_null() {
                    let ptr = GlobalLock(windows::Win32::Foundation::HGLOBAL(h.0)) as *const u16;
                    if !ptr.is_null() {
                        let mut len = 0;
                        while *ptr.add(len) != 0 {
                            len += 1;
                        }
                        let slice = std::slice::from_raw_parts(ptr, len);
                        let s = String::from_utf16_lossy(slice);
                        let _ = GlobalUnlock(windows::Win32::Foundation::HGLOBAL(h.0));
                        Some(s)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };
            let _ = CloseClipboard();
            res
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "live clipboard state depends on current Windows clipboard"]
    fn test_win32_clipboard() {
        let text = read_clipboard_text_win32();
        println!("READ TEXT: {:?}", text);
    }
}
