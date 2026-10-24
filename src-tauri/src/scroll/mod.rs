//! Long-screenshot (scroll-and-stitch) session controller — reference
//! architecture (`report/03-scroll-pipeline.md` §3.1, `assets_scrollScreen`
//! + `index-DwzZEF1Z`):
//!
//! * a **dedicated fullscreen panel** `scroll_screenshot_panel_<id>` opened by
//!   `open_scroll_screenshot_event`, transparent over the *live* screen, where
//!   the user frames/adjust the selection;
//! * a **separate control-bar window** (`recorder_bar_panel`) created when
//!   `start_scroll_screenshot_event` fires, driving pause/resume/save;
//! * a worker thread looping inject → settle → capture → estimate → verify →
//!   append/reject (`拒绝硬拼`, 原地重抓 bounded), publishing the growing PNG to
//!   `ScrollScreenshot/screen_scroll.png` (atomic replace) and
//!   `scroll_screenshot_image_update_event`;
//! * a handshake watchdog: the bar must answer
//!   `scroll_screenshot_bar_panel_loaded` or the session tears itself down.

use crate::scroll::pipeline::{decide, direction_reversed, median_recent, FrameDecision};
use crate::scroll::stitch::Stitcher;
use crate::types::Rect;
use anyhow::{anyhow, Result};
use image::RgbaImage;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub mod autoscroll;
pub mod pipeline;
pub mod stitch;
pub mod types;

use crate::scroll::types::{OpenScroll, SaveScroll, ScrollScreenshotData, StartScroll};

/// Lines per injected wheel step (reference: 每次固定行数, with a watchdog).
const SCROLL_LINES: i32 = 3;

/// Pause between injected steps: enough for a page to settle.
const STEP_INTERVAL: Duration = Duration::from_millis(260);

/// Extra settle time after the last injection before capturing.
const SETTLE: Duration = Duration::from_millis(160);

/// Captures of the same position attempted when alignment fails before giving
/// up on the frame (reference: 原地重抓, bounded).
const MAX_REGRAB: u32 = 3;

/// Consecutive rejected frames before the auto-scroller pauses itself
/// (reference: 拒绝 → 暂停自动滚动).
const MAX_CONSECUTIVE_REJECTS: u32 = 4;

/// Still frames in a row at the bottom that stop the capture loop
/// (reference: 已到达页面底部).
const BOTTOM_STILL_FRAMES: u32 = 6;

/// Height (px) beyond which stitching stops for safety (memory guard).
const MAX_ACCUMULATED_HEIGHT: u32 = 60_000;

/// How long the bar window has to answer the handshake before the session
/// tears down (reference `arm_scroll_bar_handshake_watchdog`).
const BAR_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Reference preview location: `appDataDir/ScrollScreenshot/screen_scroll.png`
/// (`assets_scrollScreen` `Ye`: `await Re(d, "ScrollScreenshot/screen_scroll.png")`).
fn preview_path(_app: &AppHandle) -> Result<std::path::PathBuf> {
    let dir = crate::settings::app_dir()?.join("ScrollScreenshot");
    std::fs::create_dir_all(&dir).map_err(|e| anyhow!("create {}: {e}", dir.display()))?;
    Ok(dir.join("screen_scroll.png"))
}

/// Global pointer position in display points (macOS `CGEventGetLocation`).
#[cfg(target_os = "macos")]
fn mouse_location() -> (f64, f64) {
    use core_graphics::geometry::CGPoint;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventGetLocation() -> CGPoint;
    }
    let p = unsafe { CGEventGetLocation() };
    (p.x, p.y)
}

/// Shared control block: the command surface flips these, the worker reads.
struct Control {
    stop: AtomicBool,
    pause: AtomicBool,
    /// Set once the control bar answered its handshake.
    bar_loaded: AtomicBool,
    /// Worker → command: the finished stitcher, handed over on completion.
    result: Mutex<Option<Stitcher>>,
}

impl Control {
    fn new() -> Self {
        Self {
            stop: AtomicBool::new(false),
            pause: AtomicBool::new(false),
            bar_loaded: AtomicBool::new(false),
            result: Mutex::new(None),
        }
    }
}

static ACTIVE: OnceLock<Mutex<Option<ActiveSession>>> = OnceLock::new();
/// Monotonic session counter (reference `SCROLL_BAR_OWNER_EPOCH`): lets the
/// bar watchdog tell "its" session from a newer one that replaced it.
static EPOCH: AtomicU64 = AtomicU64::new(0);

struct ActiveSession {
    epoch: u64,
    monitor_id: u32,
    panel_label: String,
    /// Seeded geometry for `scroll_screenshot_data`; re-sent when the panel
    /// answers its mount handshake (the initial emit races webview load).
    seeded: ScrollScreenshotData,
    control: Arc<Control>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// User-wheel listener; dropped to stop the thread.
    _listener: Option<crate::scroll::autoscroll::ScrollListener>,
    auto_scroll: bool,
}

fn active() -> &'static Mutex<Option<ActiveSession>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/* ------------------------------------------------------------- panel open */

/// `open_scroll_screenshot_event`: build the fullscreen
/// `scroll_screenshot_panel_<id>` window over the target monitor and park the
/// seeded selection for `scroll_screenshot_data`.
///
/// The overlay closes itself 100ms before this fires, so the panel opens onto
/// the live screen — no frozen frame, unlike the screenshot overlay.
pub fn open_panel(app: &AppHandle, payload: OpenScroll) -> Result<()> {
    // Replace any running session first (reference epoch guard).
    teardown(app);

    let monitor = crate::capture::find_display(payload.monitor_ids)?.info;

    let label = format!("scroll_screenshot_panel_{}", monitor.id);
    if let Some(old) = app.get_webview_window(&label) {
        let _ = old.close();
    }

    log::info!(
        "[长截图] 建面板 {label} @ {} {} {}x{} (选区 {},{} {}x{})",
        monitor.x, monitor.y, monitor.width, monitor.height,
        payload.x, payload.y, payload.bounds_width, payload.bounds_height,
    );
    let _win = crate::windows::layer_window(
        app,
        &label,
        "index.html?view=scrollscreen",
        "Shutter 长截图",
        monitor.x as f64,
        monitor.y as f64,
        monitor.width as f64,
        monitor.height as f64,
        true,
    )?;

    // Park the seeded selection; `panel_loaded` hands it to the webview once
    // its listeners are up (the panel's own handshake event).
    let data = ScrollScreenshotData {
        width: monitor.pixel_width,
        height: monitor.pixel_height,
        monitor_id: monitor.id,
        bounds_width: payload.bounds_width,
        bounds_height: payload.bounds_height,
        x: payload.x,
        y: payload.y,
        selection_scale_factor: payload.selection_scale_factor,
    };
    let epoch = EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    *active().lock().unwrap() = Some(ActiveSession {
        epoch,
        monitor_id: monitor.id,
        panel_label: label,
        seeded: data,
        control: Arc::new(Control::new()),
        worker: Mutex::new(None),
        _listener: None,
        auto_scroll: false,
    });
    Ok(())
}

/// `scroll_screenshot_panel_loaded_event`: the panel's mount handshake. The
/// seeded selection is (re-)sent here — the emit in `open_panel` races the
/// webview load and must be treated as best-effort only.
pub fn panel_loaded(app: &AppHandle) {
    let guard = active().lock().unwrap();
    if let Some(s) = guard.as_ref() {
        log::info!("[长截图] 面板握手完成 → 发送初始数据 ({})", s.panel_label);
        send_panel_data(app, &s.seeded);
    }
}

fn send_panel_data(app: &AppHandle, data: &ScrollScreenshotData) {
    let _ = app.emit("scroll_screenshot_data", data);
}

/// `drawn_scroll_screenshot_event`: the panel finished drawing its selection.
/// Ack with `scroll_screenshot_drawn` → the panel disables free drawing
/// (canDraw=false, reference `ze`'s listener).
pub fn drawn(app: &AppHandle) {
    let _ = app.emit("scroll_screenshot_drawn", ());
}

/* ------------------------------------------------------------- start/stop */

/// `start_scroll_screenshot_event`: begin the capture session and open the
/// control bar.
pub fn start(app: &AppHandle, payload: StartScroll) -> Result<()> {
    let (control, monitor) = {
        let guard = active().lock().unwrap();
        let Some(s) = guard.as_ref() else {
            return Err(anyhow!("长截图面板已关闭，请重新截图"));
        };
        (Arc::clone(&s.control), s.monitor_id)
    };

    let monitor_info = crate::capture::find_display(monitor)?.info;

    // CSS px → physical px for capture. The panel already inset 3px per edge
    // (its `Pe` rejects the untrusted outer ring).
    let rect = Rect {
        x: payload.x,
        y: payload.y,
        width: payload.width,
        height: payload.height,
    };
    let pixel_rect = crate::compose::to_pixel_rect(
        rect,
        payload.scale_factor,
        monitor_info.pixel_width,
        monitor_info.pixel_height,
    )?;

    // Give the compositor a beat so the first frame is clean (the panel is
    // transparent, but the bar window below may still be materialising).
    std::thread::sleep(Duration::from_millis(80));
    let first = capture_region(monitor, &pixel_rect)?;

    // Accessibility check → auto or manual scrolling.
    let capability = crate::scroll::autoscroll::inject_capable();
    let auto_scroll = capability == crate::scroll::autoscroll::InjectCapability::Ok;
    if !auto_scroll {
        log::info!("[长截图] 无辅助功能权限（{capability:?}）→ 手动滚动模式");
    }

    // Listen for the user's own wheel input so manual scrolling pauses cleanly.
    let listener = crate::scroll::autoscroll::ScrollListener::start();
    if listener.is_none() {
        log::warn!("[长截图] 滚动监听器不可用（无辅助功能权限？）");
    }

    let worker_control = Arc::clone(&control);
    let worker_app = app.clone();
    let worker_monitor = monitor_info.clone();
    let worker = std::thread::Builder::new()
        .name("scroll-worker".into())
        .spawn(move || {
            worker_loop(worker_app, worker_monitor, &pixel_rect, first, worker_control, auto_scroll);
        })
        .map_err(|e| anyhow!("启动拼接线程失败: {e}"))?;
    let session_epoch;
    {
        let mut guard = active().lock().unwrap();
        let Some(s) = guard.as_mut() else {
            return Err(anyhow!("长截图面板已关闭，请重新截图"));
        };
        s.auto_scroll = auto_scroll;
        s._listener = listener;
        *s.worker.lock().unwrap() = Some(worker);
        session_epoch = s.epoch;
    }

    // Control bar (reference `recorder_bar_panel`): fresh per session. It
    // learns the monitor id from `start_screen_recording_event`.
    open_control_bar(app, &monitor_info)?;
    let _ = app.emit(
        "start_screen_recording_event",
        crate::scroll::types::StartRecordingEvent { monitor_id: monitor },
    );

    // Reference `arm_scroll_bar_handshake_watchdog`: if the bar never answers
    // `scroll_screenshot_bar_panel_loaded`, tear the session down.
    arm_bar_watchdog(app.clone(), session_epoch);

    Ok(())
}

/// `scroll_screenshot_bar_panel_loaded`: the bar's mount handshake.
pub fn bar_loaded(_app: &AppHandle) {
    let guard = active().lock().unwrap();
    if let Some(s) = guard.as_ref() {
        s.control.bar_loaded.store(true, Ordering::SeqCst);
        log::info!("[长截图] 控制条握手完成 (epoch {})", s.epoch);
    }
}

fn arm_bar_watchdog(app: AppHandle, epoch: u64) {
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + BAR_HANDSHAKE_TIMEOUT;
        while std::time::Instant::now() < deadline {
            let loaded = active()
                .lock()
                .unwrap()
                .as_ref()
                .map(|s| s.control.bar_loaded.load(Ordering::SeqCst) && s.epoch == epoch)
                .unwrap_or(true);
            if loaded {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let still_ours = active()
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.epoch == epoch)
            .unwrap_or(false);
        if still_ours {
            log::warn!("[长截图] 控制条握手超时 → 关闭本次长截图 (schedule_scroll_bar_close)");
            teardown(&app);
        }
    });
}

/// The control-bar window: compact, borderless, always on top, parked at the
/// bottom-center of the capture monitor. Draggable via the webview's
/// `startDragging` (reference `window-DWUaPAi8` drag helper).
fn open_control_bar(app: &AppHandle, monitor: &crate::types::MonitorInfo) -> Result<()> {
    let label = "recorder_bar_panel";
    if let Some(old) = app.get_webview_window(label) {
        let _ = old.close();
    }
    let w = 330.0;
    let h = 52.0;
    let x = monitor.x as f64 + (monitor.width as f64 - w) / 2.0;
    let y = monitor.y as f64 + (monitor.height as f64 - h - 48.0).max(24.0);

    // focused(false): the bar must not steal focus from the page being captured.
    let win = crate::windows::layer_window(
        app,
        label,
        "index.html?view=scrollbar",
        "Shutter 长截图",
        x.max(0.0),
        y.max(0.0),
        w,
        h,
        false,
    )?;
    let _ = win.show();
    Ok(())
}

/// `cancel_scroll_screenshot_event {isCancelScroll}`: pause (true) or resume
/// (false) the auto-scroller. The bar flips its own toggle locally; Rust
/// mirrors the state to the panel (`show_scroll_tip`) and to the bar
/// (`scroll_screenshot_pause_state`).
pub fn cancel_scroll(app: &AppHandle, is_cancel_scroll: bool) {
    let guard = active().lock().unwrap();
    if let Some(s) = guard.as_ref() {
        if s.worker.lock().unwrap().is_none() {
            return; // not started yet — nothing to pause
        }
        s.control.pause.store(is_cancel_scroll, Ordering::SeqCst);
        let _ = app.emit("scroll_screenshot_pause_state", is_cancel_scroll);
        let _ = app.emit("show_scroll_tip", is_cancel_scroll);
    }
}

/// `save_scroll_screenshot`: stop the worker and dispose of the stitched
/// image as asked. Windows are torn down by the caller's
/// `hide_scroll_screenshot_panel` (+ `close_panel`), mirroring the bar's `v()`.
pub fn save(app: &AppHandle, payload: SaveScroll) -> Result<()> {
    let control = {
        let guard = active().lock().unwrap();
        let Some(s) = guard.as_ref() else {
            return Err(anyhow!("没有正在进行的滚动截图"));
        };
        // A stale bar from a previous session must not hijack the current one
        // (reference SCROLL_BAR_OWNER_EPOCH guard).
        if let Some(id) = payload.monitor_id {
            if id != s.monitor_id {
                log::warn!("[长截图] 忽略旧控制条的保存请求 ({id} ≠ {})", s.monitor_id);
                return Err(anyhow!("旧会话已结束"));
            }
        }
        Arc::clone(&s.control)
    };

    let stitcher = control_stop_and_wait(&control);
    let Some(stitcher) = stitcher else {
        return Err(anyhow!("拼接线程尚未结束，请重试"));
    };
    let image = stitcher.finish();
    let png = crate::compose::to_png(&image)?;

    match payload.action_type.as_str() {
        "copy" => {
            crate::output::copy_image(&png)?;
            if !payload.auto_save_path.is_empty() {
                let _ = crate::output::save_png_at(&png, &payload.auto_save_path);
            }
            log::info!(
                "[长截图] 已复制 ({}x{}){}",
                image.width(),
                image.height(),
                if payload.auto_save_path.is_empty() { "" } else { " + 自动保存" }
            );
        }
        "saveAs" => {
            if payload.file_path.is_empty() {
                return Err(anyhow!("未选择保存位置"));
            }
            let path = crate::output::save_png_at(&png, &payload.file_path)?;
            log::info!("[长截图] 已保存到 {}", path.display());
        }
        other => return Err(anyhow!("未知的长截图保存动作 {other}")),
    }
    // The panel is click-through while recording; restore it so teardown
    // animates cleanly even if the bar's follow-up calls race.
    let _ = app.emit("scroll_screenshot_click_stop", ());
    Ok(())
}

/// `screenshot_crop_event`: the panel's own 下载/保存 — crop the LIVE
/// selection as a plain screenshot (no stitching; the panel toolbar only
/// exists before recording starts).
pub fn crop_event(app: &AppHandle, payload: CropEvent) -> Result<()> {
    let monitor = crate::capture::find_display(payload.monitor_id)?.info;
    let rect = crate::compose::to_pixel_rect(
        Rect {
            x: payload.x,
            y: payload.y,
            width: payload.width,
            height: payload.height,
        },
        monitor.scale_factor,
        monitor.pixel_width,
        monitor.pixel_height,
    )?;
    // The panel's own tips/badge would land in the frame: hide every scroll
    // panel window before the live crop (the caller quits right after).
    for (label, w) in app.webview_windows() {
        if label.starts_with("scroll_screenshot_panel_") {
            let _ = w.hide();
        }
    }
    std::thread::sleep(Duration::from_millis(120));
    let frame = capture_region(payload.monitor_id, &rect)?;
    let png = crate::compose::to_png(&frame)?;
    match payload.action_type.as_str() {
        "copy" => crate::output::copy_image(&png)?,
        "saveAs" => {
            if payload.file_path.is_empty() {
                return Err(anyhow!("未选择保存位置"));
            }
            crate::output::save_png_at(&png, &payload.file_path)?;
        }
        other => return Err(anyhow!("未知的裁剪动作 {other}")),
    }
    if !payload.auto_save_path.is_empty() {
        let _ = crate::output::save_png_at(&png, &payload.auto_save_path);
    }
    Ok(())
}

/// Payload of `screenshot_crop_event` (panel's live-crop buttons).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropEvent {
    pub monitor_id: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub action_type: String,
    pub file_path: String,
    pub auto_save_path: String,
}

/// `hide_scroll_screenshot_panel` / `hide_fullscreen_panel{scroll_screenshot}`:
/// full teardown — stop the worker, notify the frontend, close the windows.
pub fn teardown(app: &AppHandle) {
    let session = active().lock().unwrap().take();
    if let Some(s) = session {
        s.control.stop.store(true, Ordering::SeqCst);
        s.control.pause.store(false, Ordering::SeqCst);
        if let Ok(mut w) = s.worker.lock() {
            if let Some(handle) = w.take() {
                let _ = handle.join();
            }
        }
        // Drop order: the listener thread joins on drop.
        let _ = app.emit("scroll_screen_clear", ());
        let _ = app.emit("scroll_screenshot_click_stop", ());
    }
    if let Some(bar) = app.get_webview_window("recorder_bar_panel") {
        let _ = bar.close();
    }
    for (label, win) in app.webview_windows() {
        if label.starts_with("scroll_screenshot_panel_") {
            let _ = win.close();
        }
    }
}

fn control_stop_and_wait(control: &Arc<Control>) -> Option<Stitcher> {
    control.stop.store(true, Ordering::SeqCst);
    control.pause.store(false, Ordering::SeqCst);
    // The worker observes the stop flag within one iteration (worst case a
    // settle sleep); poll the result slot instead of joining a handle that
    // teardown may already own.
    for _ in 0..100 {
        if let Some(s) = control.result.lock().unwrap().take() {
            return Some(s);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

/* ------------------------------------------------------------- the worker */

/// Physical-pixel crop of a live screen region from an already-resolved
/// display handle.
///
/// The `Display` must be created and used on the same thread (its inner
/// `xcap::Monitor` is `!Send` on some platforms), so the worker resolves it
/// once and hands it here for every frame.
fn capture_from(display: &crate::capture::Display, rect: &crate::compose::PixelRect) -> Result<RgbaImage> {
    let frame = display.capture()?;
    let (fw, fh) = frame.dimensions();
    let x = rect.x.min(fw.saturating_sub(1));
    let y = rect.y.min(fh.saturating_sub(1));
    let w = rect.width.min(fw.saturating_sub(x));
    let h = rect.height.min(fh.saturating_sub(y));
    if w == 0 || h == 0 {
        return Err(anyhow!("选区已不在屏幕内"));
    }
    Ok(image::imageops::crop_imm(&frame, x, y, w, h).to_image())
}

/// One-shot capture on the caller's thread.
fn capture_region(monitor_id: u32, rect: &crate::compose::PixelRect) -> Result<RgbaImage> {
    capture_from(&crate::capture::find_display(monitor_id)?, rect)
}

/// Publish the stitched image to the reference preview path (atomic replace)
/// and ping the panel.
fn publish_preview(app: &AppHandle, image: &RgbaImage) {
    let Ok(path) = preview_path(app) else {
        return;
    };
    let bytes = match crate::output::encode_png_fast(image) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("[长截图] 预览 PNG 编码失败: {e:#}");
            return;
        }
    };
    // Atomic replace: the frontend reloads by path + timestamp, so a
    // half-written file can never be read (reference atomic_replace_file_with).
    if let Err(e) = crate::output::atomic_write(&path, &bytes) {
        log::warn!("[长截图] 预览替换失败: {e}");
        return;
    }
    let _ = app.asset_protocol_scope().allow_file(&path);
    let _ = app.emit(
        "scroll_screenshot_image_update_event",
        serde_json::json!({ "path": path.display().to_string() }),
    );
}

/// The worker loop: (wait for hover) → inject → settle → capture → decide →
/// append/reject.
///
/// The hover gate follows the reference: with injection armed, scrolling only
/// runs while the pointer is inside the selection
/// (`将鼠标移入选区域后将开始滚动截图`), tracked through `CGEventGetLocation`
/// because the recording panel is click-through and cannot report hover.
fn worker_loop(
    app: AppHandle,
    monitor_info: crate::types::MonitorInfo,
    rect: &crate::compose::PixelRect,
    first: RgbaImage,
    control: Arc<Control>,
    auto_scroll: bool,
) {
    let diag = std::env::var("CAP_PHOTO_SCROLL_DIAG").is_ok();

    // Resolve the display handle once on this thread; the per-frame path then
    // captures without re-enumerating monitors (see `capture::Display` for why
    // the handle must stay on the thread that created it).
    let display = match crate::capture::find_display(monitor_info.id) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[长截图] 无法打开显示器 {}: {e:#}", monitor_info.id);
            let stitcher = Stitcher::new(first);
            publish_preview(&app, stitcher.last_frame());
            *control.result.lock().unwrap() = Some(stitcher);
            return;
        }
    };

    // Global logical rect (display points) for the hover gate.
    let (origin_x, origin_y, scale) =
        (monitor_info.x as f64, monitor_info.y as f64, monitor_info.scale_factor);
    let sel_global = (
        origin_x + rect.x as f64 / scale,
        origin_y + rect.y as f64 / scale,
        rect.width as f64 / scale,
        rect.height as f64 / scale,
    );
    let pointer_inside = || -> bool {
        #[cfg(target_os = "macos")]
        {
            let (mx, my) = mouse_location();
            let (x, y, w, h) = sel_global;
            mx >= x && mx <= x + w && my >= y && my <= y + h
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    };

    let mut stitcher = Stitcher::new(first);
    let mut auto = auto_scroll;
    let mut armed = auto_scroll;
    let mut paused_by_user = false;
    let mut hover_paused = false;
    if armed {
        // Armed: wait for the pointer before any injection. The panel renders
        // the reference tip 将鼠标移入选区域后将开始滚动截图.
        let _ = app.emit("show_scroll_tip", true);
    }
    publish_preview(&app, stitcher.last_frame());

    let mut consecutive_rejects: u32 = 0;
    let mut bottom_stills: u32 = 0;
    let mut diag_seq: u32 = 0;

    'outer: while !control.stop.load(Ordering::SeqCst) {
        if control.pause.load(Ordering::SeqCst) {
            if !paused_by_user {
                paused_by_user = true;
                log::info!("[长截图] 已暂停（控制条）");
            }
            std::thread::sleep(Duration::from_millis(120));
            continue;
        }
        if paused_by_user {
            paused_by_user = false;
        }
        // Hover gate: an auto-inject session runs only while the pointer is
        // inside the selection. Leaving re-parks it without tearing anything
        // down — 移出即停，移入继续.
        if armed || hover_paused {
            if !pointer_inside() {
                if !hover_paused {
                    hover_paused = true;
                    log::info!("[长截图] 指针移出选区 → 暂停注入");
                    let _ = app.emit("show_scroll_tip", true);
                }
                std::thread::sleep(Duration::from_millis(120));
                continue;
            }
            if hover_paused || armed {
                hover_paused = false;
                armed = false;
                log::info!("[长截图] 指针移入选区 → 开始滚动截图");
                let _ = app.emit("show_scroll_tip", false);
            }
        }

        // 1. Inject one wheel step and let the page settle.
        if auto {
            if !crate::scroll::autoscroll::post_scroll(SCROLL_LINES) {
                // Injection broke mid-session (permission revoked): degrade to
                // manual scrolling permanently (reference 自动滚动注入失败).
                auto = false;
                log::warn!("[长截图] 自动滚动注入失败 → 请手动滚动页面");
                let _ = app.emit(
                    "scroll_screenshot_error",
                    serde_json::json!({ "message": "自动滚动已停止，请手动滚动页面" }),
                );
            }
        }
        std::thread::sleep(STEP_INTERVAL + SETTLE);

        // 2. Capture.
        let frame = match capture_from(&display, rect) {
            Ok(f) => f,
            Err(e) => {
                log::warn!("[长截图] 抓取失败: {e:#}");
                std::thread::sleep(Duration::from_millis(300));
                continue;
            }
        };
        if diag {
            if let Ok(dir) = crate::settings::app_dir().map(|d| d.join("scroll").join("diag")) {
                let _ = std::fs::create_dir_all(&dir);
                diag_seq += 1;
                let _ = frame.save(dir.join(format!("frame-{diag_seq:04}.png")));
            }
        }

        // 3. Decide.
        let prior = median_recent(stitcher.history(), 5);
        let decision = decide(stitcher.last_frame(), &frame, prior);

        match decision {
            FrameDecision::Still => {
                bottom_stills += 1;
                log::info!("[长截图] 页面几乎未滚动 → 本帧不追加");
                if bottom_stills >= BOTTOM_STILL_FRAMES {
                    log::info!("[长截图] 已到达页面底部 → 停止捕获");
                    let _ = app.emit("scroll_screenshot_click_stop", ());
                    let _ = app.emit("scroll_screenshot_pause_state", true);
                    break 'outer;
                }
            }
            FrameDecision::Append { offset, .. } => {
                bottom_stills = 0;
                consecutive_rejects = 0;
                if direction_reversed(stitcher.history(), offset) {
                    log::info!("[长截图] 检测到滚动方向反转 → 已拦截本次滚动 → 保留当前结果并暂停");
                    control.pause.store(true, Ordering::SeqCst);
                    let _ = app.emit("scroll_screenshot_pause_state", true);
                    let _ = app.emit(
                        "scroll_screenshot_error",
                        serde_json::json!({ "message": "检测到滚动方向反转，已暂停" }),
                    );
                    continue;
                }
                let added = stitcher.append(frame, &decision, offset);
                if added > 0 {
                    publish_preview(&app, stitcher.last_frame());
                }
                if stitcher.height() >= MAX_ACCUMULATED_HEIGHT {
                    log::warn!("[长截图] 累计高度达上限，自动停止");
                    let _ = app.emit("scroll_screenshot_click_stop", ());
                    let _ = app.emit("scroll_screenshot_pause_state", true);
                    let _ = app.emit(
                        "scroll_screenshot_error",
                        serde_json::json!({ "message": "长图已达最大高度，自动停止" }),
                    );
                    break 'outer;
                }
            }
            FrameDecision::Reversed => {
                log::info!("[长截图] 检测到滚动方向反转 → 已拦截本次滚动");
                control.pause.store(true, Ordering::SeqCst);
                let _ = app.emit("scroll_screenshot_pause_state", true);
            }
            FrameDecision::TooLarge
            | FrameDecision::LowConfidence
            | FrameDecision::VerifyFailed => {
                // 原地重抓: the page may still be animating; re-capture the
                // same position and retry a bounded number of times.
                let reason = match &decision {
                    FrameDecision::TooLarge => "位移过大",
                    FrameDecision::LowConfidence => "位移置信度不足",
                    _ => "横向分区未形成一致画面",
                };
                log::info!("[长截图][重抓] {reason} → 原地重抓");
                let mut accepted = false;
                for _ in 0..MAX_REGRAB {
                    std::thread::sleep(SETTLE);
                    let Ok(retry) = capture_from(&display, rect) else {
                        continue;
                    };
                    let d2 = decide(stitcher.last_frame(), &retry, prior);
                    match d2 {
                        FrameDecision::Append { offset, .. } => {
                            let added = stitcher.append(retry.clone(), &d2, offset);
                            if added > 0 {
                                publish_preview(&app, stitcher.last_frame());
                            }
                            accepted = true;
                            break;
                        }
                        FrameDecision::Still => {
                            accepted = true; // page settled; treat as no-op
                            break;
                        }
                        _ => {}
                    }
                }
                if !accepted {
                    consecutive_rejects += 1;
                    log::warn!(
                        "[长截图] 连续截图仍存在分区变化 → 本次帧交给原地重抓 → 避免硬拼中间态"
                    );
                    if consecutive_rejects >= MAX_CONSECUTIVE_REJECTS {
                        control.pause.store(true, Ordering::SeqCst);
                        let _ = app.emit("scroll_screenshot_pause_state", true);
                        let _ = app.emit(
                            "scroll_screenshot_error",
                            serde_json::json!({ "message": "拼接失败，请回到拼接点缓慢滚动页面" }),
                        );
                        consecutive_rejects = 0;
                    }
                } else {
                    consecutive_rejects = 0;
                }
            }
        }
    }

    *control.result.lock().unwrap() = Some(stitcher);
}
