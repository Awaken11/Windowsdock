use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};
use windows::core::HSTRING;
use windows::UI::Notifications::Management::{
    UserNotificationListener, UserNotificationListenerAccessStatus,
};
use windows::UI::Notifications::{NotificationBinding, NotificationKinds};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AppNotification {
    pub id: u32,
    pub app_name: String,
    pub app_id: String,
    pub title: String,
    pub body: String,
    pub timestamp: u64,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static LISTENER_INITIALIZED: AtomicBool = AtomicBool::new(false);
static NEXT_CUSTOM_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(100_000);

pub fn setup_notifications(app: AppHandle) {
    let _ = APP.set(app.clone());
    if LISTENER_INITIALIZED.swap(true, Ordering::SeqCst) {
        return;
    }

    // 1. Windows Action Center / Toast notifications (WhatsApp, Telegram, Discord, etc.)
    let app_clone1 = app.clone();
    std::thread::spawn(move || {
        let _ = run_notification_monitor(app_clone1);
    });

    // 2. Local HTTP webhook on 127.0.0.1:14210 (For Antigravity, Claude, CLI scripts)
    let app_clone2 = app.clone();
    std::thread::spawn(move || {
        run_local_webhook_listener(app_clone2);
    });

    // 3. WinEvent hook for background window flash / alert (Terminal, Claude, IDE)
    setup_window_alert_hook();

    // 4. Real-time Antigravity Assistant monitor (detects when chat response is ready or asks a question)
    let app_clone4 = app.clone();
    std::thread::spawn(move || {
        run_antigravity_monitor(app_clone4);
    });

    // 5. Real-time Claude Assistant monitor (detects when Claude Code finishes or asks for input)
    let app_clone5 = app.clone();
    std::thread::spawn(move || {
        run_claude_monitor(app_clone5);
    });
}

fn run_notification_monitor(app: AppHandle) -> windows::core::Result<()> {
    unsafe {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let listener = UserNotificationListener::Current()?;
    let access = listener.RequestAccessAsync()?.get()?;
    if access != UserNotificationListenerAccessStatus::Allowed {
        eprintln!("[Notifications] Windows UserNotificationListener access status: {:?}", access);
        return Ok(());
    }

    let mut last_seen_ids = std::collections::HashSet::new();

    // Populate existing notification IDs so we don't alert for old notifications on launch
    if let Ok(initial_list) = listener.GetNotificationsAsync(NotificationKinds::Toast) {
        if let Ok(notifs) = initial_list.get() {
            if let Ok(size) = notifs.Size() {
                for i in 0..size {
                    if let Ok(n) = notifs.GetAt(i) {
                        if let Ok(id) = n.Id() {
                            last_seen_ids.insert(id);
                        }
                    }
                }
            }
        }
    }

    loop {
        std::thread::sleep(std::time::Duration::from_millis(600));

        let notifs_async = match listener.GetNotificationsAsync(NotificationKinds::Toast) {
            Ok(op) => op,
            Err(_) => continue,
        };

        let notifs = match notifs_async.get() {
            Ok(list) => list,
            Err(_) => continue,
        };

        let size = notifs.Size().unwrap_or(0);
        let mut current_ids = std::collections::HashSet::new();

        for i in 0..size {
            let n = match notifs.GetAt(i) {
                Ok(item) => item,
                Err(_) => continue,
            };

            let id = match n.Id() {
                Ok(val) => val,
                Err(_) => continue,
            };

            current_ids.insert(id);

            // If this is a new notification we haven't seen yet:
            if !last_seen_ids.contains(&id) {
                last_seen_ids.insert(id);

                let app_info = n.AppInfo().ok();
                let app_name = app_info
                    .as_ref()
                    .and_then(|info| info.DisplayInfo().ok())
                    .and_then(|disp| disp.DisplayName().ok())
                    .map(|h| h.to_string())
                    .unwrap_or_else(|| "App".to_string());

                let app_id = app_info
                    .as_ref()
                    .and_then(|info| info.Id().ok())
                    .map(|h| h.to_string())
                    .unwrap_or_default();

                let mut title = String::new();
                let mut body = String::new();

                if let Ok(notif) = n.Notification() {
                    if let Ok(visual) = notif.Visual() {
                        let toast_template = HSTRING::from("ToastGeneric");
                        if let Ok(binding) = visual.GetBinding(&toast_template) {
                            extract_binding_text(&binding, &mut title, &mut body);
                        } else if let Ok(bindings) = visual.Bindings() {
                            if let Ok(b_size) = bindings.Size() {
                                for b_idx in 0..b_size {
                                    if let Ok(b) = bindings.GetAt(b_idx) {
                                        extract_binding_text(&b, &mut title, &mut body);
                                        if !title.is_empty() || !body.is_empty() {
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                if title.is_empty() && body.is_empty() {
                    title = format!("New message from {}", app_name);
                } else if title.is_empty() {
                    title = app_name.clone();
                }

                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();

                let payload = AppNotification {
                    id,
                    app_name,
                    app_id,
                    title,
                    body,
                    timestamp: now,
                };

                let _ = app.emit("app-notification", payload);
            }
        }

        // Clean up last_seen_ids for dismissed notifications
        last_seen_ids.retain(|id| current_ids.contains(id));
    }
}

fn extract_binding_text(binding: &NotificationBinding, title: &mut String, body: &mut String) {
    if let Ok(texts) = binding.GetTextElements() {
        if let Ok(t_size) = texts.Size() {
            if t_size > 0 {
                if let Ok(t0) = texts.GetAt(0) {
                    if let Ok(txt) = t0.Text() {
                        *title = txt.to_string();
                    }
                }
            }
            if t_size > 1 {
                if let Ok(t1) = texts.GetAt(1) {
                    if let Ok(txt) = t1.Text() {
                        *body = txt.to_string();
                    }
                }
            }
        }
    }
}

/// Local HTTP listener on port 14210 so any developer agent (Antigravity, Claude Code, bash scripts)
/// can instantly notify the Notch with:
/// curl -X POST http://localhost:14210/notify -d '{"app":"Claude","title":"Response Ready","body":"Please check the output"}'
fn run_local_webhook_listener(app: AppHandle) {
    let listener = match TcpListener::bind("127.0.0.1:14210") {
        Ok(l) => l,
        Err(_) => return,
    };

    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };

        let mut buf = [0u8; 4096];
        if let Ok(n) = stream.read(&mut buf) {
            let req = String::from_utf8_lossy(&buf[..n]);
            if req.starts_with("POST /notify") || req.starts_with("POST /api/notify") {
                if let Some(pos) = req.find("\r\n\r\n") {
                    let body_str = &req[pos + 4..];
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(body_str) {
                        let app_name = val.get("app")
                            .or_else(|| val.get("app_name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("Antigravity")
                            .to_string();

                        let title = val.get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Action Required")
                            .to_string();

                        let body = val.get("body")
                            .or_else(|| val.get("message"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        let app_id = val.get("app_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        let id = NEXT_CUSTOM_ID.fetch_add(1, Ordering::SeqCst);
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();

                        let notif = AppNotification {
                            id,
                            app_name,
                            app_id,
                            title,
                            body,
                            timestamp: now,
                        };

                        let _ = app.emit("app-notification", notif);
                        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"ok\":true}\r\n";
                        let _ = stream.write_all(response.as_bytes());
                        continue;
                    }
                }
            }
            let not_found = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(not_found.as_bytes());
        }
    }
}

static LAST_ALERT_TIME: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

fn setup_window_alert_hook() {
    unsafe {
        use windows::Win32::UI::Accessibility::SetWinEventHook;
        use windows::Win32::UI::WindowsAndMessaging::{
            EVENT_SYSTEM_ALERT, WINEVENT_OUTOFCONTEXT,
        };

        let hook = SetWinEventHook(
            EVENT_SYSTEM_ALERT,
            EVENT_SYSTEM_ALERT,
            None,
            Some(window_alert_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        Box::leak(Box::new(hook));
    }
}

unsafe extern "system" fn window_alert_proc(
    _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
    _event: u32,
    hwnd: windows::Win32::Foundation::HWND,
    id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if hwnd.0.is_null() || id_object != 0 {
        return;
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Debounce alerts to once per 2 seconds
    let last = LAST_ALERT_TIME.load(Ordering::Relaxed);
    if now_ms - last < 2000 {
        return;
    }
    LAST_ALERT_TIME.store(now_ms, Ordering::Relaxed);

    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};
    let fg = GetForegroundWindow();
    if fg == hwnd {
        // App is already focused, no need to alert
        return;
    }

    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return;
    }

    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut buf);
    let title = if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::new()
    };

    let (proc_name, app_display) = get_proc_and_display_name(pid);

    let lower_proc = proc_name.to_lowercase();
    let lower_title = title.to_lowercase();

    // Check if this is a developer tool, terminal, or communication app
    let is_relevant = lower_proc.contains("antigravity")
        || lower_proc.contains("code")
        || lower_proc.contains("claude")
        || lower_proc.contains("whatsapp")
        || lower_proc.contains("telegram")
        || lower_proc.contains("discord")
        || lower_proc.contains("slack")
        || lower_proc.contains("terminal")
        || lower_proc.contains("windowsterminal")
        || lower_proc.contains("pwsh")
        || lower_proc.contains("cmd")
        || lower_title.contains("claude")
        || lower_title.contains("antigravity")
        || lower_title.contains("waiting");

    if is_relevant {
        if let Some(app) = APP.get() {
            let id = NEXT_CUSTOM_ID.fetch_add(1, Ordering::SeqCst);
            let notif_title = if !title.is_empty() {
                title
            } else {
                format!("{} Needs Attention", app_display)
            };

            let body = if lower_proc.contains("antigravity") || lower_proc.contains("code") {
                "Agent is waiting for your input".to_string()
            } else if lower_proc.contains("claude") {
                "Claude finished responding or needs your input".to_string()
            } else {
                "Click to switch to window".to_string()
            };

            let notif = AppNotification {
                id,
                app_name: app_display,
                app_id: format!("hwnd:{}", hwnd.0 as isize),
                title: notif_title,
                body,
                timestamp: (now_ms / 1000) as u64,
            };

            let _ = app.emit("app-notification", notif);
        }
    }
}

fn get_proc_and_display_name(pid: u32) -> (String, String) {
    unsafe {
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut pe = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut pe).is_ok() {
                loop {
                    if pe.th32ProcessID == pid {
                        let len = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(pe.szExeFile.len());
                        let name = String::from_utf16_lossy(&pe.szExeFile[..len]);
                        let lower_name = name.to_lowercase();
                        let display = if lower_name.contains("antigravity") || lower_name.contains("code") {
                            "Antigravity".to_string()
                        } else if lower_name.contains("claude") {
                            "Claude".to_string()
                        } else if lower_name.contains("windowsterminal") || lower_name.contains("pwsh") {
                            "Terminal".to_string()
                        } else {
                            name.trim_end_matches(".exe").to_string()
                        };
                        use windows::Win32::Foundation::CloseHandle;
                        let _ = CloseHandle(snap);
                        return (name, display);
                    }
                    if Process32NextW(snap, &mut pe).is_err() {
                        break;
                    }
                }
            }
            use windows::Win32::Foundation::CloseHandle;
            let _ = CloseHandle(snap);
        }
    }
    ("unknown".to_string(), "Application".to_string())
}

pub fn find_window_by_name(app_name: &str, app_id: &str) -> Option<isize> {
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        };
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM};

        struct SearchData {
            needle_app: String,
            needle_id: String,
            found_hwnd: Option<isize>,
        }

        let mut data = SearchData {
            needle_app: app_name.to_lowercase(),
            needle_id: app_id.to_lowercase(),
            found_hwnd: None,
        };

        unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let data = &mut *(lparam.0 as *mut SearchData);
            if !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }

            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return BOOL(1);
            }

            let (proc_name, _) = get_proc_and_display_name(pid);
            let lower_proc = proc_name.to_lowercase();

            let mut buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut buf);
            let title = if len > 0 {
                String::from_utf16_lossy(&buf[..len as usize]).to_lowercase()
            } else {
                String::new()
            };

            let matches = (!data.needle_app.is_empty() && (lower_proc.contains(&data.needle_app) || title.contains(&data.needle_app)))
                || (!data.needle_id.is_empty() && (lower_proc.contains(&data.needle_id) || title.contains(&data.needle_id)));

            if matches {
                data.found_hwnd = Some(hwnd.0 as isize);
                return BOOL(0); // Stop enumerating
            }
            BOOL(1)
        }

        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut data as *mut _ as isize));
        data.found_hwnd
    }
}

#[tauri::command]
pub async fn focus_notification_app(app: AppHandle, app_name: String, app_id: String) {
    if let Some(hwnd_str) = app_id.strip_prefix("hwnd:") {
        if let Ok(val) = hwnd_str.parse::<isize>() {
            let _ = crate::commands::focus_window(app.clone(), val).await;
            return;
        }
    }

    if let Some(hwnd) = find_window_by_name(&app_name, &app_id) {
        let _ = crate::commands::focus_window(app.clone(), hwnd).await;
        return;
    }

    if !app_id.is_empty() && !app_id.starts_with("hwnd:") {
        crate::commands::open_app(app.clone(), app_id).await;
        return;
    }

    crate::commands::open_app(app, app_name).await;
}

#[tauri::command]
pub fn dismiss_notification(id: u32) -> bool {
    std::thread::spawn(move || {
        if let Ok(listener) = UserNotificationListener::Current() {
            let _ = listener.RemoveNotification(id);
        }
    });
    true
}

#[allow(dead_code)]
fn is_antigravity_foreground() -> bool {
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return false;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        if pid == 0 {
            return false;
        }
        let (proc_name, _) = get_proc_and_display_name(pid);
        proc_name.to_lowercase().contains("antigravity")
    }
}

fn find_newest_transcript(brain_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut newest_time = std::time::UNIX_EPOCH;
    let mut newest_path = None;

    if let Ok(entries) = std::fs::read_dir(brain_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                let candidate = entry.path().join(".system_generated").join("logs").join("transcript.jsonl");
                if candidate.exists() {
                    if let Ok(meta) = candidate.metadata() {
                        if let Ok(mod_time) = meta.modified() {
                            if mod_time > newest_time {
                                newest_time = mod_time;
                                newest_path = Some(candidate);
                            }
                        }
                    }
                }
            }
        }
    }
    newest_path
}

fn clean_content_preview(content: &str) -> String {
    let mut clean = String::with_capacity(120);
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.starts_with("```") || trimmed.is_empty() {
            continue;
        }
        if !clean.is_empty() {
            clean.push(' ');
        }
        clean.push_str(trimmed);
        if clean.len() >= 100 {
            break;
        }
    }
    if clean.is_empty() {
        return "Response complete. Ready for review.".to_string();
    }
    if clean.chars().count() > 100 {
        let truncated: String = clean.chars().take(97).collect();
        format!("{}...", truncated)
    } else {
        clean
    }
}

fn run_antigravity_monitor(app: AppHandle) {
    let user_profile = match std::env::var("USERPROFILE") {
        Ok(p) => std::path::PathBuf::from(p),
        Err(_) => return,
    };
    let brain_dir = user_profile.join(".gemini").join("antigravity").join("brain");
    if !brain_dir.exists() {
        return;
    }

    let mut last_file: Option<std::path::PathBuf> = None;
    let mut last_offset: u64 = 0;
    let mut last_notified_step: Option<u64> = None;

    loop {
        std::thread::sleep(std::time::Duration::from_millis(800));

        let newest = find_newest_transcript(&brain_dir);
        let current_file = match newest {
            Some(f) => f,
            None => continue,
        };

        if last_file.as_ref() != Some(&current_file) {
            last_file = Some(current_file.clone());
            if let Ok(meta) = std::fs::metadata(&current_file) {
                last_offset = meta.len();
            }
            continue;
        }

        let meta = match std::fs::metadata(&current_file) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if meta.len() <= last_offset {
            continue;
        }

        use std::io::{BufRead, BufReader, Seek, SeekFrom};
        let file = match std::fs::File::open(&current_file) {
            Ok(f) => f,
            Err(_) => continue,
        };

        let mut reader = BufReader::new(file);
        if reader.seek(SeekFrom::Start(last_offset)).is_err() {
            continue;
        }

        let mut line = String::new();
        while let Ok(bytes_read) = reader.read_line(&mut line) {
            if bytes_read == 0 {
                break;
            }
            if !line.ends_with('\n') {
                break;
            }
            last_offset += bytes_read as u64;

            let trimmed = line.trim();
            if trimmed.is_empty() {
                line.clear();
                continue;
            }

            if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let typ = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let source = val.get("source").and_then(|v| v.as_str()).unwrap_or("");
                let status = val.get("status").and_then(|v| v.as_str()).unwrap_or("");

                if source == "MODEL" && typ == "PLANNER_RESPONSE" && status == "DONE" {
                    let step_index = val.get("step_index").and_then(|v| v.as_u64());
                    if step_index == last_notified_step {
                        line.clear();
                        continue;
                    }

                    let tool_calls = val.get("tool_calls").and_then(|v| v.as_array());
                    let has_tools = tool_calls.map(|arr| !arr.is_empty()).unwrap_or(false);
                    let has_ask_question = tool_calls
                        .map(|arr| {
                            arr.iter().any(|tc| {
                                tc.get("name").and_then(|n| n.as_str()) == Some("ask_question")
                            })
                        })
                        .unwrap_or(false);

                    if has_ask_question || !has_tools {
                        last_notified_step = step_index;
                        let content = val.get("content").and_then(|v| v.as_str()).unwrap_or("");
                        let preview = if has_ask_question {
                            "Antigravity has a question for you".to_string()
                        } else if !content.is_empty() {
                            clean_content_preview(content)
                        } else {
                            "Task completed. Ready for your input.".to_string()
                        };

                        let notif = AppNotification {
                            id: NEXT_CUSTOM_ID.fetch_add(1, Ordering::SeqCst),
                            app_name: "Antigravity".to_string(),
                            app_id: "Antigravity IDE".to_string(),
                            title: if has_ask_question {
                                "Antigravity Question".to_string()
                            } else {
                                "Antigravity Response Ready".to_string()
                            },
                            body: preview,
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs(),
                        };

                        let _ = app.emit("app-notification", notif);
                    }
                }
            }
            line.clear();
        }
    }
}

fn find_newest_claude_transcript(claude_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let projects_dir = claude_dir.join("projects");
    if !projects_dir.exists() {
        return None;
    }
    let mut newest_time = std::time::UNIX_EPOCH;
    let mut newest_path = None;

    if let Ok(entries) = std::fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                if let Ok(sub_entries) = std::fs::read_dir(entry.path()) {
                    for sub in sub_entries.flatten() {
                        let path = sub.path();
                        if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                            if let Ok(meta) = path.metadata() {
                                if let Ok(mod_time) = meta.modified() {
                                    if mod_time > newest_time {
                                        newest_time = mod_time;
                                        newest_path = Some(path);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    newest_path
}

fn run_claude_monitor(app: AppHandle) {
    let user_profile = match std::env::var("USERPROFILE") {
        Ok(p) => std::path::PathBuf::from(p),
        Err(_) => return,
    };
    let claude_dir = user_profile.join(".claude");
    if !claude_dir.exists() {
        return;
    }

    let mut last_file: Option<std::path::PathBuf> = None;
    let mut last_offset: u64 = 0;
    let mut last_notified_id: Option<String> = None;

    loop {
        std::thread::sleep(std::time::Duration::from_millis(800));

        let newest = find_newest_claude_transcript(&claude_dir);
        let current_file = match newest {
            Some(f) => f,
            None => continue,
        };

        if last_file.as_ref() != Some(&current_file) {
            last_file = Some(current_file.clone());
            if let Ok(meta) = std::fs::metadata(&current_file) {
                last_offset = meta.len();
            }
            continue;
        }

        let meta = match std::fs::metadata(&current_file) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if meta.len() <= last_offset {
            continue;
        }

        use std::io::{BufRead, BufReader, Seek, SeekFrom};
        let file = match std::fs::File::open(&current_file) {
            Ok(f) => f,
            Err(_) => continue,
        };

        let mut reader = BufReader::new(file);
        if reader.seek(SeekFrom::Start(last_offset)).is_err() {
            continue;
        }

        let mut line = String::new();
        while let Ok(bytes_read) = reader.read_line(&mut line) {
            if bytes_read == 0 {
                break;
            }
            if !line.ends_with('\n') {
                break;
            }
            last_offset += bytes_read as u64;

            let trimmed = line.trim();
            if trimmed.is_empty() {
                line.clear();
                continue;
            }

            if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let typ = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if typ == "cost-state" || typ == "last-prompt" {
                    let session_id = val.get("sessionId").and_then(|v| v.as_str()).unwrap_or("claude");
                    let leaf_id = val
                        .get("leafUuid")
                        .or_else(|| val.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(session_id);

                    if last_notified_id.as_deref() == Some(leaf_id) {
                        line.clear();
                        continue;
                    }
                    last_notified_id = Some(leaf_id.to_string());

                    let notif = AppNotification {
                        id: NEXT_CUSTOM_ID.fetch_add(1, Ordering::SeqCst),
                        app_name: "Claude".to_string(),
                        app_id: "Claude".to_string(),
                        title: "Claude Response Ready".to_string(),
                        body: "Task completed. Ready for your input.".to_string(),
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    };

                    let _ = app.emit("app-notification", notif);
                } else if typ == "assistant" {
                    if let Some(msg) = val.get("message") {
                        let stop_reason = msg.get("stop_reason").and_then(|v| v.as_str()).unwrap_or("");
                        let msg_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        if (stop_reason == "end_turn" || stop_reason == "stop") && !msg_id.is_empty() {
                            if last_notified_id.as_deref() == Some(msg_id) {
                                line.clear();
                                continue;
                            }
                            last_notified_id = Some(msg_id.to_string());

                            let mut preview = String::new();
                            if let Some(content_arr) = msg.get("content").and_then(|c| c.as_array()) {
                                for item in content_arr {
                                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                                        if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                                            preview = clean_content_preview(t);
                                            break;
                                        }
                                    }
                                }
                            }
                            if preview.is_empty() {
                                preview = "Response complete. Ready for review.".to_string();
                            }

                            let notif = AppNotification {
                                id: NEXT_CUSTOM_ID.fetch_add(1, Ordering::SeqCst),
                                app_name: "Claude".to_string(),
                                app_id: "Claude".to_string(),
                                title: "Claude Response Ready".to_string(),
                                body: preview,
                                timestamp: std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs(),
                            };

                            let _ = app.emit("app-notification", notif);
                        }
                    }
                }
            }
            line.clear();
        }
    }
}
