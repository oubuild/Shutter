//! Tauri command surface exposed to the webview.

use crate::types::{
    AiAction, AiRequest, CaptureAction, CaptureResult, CaptureSession, Rect, Settings,
};
use crate::{ai, compose, output, overlay, pin, settings, windows};
use anyhow::Result;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

/// Take a fresh screenshot of every monitor and return the session descriptor.
///
/// Creating the session also captures the frames, so the overlay window can be
/// shown immediately without a second capture (which would flicker).
pub async fn start_capture(app: &AppHandle) -> Result<CaptureSession> {
    let store: State<'_, Arc<crate::session::Store>> = app.state();

    // Tear down any previous overlay BEFORE capturing, otherwise the new frame
    // would contain the old overlay.
    overlay::destroy_all(app);
    // Give macOS a beat to remove the windows from the window server.
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;

    // Enumerate and capture in one synchronous step. `capture_all` returns
    // plain data only, so nothing `!Send` (an `xcap::Monitor` wraps a raw
    // `HMONITOR` on Windows) reaches the managed store; see `session::Session`.
    let (monitors, frames) = crate::capture::capture_all()?;
    if monitors.is_empty() {
        anyhow::bail!("没有检测到可用的显示器");
    }

    // Capture first, then build the windows: the frames stay clean and the
    // overlay never races the capture.
    let session = store.begin(monitors.clone(), frames);

    let frame_dir = settings::app_dir()?.join("frames");
    for info in &monitors {
        store.write_frame_png(info.id, &frame_dir)?;
    }
    crate::session::Store::prune_frames(&frame_dir, &session.id);

    for info in &monitors {
        let win = overlay::create(app, info.id, info.x, info.y, info.width, info.height)?;
        overlay::reveal(&win)?;
    }

    let session_id = session.id.clone();
    app.emit("capture://ready", &session_id)?;
    log::info!(
        "capture session {session_id} ready with {} overlay(s): {:?}",
        monitors.len(),
        app.webview_windows().keys().cloned().collect::<Vec<_>>()
    );

    Ok(CaptureSession { session_id, monitors })
}

#[tauri::command]
pub async fn capture_screens(app: AppHandle) -> std::result::Result<CaptureSession, String> {
    start_capture(&app).await.map_err(|e| format!("{e:#}"))
}

/// Descriptor of the session that is currently active, if any.
///
/// Overlay windows call this on mount instead of taking a fresh screenshot:
/// capturing again would include the overlay itself in the frame.
#[tauri::command]
pub fn current_session(app: AppHandle) -> Option<CaptureSession> {
    let store: State<'_, Arc<crate::session::Store>> = app.state();
    let session = store.current()?;
    Some(CaptureSession {
        session_id: session.id.clone(),
        monitors: session.monitors.clone(),
    })
}

/// Debug-only: open one of the auxiliary windows by view name.
#[cfg(feature = "debug-hooks")]
#[tauri::command]
pub fn debug_open_view(app: AppHandle, view: String) -> std::result::Result<(), String> {
    match view.as_str() {
        "settings" => windows::open_settings(&app).map_err(|e| format!("{e:#}")),
        "gallery" | "main" => windows::open_main(&app, "gallery")
            .map(|_| ())
            .map_err(|e| format!("{e:#}")),
        "about" => windows::open_main(&app, "about")
            .map(|_| ())
            .map_err(|e| format!("{e:#}")),
        "chat" => windows::open_chat(&app, None, None).map_err(|e| format!("{e:#}")),
        other => Err(format!("unknown view {other}")),
    }
}

/// Debug-only: open a plain window to compare against the overlay window.
#[cfg(feature = "debug-hooks")]
#[tauri::command]
pub fn debug_plain_window(app: AppHandle) -> std::result::Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if app.get_webview_window("plain").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "plain", WebviewUrl::App("index.html?view=settings".into()))
        .title("plain test")
        .inner_size(500.0, 400.0)
        .position(200.0, 200.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Frontend reports its boot state; logged so a terminal can see whether the
/// webview actually executed any JavaScript. Compiled out of release builds.
#[tauri::command]
pub fn debug_report(stage: String, detail: String) {
    #[cfg(feature = "debug-hooks")]
    log::info!("[fe] {stage}: {detail}");
    #[cfg(not(feature = "debug-hooks"))]
    let _ = (stage, detail);
}

/// Absolute path of the frozen frame for a monitor, for `convertFileSrc`.
#[tauri::command]
pub fn frame_path(app: AppHandle, monitor_id: u32, session_id: String) -> Option<String> {
    let dir = settings::app_dir().ok()?.join("frames");
    let path = dir.join(format!("frame-{session_id}-{monitor_id}.png"));
    if !path.exists() {
        log::warn!("frame file missing: {}", path.display());
        return None;
    }
    let _ = app.asset_protocol_scope().allow_file(&path);
    Some(path.display().to_string())
}

/// Close every overlay without producing an image.
#[tauri::command]
pub fn cancel_capture(app: AppHandle) -> std::result::Result<(), String> {
    overlay::destroy_all(&app);
    app.state::<Arc<crate::session::Store>>().clear();
    let _ = app.emit("capture://cancelled", ());
    Ok(())
}

/// Crop the active session and perform the requested action.
///
/// `overlay_data_url` is the annotation layer rendered by the webview; it is
/// merged over the crop before anything is written.
#[tauri::command]
pub async fn confirm_capture(
    app: AppHandle,
    monitor_id: u32,
    rect: Rect,
    action: CaptureAction,
    overlay_data_url: Option<String>,
) -> std::result::Result<CaptureResult, String> {
    do_confirm(app, monitor_id, rect, action, overlay_data_url)
        .await
        .map_err(|e| format!("{e:#}"))
}

async fn do_confirm(
    app: AppHandle,
    monitor_id: u32,
    rect: Rect,
    action: CaptureAction,
    overlay_data_url: Option<String>,
) -> Result<CaptureResult> {
    let store: State<'_, Arc<crate::session::Store>> = app.state();
    let session = store
        .current()
        .ok_or_else(|| anyhow::anyhow!("截图会话已结束，请重新截图"))?;

    let frame = session
        .frame(monitor_id)
        .ok_or_else(|| anyhow::anyhow!("找不到显示器 {monitor_id} 的画面"))?
        .clone();
    let scale = session
        .monitor(monitor_id)
        .ok_or_else(|| anyhow::anyhow!("找不到显示器 {monitor_id}"))?
        .scale_factor;

    let (fw, fh) = frame.dimensions();
    let pixel_rect = compose::to_pixel_rect(rect, scale, fw, fh)?;
    let cropped = compose::crop(&frame, pixel_rect)?;
    let overlay = compose::decode_overlay(overlay_data_url.as_deref())?;
    let merged = compose::merge_overlay(&cropped, overlay.as_ref());

    // A very large crop would make the IPC preview and the AI payload huge;
    // the full-resolution PNG is what gets saved/copied, the preview is scaled.
    let png = compose::to_png(&merged)?;
    let preview = output::thumbnail(&merged, 900);
    let preview_png = compose::to_png(&preview)?;

    let settings = settings::load_settings();
    let mut message = None;
    let mut saved_path = None;

    // Every capture lands in the gallery by default so the list is a record of
    // what was actually taken, not just what was explicitly saved. ⌘S/Pin imply
    // a save regardless of the setting.
    let explicit_save = action == CaptureAction::Save || action == CaptureAction::Pin;
    if explicit_save || settings.auto_save {
        let dir = settings::save_dir(&settings)?;
        let path = output::save_png(&png, &dir)?;
        saved_path = Some(path.display().to_string());
        message = Some(if explicit_save {
            format!("已保存到 {}", path.display())
        } else {
            "已存入图库".to_string()
        });
        if action == CaptureAction::Pin {
            pin::scope_path(&app, &path.display().to_string());
        }
    }

    if action == CaptureAction::Copy
        || (settings.copy_after_capture && action != CaptureAction::Save)
    {
        output::copy_image(&png)?;
        message = Some(match message {
            Some(m) => format!("{m}；已复制到剪贴板"),
            None => "已复制到剪贴板".to_string(),
        });
    }

    let crop_id = store.put_crop(png);
    overlay::destroy_all(&app);

    Ok(CaptureResult {
        crop_id,
        preview_data_url: output::data_url(&preview_png),
        width: merged.width(),
        height: merged.height(),
        message,
        saved_path,
    })
}

/// Start a streaming AI request for an existing crop.
#[tauri::command]
pub async fn ai_ask(
    app: AppHandle,
    request: AiRequest,
    request_id: String,
) -> std::result::Result<(), String> {
    let store: State<'_, Arc<crate::session::Store>> = app.state();
    let png = store.crop(&request.crop_id).map_err(|e| format!("{e:#}"))?;

    let task = ai::AiTask {
        action: request.action,
        lang: request.lang,
        question: request.question,
    };

    // Fire and forget: progress arrives via `ai://delta` and `ai://done`.
    tauri::async_runtime::spawn(async move {
        ai::run(app, request_id, png, task).await;
    });
    Ok(())
}

#[tauri::command]
pub fn ai_actions() -> Vec<&'static str> {
    vec!["extract", "translate", "explain", "ask"]
}

/// Suggested endpoints for the settings window.
#[tauri::command]
pub fn model_presets() -> Vec<crate::types::Preset> {
    crate::types::presets()
}

#[tauri::command]
pub fn get_settings() -> Settings {
    settings::load_settings()
}

#[tauri::command]
pub fn save_settings_cmd(settings: Settings) -> std::result::Result<(), String> {
    settings::save_settings(&settings).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn set_api_key(key: String) -> std::result::Result<(), String> {
    settings::save_api_key(&key).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn clear_api_key() -> std::result::Result<(), String> {
    settings::delete_api_key().map_err(|e| format!("{e:#}"))
}

/// Whether a key is stored; the key itself is never returned.
#[tauri::command]
pub fn api_key_status() -> bool {
    settings::has_api_key()
}

#[tauri::command]
pub fn copy_text_to_clipboard(text: String) -> std::result::Result<(), String> {
    output::copy_text(&text).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> std::result::Result<(), String> {
    windows::open_settings(&app).map_err(|e| format!("{e:#}"))
}

/// Open the main window (gallery + settings + about) on the requested tab.
#[tauri::command]
pub fn open_main_window(app: AppHandle, tab: Option<String>) -> std::result::Result<(), String> {
    windows::open_main(&app, tab.as_deref().unwrap_or("gallery"))
        .map(|_| ())
        .map_err(|e| format!("{e:#}"))
}

/// Every screenshot in the save directory, newest first.
#[tauri::command]
pub fn list_gallery() -> std::result::Result<Vec<crate::types::GalleryItem>, String> {
    let settings = settings::load_settings();
    crate::gallery::list(&settings).map_err(|e| format!("{e:#}"))
}

/// Thumbnail for one gallery item, as a PNG data URL so the webview can show it
/// without the asset protocol or a second round trip per image.
#[tauri::command]
pub fn gallery_thumbnail(path: String) -> std::result::Result<String, String> {
    let settings = settings::load_settings();
    crate::gallery::thumbnail(&settings, &path)
        .map(|png| output::data_url(&png))
        .map_err(|e| format!("{e:#}"))
}

/// Full-resolution PNG of one gallery item as a data URL.
///
/// Used for the preview overlay and for copying to the clipboard: the thumbnail
/// is deliberately small, so neither may reuse it.
#[tauri::command]
pub fn gallery_full_image(path: String) -> std::result::Result<String, String> {
    let settings = settings::load_settings();
    crate::gallery::read_png(&settings, &path)
        .map(|png| output::data_url(&png))
        .map_err(|e| format!("{e:#}"))
}

/// Delete one screenshot. The path is re-validated in Rust: the webview only
/// ever sends a bare file name that must live inside the save directory.
#[tauri::command]
pub fn delete_gallery_item(path: String) -> std::result::Result<(), String> {
    let settings = settings::load_settings();
    crate::gallery::delete(&settings, &path).map_err(|e| format!("{e:#}"))
}

/// Resolved save directory, so the UI can show where files actually go.
#[tauri::command]
pub fn save_directory() -> std::result::Result<String, String> {
    let settings = settings::load_settings();
    settings::save_dir(&settings)
        .map(|dir| dir.display().to_string())
        .map_err(|e| format!("{e:#}"))
}

/// Show a path in Finder/Explorer. Wraps the opener plugin so the frontend does
/// not need its own permission scope for arbitrary paths.
#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> std::result::Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("{e}"))
}

/// Open a directory in the system file manager.
#[tauri::command]
pub fn open_directory(app: AppHandle, path: String) -> std::result::Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| format!("{e}"))
}

/// Ask the user for a directory using the system's native picker.
///
/// Implemented with the OS tooling instead of a dialog plugin: adding a crate
/// requires network access this project's build environment does not have.
#[tauri::command]
pub fn choose_directory() -> std::result::Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"POSIX path of (choose folder with prompt "选择保存截图的目录")"#;
        let output = std::process::Command::new("osascript")
            .args(["-e", script])
            .output()
            .map_err(|e| format!("无法打开目录选择器：{e}"))?;
        if !output.status.success() {
            // A non-zero exit is the user cancelling, which is not an error.
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(if path.is_empty() { None } else { Some(path) });
    }

    #[cfg(target_os = "windows")]
    {
        let script = "\
Add-Type -AssemblyName System.Windows.Forms; \
$d = New-Object System.Windows.Forms.FolderBrowserDialog; \
if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }";
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .map_err(|e| format!("无法打开目录选择器：{e}"))?;
        if !output.status.success() {
            return Ok(None);
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(if path.is_empty() { None } else { Some(path) });
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("当前平台不支持目录选择".to_string())
    }
}

/// Open the AI window, optionally bound to an existing crop.
#[tauri::command]
pub fn open_chat_window(
    app: AppHandle,
    crop_id: Option<String>,
    action: Option<String>,
) -> std::result::Result<(), String> {
    windows::open_chat(&app, crop_id.as_deref(), action.as_deref())
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn close_pin(app: AppHandle, pin_id: String) {
    pin::close(&app, &pin_id);
}

/// Persist a crop to disk on demand (used by the chat window's "save" button).
#[tauri::command]
pub fn save_crop(crop_id: String, app: AppHandle) -> std::result::Result<String, String> {
    let store: State<'_, Arc<crate::session::Store>> = app.state();
    let png = store.crop(&crop_id).map_err(|e| format!("{e:#}"))?;
    let settings = settings::load_settings();
    let dir = settings::save_dir(&settings).map_err(|e| format!("{e:#}"))?;
    let path = output::save_png(&png, &dir).map_err(|e| format!("{e:#}"))?;
    Ok(path.display().to_string())
}

/// The crop's full PNG as a data URL, for pinning an existing crop.
#[tauri::command]
pub fn crop_data_url(crop_id: String, app: AppHandle) -> std::result::Result<String, String> {
    let store: State<'_, Arc<crate::session::Store>> = app.state();
    let png = store.crop(&crop_id).map_err(|e| format!("{e:#}"))?;
    Ok(output::data_url(&png))
}

/// Open a pin window for an already-captured crop.
#[tauri::command]
pub fn pin_crop(crop_id: String, app: AppHandle) -> std::result::Result<(), String> {
    let store: State<'_, Arc<crate::session::Store>> = app.state();
    let info = store.crop_info(&crop_id).map_err(|e| format!("{e:#}"))?;

    // Match the window to the image, capped so a full-screen crop does not
    // create a window larger than the desktop.
    let (sw, sh) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.scale_factor();
            (
                (m.size().width as f64 / s) as f64,
                (m.size().height as f64 / s) as f64,
            )
        })
        .unwrap_or((1440.0, 900.0));
    let scale = (sw * 0.8 / info.width as f64)
        .min(sh * 0.8 / info.height as f64)
        .min(1.0);
    let rect = Rect {
        x: ((sw - info.width as f64 * scale) / 2.0).max(0.0),
        y: ((sh - info.height as f64 * scale) / 2.0).max(0.0),
        width: info.width as f64 * scale,
        height: info.height as f64 * scale,
    };
    pin::ensure(&app, &crop_id, rect).map_err(|e| format!("{e:#}"))?;
    Ok(())
}

/// Which monitor the pointer is on, so a toolbar click can target it.
#[tauri::command]
pub fn action_hint(action: AiAction) -> &'static str {
    match action {
        AiAction::Extract => "提取文字",
        AiAction::Translate => "翻译",
        AiAction::Explain => "解释",
        AiAction::Ask => "提问",
    }
}
