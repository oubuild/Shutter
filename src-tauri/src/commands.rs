//! Tauri command surface exposed to the webview.

use crate::types::{
    AiAction, AiRequest, CaptureAction, CaptureResult, CaptureSession, MonitorInfo, Rect, Settings,
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
    overlay::hide_all(app);

    let displays = crate::capture::displays()?;
    if displays.is_empty() {
        anyhow::bail!("没有检测到可用的显示器");
    }
    let monitors: Vec<MonitorInfo> = displays.iter().map(|d| d.info.clone()).collect();

    // Windows are created hidden, then the frames are captured, then the
    // overlays are revealed. Creating them first avoids a first-paint delay
    // (WKWebView boot takes ~200ms) while still keeping the capture clean of
    // transient windows such as dock magnification.
    for info in &monitors {
        overlay::ensure(app, info.id, info.x, info.y, info.width, info.height)?;
    }

    let session = store.begin(displays)?;

    // Hand the frozen desktop to each overlay as a file: the asset protocol is
    // far cheaper than a multi-megabyte data URL over IPC.
    let frame_dir = settings::app_dir()?.join("frames");
    for info in &monitors {
        store.write_frame_png(info.id, &frame_dir)?;
    }
    crate::session::Store::prune_frames(&frame_dir, &session.id);

    for info in &monitors {
        if let Some(win) = app.get_webview_window(&overlay::label_for(info.id)) {
            overlay::show(&win)?;
        }
    }

    let session_id = session.id.clone();
    app.emit("capture://ready", &session_id)?;

    Ok(CaptureSession {
        session_id,
        monitors,
    })
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
        monitors: session.displays.iter().map(|d| d.info.clone()).collect(),
    })
}

/// Absolute path of the frozen frame for a monitor, for `convertFileSrc`.
#[tauri::command]
pub fn frame_path(app: AppHandle, monitor_id: u32, session_id: String) -> Option<String> {
    let dir = settings::app_dir().ok()?.join("frames");
    let path = dir.join(format!("frame-{session_id}-{monitor_id}.png"));
    if !path.exists() {
        return None;
    }
    let _ = app.asset_protocol_scope().allow_file(&path);
    Some(path.display().to_string())
}

#[tauri::command]
pub async fn capture_screens(app: AppHandle) -> std::result::Result<CaptureSession, String> {
    start_capture(&app).await.map_err(|e| format!("{e:#}"))
}

/// Close every overlay without producing an image.
#[tauri::command]
pub fn cancel_capture(app: AppHandle) -> std::result::Result<(), String> {
    overlay::hide_all(&app);
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
        .display(monitor_id)
        .ok_or_else(|| anyhow::anyhow!("找不到显示器 {monitor_id}"))?
        .info
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

    if action == CaptureAction::Save || action == CaptureAction::Pin {
        let dir = settings::save_dir(&settings)?;
        let path = output::save_png(&png, &dir)?;
        saved_path = Some(path.display().to_string());
        message = Some(format!("已保存到 {}", path.display()));
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
    overlay::hide_all(&app);

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
    let rect = Rect { x: 120.0, y: 120.0, width: 420.0, height: 320.0 };
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
