//! Long-screenshot (scroll-and-stitch) session controller.
//!
//! Reproduces the reference app's session flow (`report/03-scroll-pipeline.md`
//! §3.1): the user picks a region on the overlay, the overlay hides its chrome
//! and becomes click-through, a control-bar window opens, and a worker thread
//! loops inject → settle → capture → estimate → verify → append/reject until
//! the user stops it or the page bottoms out. Frames that cannot be aligned
//! are re-captured in place (原地重抓) a bounded number of times; persistent
//! failure pauses the auto-scroller with a tip instead of forcing a stitch
//! (`拒绝硬拼`, fail closed).

use crate::scroll::pipeline::{decide, direction_reversed, median_recent, FrameDecision};
use crate::scroll::stitch::Stitcher;
use crate::scroll::types::{
    ScrollDone, ScrollFinishAction, ScrollPhase, ScrollPreview, ScrollStatus, ScrollTip,
};
use anyhow::{anyhow, Result};
use image::RgbaImage;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Lines per injected wheel step (reference: 每次固定行数, with a watchdog).
const SCROLL_LINES: i32 = 3;

/// Pause between injected steps: enough for a page to settle.
const STEP_INTERVAL: Duration = Duration::from_millis(260);

/// Extra settle time after the last injection before capturing.
const SETTLE: Duration = Duration::from_millis(160);

/// Captures of the same position attempted when alignment fails before
/// giving up on the frame (reference: 原地重抓, bounded).
const MAX_REGRAB: u32 = 3;

/// Consecutive rejected frames before the auto-scroller pauses itself
/// (reference: 拒绝 → 暂停自动滚动).
const MAX_CONSECUTIVE_REJECTS: u32 = 4;

/// Still frames in a row at the bottom that end the session automatically
/// (reference: 已到达页面底部).
const BOTTOM_STILL_FRAMES: u32 = 6;

/// Height (px) beyond which stitching stops for safety (memory guard).
const MAX_ACCUMULATED_HEIGHT: u32 = 60_000;

/// Shared control block: the command surface flips these, the worker reads.
struct Control {
    stop: AtomicBool,
    pause: AtomicBool,
    /// Worker → command: the finished stitcher, handed over on completion.
    result: Mutex<Option<Finished>>,
}

/// What the worker leaves behind when it exits.
struct Finished {
    stitcher: Stitcher,
    phase: ScrollPhase,
}

static ACTIVE: OnceLock<Mutex<Option<ActiveSession>>> = OnceLock::new();

struct ActiveSession {
    id: String,
    control: Arc<Control>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Listener for user wheel events; dropped to stop the thread.
    _listener: Option<crate::scroll::autoscroll::ScrollListener>,
    /// Whether injection is armed for this session.
    auto_scroll: bool,
}

fn active() -> &'static Mutex<Option<ActiveSession>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// Public snapshot for `scroll_status` / return values.
pub fn status() -> ScrollStatus {
    let guard = active().lock().unwrap();
    match guard.as_ref() {
        Some(s) => {
            // Height comes from the worker only via events; the command side
            // reports the last published dimension, or zeros while running.
            ScrollStatus {
                session_id: Some(s.id.clone()),
                phase: if s.control.stop.load(Ordering::SeqCst) {
                    ScrollPhase::Finished
                } else if s.control.pause.load(Ordering::SeqCst) {
                    ScrollPhase::Paused
                } else {
                    ScrollPhase::Recording
                },
                height: 0,
                width: 0,
                auto_scroll: s.auto_scroll,
                note: None,
            }
        }
        None => ScrollStatus::default(),
    }
}

/// Physical-pixel crop of the live screen region, right now.
fn capture_region(monitor_id: u32, rect: &crate::compose::PixelRect) -> Result<RgbaImage> {
    let displays = crate::capture::displays()?;
    let display = displays
        .into_iter()
        .find(|d| d.info.id == monitor_id)
        .ok_or_else(|| anyhow!("显示器 {monitor_id} 不可用"))?;
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

/// Context the worker needs to talk to the frontend.
struct Fe {
    app: AppHandle,
    session_id: String,
}

impl Fe {
    fn state(&self, phase: ScrollPhase, height: u32, width: u32, auto: bool, note: Option<String>) {
        let _ = self.app.emit(
            "scroll://state",
            ScrollStatus {
                session_id: Some(self.session_id.clone()),
                phase,
                height,
                width,
                auto_scroll: auto,
                note,
            },
        );
    }

    fn tip(&self, kind: &'static str, text: &str) {
        let _ = self.app.emit(
            "scroll://tip",
            ScrollTip {
                session_id: self.session_id.clone(),
                kind,
                text: text.into(),
            },
        );
    }

    fn preview(&self, image: &RgbaImage) {
        let Ok(dir) = crate::settings::app_dir().map(|d| d.join("scroll")) else {
            return;
        };
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join(format!("preview-{}.png", self.session_id));
        let tmp = dir.join(format!("preview-{}.tmp", self.session_id));
        let write = {
            let mut buf = Vec::new();
            use image::ImageEncoder;
            let enc = image::codecs::png::PngEncoder::new_with_quality(
                &mut buf,
                image::codecs::png::CompressionType::Fast,
                image::codecs::png::FilterType::NoFilter,
            );
            enc.write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgba8,
            )
            .and_then(|_| std::fs::write(&tmp, &buf))
        };
        if let Err(e) = write {
            log::warn!("[长截图] 预览 PNG 写盘失败: {e}");
            return;
        }
        // Atomic replace: the frontend reloads by path + timestamp, so a
        // half-written file can never be read (reference atomic_replace_file_with).
        if let Err(e) = std::fs::rename(&tmp, &path) {
            log::warn!("[长截图] 预览替换失败: {e}");
            return;
        }
        let _ = self.app.asset_protocol_scope().allow_file(&path);
        let _ = self.app.emit(
            "scroll://preview",
            ScrollPreview {
                session_id: self.session_id.clone(),
                path: path.display().to_string(),
                width: image.width(),
                height: image.height(),
            },
        );
    }
}

/// The worker loop: inject → settle → capture → decide → append/reject.
fn worker_loop(
    app: AppHandle,
    monitor_id: u32,
    rect: crate::compose::PixelRect,
    first: RgbaImage,
    control: Arc<Control>,
    auto_scroll: bool,
    session_id: String,
) {
    let diag = std::env::var("CAP_PHOTO_SCROLL_DIAG").is_ok();
    let fe = Fe {
        app: app.clone(),
        session_id: session_id.clone(),
    };
    let mut stitcher = Stitcher::new(first);
    let mut phase = ScrollPhase::Recording;
    let mut note: Option<String> = None;
    let mut auto = auto_scroll;
    fe.state(
        phase,
        stitcher.height(),
        stitcher.width(),
        auto,
        note.clone(),
    );
    fe.preview(stitcher.last_frame());

    let mut consecutive_rejects: u32 = 0;
    let mut bottom_stills: u32 = 0;
    let mut diag_seq: u32 = 0;

    'outer: while !control.stop.load(Ordering::SeqCst) {
        if control.pause.load(Ordering::SeqCst) {
            if phase != ScrollPhase::Paused {
                phase = ScrollPhase::Paused;
                note = Some("已暂停".into());
                fe.state(phase, stitcher.height(), stitcher.width(), auto, note.clone());
            }
            std::thread::sleep(Duration::from_millis(120));
            continue;
        }
        if phase == ScrollPhase::Paused {
            phase = ScrollPhase::Recording;
            note = None;
            fe.state(phase, stitcher.height(), stitcher.width(), auto, note.clone());
        }

        // 1. Inject one wheel step and let the page settle.
        if auto {
            if !crate::scroll::autoscroll::post_scroll(SCROLL_LINES) {
                // Injection broke mid-session (permission revoked): degrade to
                // manual scrolling permanently, reference `自动滚动注入失败`.
                auto = false;
                note = Some("自动滚动已停止，请手动滚动页面".into());
                fe.tip("warn", "自动滚动注入失败，请手动滚动页面");
                fe.state(phase, stitcher.height(), stitcher.width(), auto, note.clone());
            }
        }
        std::thread::sleep(STEP_INTERVAL + SETTLE);

        // 2. Capture.
        let frame = match capture_region(monitor_id, &rect) {
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
                let _ = frame.save(dir.join(format!("{session_id}-{diag_seq:04}.png")));
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
                    fe.tip("bottom", "已到达页面底部");
                    log::info!("[长截图] 已到达页面底部 → 自动停止");
                    phase = ScrollPhase::Finished;
                    break 'outer;
                }
            }
            FrameDecision::Append { offset, .. } => {
                bottom_stills = 0;
                consecutive_rejects = 0;
                if direction_reversed(stitcher.history(), offset) {
                    fe.tip(
                        "warn",
                        "检测到滚动方向反转 → 已拦截本次滚动 → 保留当前结果并暂停",
                    );
                    log::info!("[长截图] 方向反转，拦截并暂停");
                    control.pause.store(true, Ordering::SeqCst);
                    continue;
                }
                let added = stitcher.append(frame, &decision, offset);
                if added > 0 {
                    fe.preview(stitcher.last_frame());
                    fe.state(phase, stitcher.height(), stitcher.width(), auto, note.clone());
                }
                if stitcher.height() >= MAX_ACCUMULATED_HEIGHT {
                    log::warn!("[长截图] 累计高度达上限，自动停止");
                    fe.tip("info", "长图已达最大高度，自动停止");
                    phase = ScrollPhase::Finished;
                    break 'outer;
                }
            }
            FrameDecision::Reversed => {
                fe.tip("warn", "检测到滚动方向反转 → 已拦截本次滚动");
                control.pause.store(true, Ordering::SeqCst);
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
                    let Ok(retry) = capture_region(monitor_id, &rect) else {
                        continue;
                    };
                    let d2 = decide(stitcher.last_frame(), &retry, prior);
                    match d2 {
                        FrameDecision::Append { offset, .. } => {
                            let added = stitcher.append(retry.clone(), &d2, offset);
                            if added > 0 {
                                fe.preview(stitcher.last_frame());
                                fe.state(
                                    phase,
                                    stitcher.height(),
                                    stitcher.width(),
                                    auto,
                                    note.clone(),
                                );
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
                        fe.tip("error", "拼接失败，请回到拼接点缓慢滚动页面");
                        note = Some("连续多帧无法拼接，已暂停".into());
                        fe.state(phase, stitcher.height(), stitcher.width(), auto, note.clone());
                        consecutive_rejects = 0;
                    }
                } else {
                    consecutive_rejects = 0;
                }
            }
        }
    }

    if phase == ScrollPhase::Recording {
        phase = ScrollPhase::Finished;
    }
    fe.state(phase, stitcher.height(), stitcher.width(), auto, note);
    *control.result.lock().unwrap() = Some(Finished { stitcher, phase });
    let _ = app.emit("scroll://worker-done", &session_id);
}

/// Begin a scroll-capture session on the given selection.
///
/// Called from `scroll_start` after the overlay has hidden its chrome: the
/// first capture must not contain any of our windows, so a short compose
/// settle precedes it. Replaces any running session (reference epoch guard).
pub fn begin(app: &AppHandle, monitor_id: u32, rect: Rect) -> Result<ScrollStatus> {
    // Tear down any previous session first.
    cancel(app);

    // The overlay hid its chrome just before invoking; give the compositor a
    // beat so the first frame is clean (reference 启动耗时 log).
    std::thread::sleep(Duration::from_millis(80));

    let session = app.state::<Arc<crate::session::Store>>();
    let monitor = session
        .current()
        .and_then(|s| s.monitor(monitor_id).cloned())
        .ok_or_else(|| anyhow!("截图会话已结束，请重新截图"))?;
    let frame = session
        .current()
        .and_then(|s| s.frame(monitor_id).cloned())
        .ok_or_else(|| anyhow!("找不到显示器 {monitor_id} 的画面"))?;
    let scale = monitor.scale_factor;
    let pixel_rect = crate::compose::to_pixel_rect(rect, scale, frame.width(), frame.height())?;
    let first = crate::compose::crop(&frame, pixel_rect)?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let control = Arc::new(Control {
        stop: AtomicBool::new(false),
        pause: AtomicBool::new(false),
        result: Mutex::new(None),
    });

    // Accessibility check → auto or manual scrolling.
    let capability = crate::scroll::autoscroll::inject_capable();
    let auto_scroll = capability == crate::scroll::autoscroll::InjectCapability::Ok;
    if !auto_scroll {
        log::info!(
            "[长截图] 无辅助功能权限（{:?}）→ 手动滚动模式",
            capability
        );
    }

    // Listen for the user's own wheel input so manual scrolling pauses cleanly.
    let listener = crate::scroll::autoscroll::ScrollListener::start();
    if listener.is_none() {
        log::warn!("[长截图] 滚动监听器不可用（无辅助功能权限？）");
    }

    let worker_control = Arc::clone(&control);
    let worker_app = app.clone();
    let worker_id = session_id.clone();
    let worker = std::thread::Builder::new()
        .name(format!("scroll-worker-{session_id}"))
        .spawn(move || {
            worker_loop(
                worker_app,
                monitor_id,
                pixel_rect,
                first,
                worker_control,
                auto_scroll,
                worker_id,
            );
        })
        .map_err(|e| anyhow!("启动拼接线程失败: {e}"))?;

    *active().lock().unwrap() = Some(ActiveSession {
        id: session_id.clone(),
        control,
        worker: Mutex::new(Some(worker)),
        _listener: listener,
        auto_scroll,
    });

    // Control-bar window (reference recorder_bar_panel): fresh per session.
    open_control_bar(app, &session_id)?;

    // Click-through overlay while recording (reference setIgnoreCursorEvents).
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = win.set_ignore_cursor_events(true);
        }
    }

    Ok(ScrollStatus {
        session_id: Some(session_id),
        phase: ScrollPhase::Recording,
        height: first.height(),
        width: first.width(),
        auto_scroll,
        note: if auto_scroll {
            None
        } else {
            Some("无辅助功能权限，请手动滚动页面".into())
        },
    })
}

/// The control-bar window (reference `recorder_bar_panel`): compact,
/// borderless, always-on-top, does not steal focus from the scrolled page.
fn open_control_bar(app: &AppHandle, session_id: &str) -> Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let label = "scroll-bar";
    if let Some(old) = app.get_webview_window(label) {
        let _ = old.close();
    }
    // Park it near the bottom-center of the primary monitor.
    let (sw, sh) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            (
                (m.size().width as f64 / m.scale_factor()) as f64,
                (m.size().height as f64 / m.scale_factor()) as f64,
            )
        })
        .unwrap_or((1440.0, 900.0));
    let w = 360.0;
    let h = 52.0;
    let x = (sw - w) / 2.0;
    let y = (sh - h - 48.0).max(24.0);

    let win = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(
            format!("index.html?view=scrollbar&session={session_id}").into(),
        ),
    )
    .title("Shutter 长截图")
    .position(x, y)
    .inner_size(w, h)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .build()?;
    let _ = win.show();
    Ok(())
}

/// Pause the auto-scroller (user toggled on the control bar).
pub fn pause() -> ScrollStatus {
    let guard = active().lock().unwrap();
    if let Some(s) = guard.as_ref() {
        s.control.pause.store(true, Ordering::SeqCst);
        return ScrollStatus {
            session_id: Some(s.id.clone()),
            phase: ScrollPhase::Paused,
            height: 0,
            width: 0,
            auto_scroll: s.auto_scroll,
            note: None,
        };
    }
    ScrollStatus::default()
}

/// Resume after a pause.
pub fn resume() -> ScrollStatus {
    let guard = active().lock().unwrap();
    if let Some(s) = guard.as_ref() {
        s.control.pause.store(false, Ordering::SeqCst);
        return ScrollStatus {
            session_id: Some(s.id.clone()),
            phase: ScrollPhase::Recording,
            height: 0,
            width: 0,
            auto_scroll: s.auto_scroll,
            note: None,
        };
    }
    ScrollStatus::default()
}

/// Tear the session down without producing an image (reference
/// `cancel_scroll_screenshot`).
pub fn cancel(app: &AppHandle) {
    let mut guard = active().lock().unwrap();
    if let Some(mut s) = guard.take() {
        s.control.stop.store(true, Ordering::SeqCst);
        s.control.pause.store(false, Ordering::SeqCst);
        if let Ok(mut w) = s.worker.lock() {
            if let Some(handle) = w.take() {
                let _ = handle.join();
            }
        }
        // Drop order: the listener thread joins on drop.
    }
    let _ = guard;
    if let Some(bar) = app.get_webview_window("scroll-bar") {
        let _ = bar.close();
    }
    // Restore overlay interactivity.
    for (label, win) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = win.set_ignore_cursor_events(false);
        }
    }
}

/// Stop the session and dispose of the stitched image as asked.
///
/// `save` runs the native save dialog (via the existing `save_as_dialog`
/// command implementation — reproduced here to avoid a webview round trip,
/// since the overlay may be mid-teardown) and writes the final PNG.
pub fn stop(app: &AppHandle, action: ScrollFinishAction) -> Result<ScrollDone> {
    // Snapshot and stop the worker.
    let (id, result, auto) = {
        let mut guard = active().lock().unwrap();
        match guard.as_mut() {
            Some(s) => {
                s.control.pause.store(false, Ordering::SeqCst);
                s.control.stop.store(true, Ordering::SeqCst);
                let worker = s.worker.lock().unwrap().take();
                if let Some(handle) = worker {
                    // The worker exits within one loop iteration; join it.
                    // Guard the lock so a slow join cannot poison the world.
                    drop(guard);
                    let _ = handle.join();
                    let guard = active().lock().unwrap();
                    let s = guard.as_ref().expect("session vanished");
                    (
                        s.id.clone(),
                        s.control.result.lock().unwrap().take(),
                        s.auto_scroll,
                    )
                } else {
                    let r = s.control.result.lock().unwrap().take();
                    (s.id.clone(), r, s.auto_scroll)
                }
            }
            None => return Err(anyhow!("没有正在进行的滚动截图")),
        }
    };

    // Tear down windows + restore overlay.
    cancel(app);

    let Some(finished) = result else {
        return Err(anyhow!("拼接线程尚未结束，请重试"));
    };
    let stitcher = finished.stitcher;
    let image = stitcher.finish();

    if action == ScrollFinishAction::Cancel {
        let _ = app.emit(
            "scroll://done",
            ScrollDone {
                session_id: id.clone(),
                ok: false,
                width: image.width(),
                height: image.height(),
                message: None,
                saved_path: None,
            },
        );
        return Ok(ScrollDone {
            session_id: id,
            ok: false,
            width: image.width(),
            height: image.height(),
            message: None,
            saved_path: None,
        });
    }

    // Encode the final PNG once.
    let png = crate::compose::to_png(&image)?;
    let _ = auto; // manual/auto only affects notes, not the finish path.

    match action {
        ScrollFinishAction::Save => {
            let stamp = chrono::Local::now().format("%Y%m%d%H%M%S");
            let default_name = format!("shutter-long-{stamp}.png");
            let picked = native_save_dialog(&default_name)?;
            let Some(target) = picked else {
                // Cancelled the dialog: discard like the reference does.
                let _ = app.emit(
                    "scroll://done",
                    ScrollDone {
                        session_id: id.clone(),
                        ok: false,
                        width: image.width(),
                        height: image.height(),
                        message: None,
                        saved_path: None,
                    },
                );
                return Ok(ScrollDone {
                    session_id: id,
                    ok: false,
                    width: image.width(),
                    height: image.height(),
                    message: None,
                    saved_path: None,
                });
            };
            let path = crate::output::save_png_at(&png, &target)?;
            let done = ScrollDone {
                session_id: id,
                ok: true,
                width: image.width(),
                height: image.height(),
                message: Some(format!("已保存到 {}", path.display())),
                saved_path: Some(path.display().to_string()),
            };
            let _ = app.emit("scroll://done", &done);
            Ok(done)
        }
        ScrollFinishAction::Copy => {
            crate::output::copy_image(&png)?;
            // Gallery auto-save mirrors the normal capture path: a long
            // screenshot is a capture too, and the gallery is the record.
            let settings = crate::settings::load_settings();
            let mut message = "已复制到剪贴板".to_string();
            if settings.auto_save {
                if let Ok(dir) = crate::settings::save_dir(&settings) {
                    if let Ok(path) = crate::output::save_png(&png, &dir) {
                        message = format!("已复制到剪贴板；已存入图库 {}", path.display());
                    }
                }
            }
            let done = ScrollDone {
                session_id: id,
                ok: true,
                width: image.width(),
                height: image.height(),
                message: Some(message),
                saved_path: None,
            };
            let _ = app.emit("scroll://done", &done);
            Ok(done)
        }
        ScrollFinishAction::Cancel => unreachable!("handled above"),
    }
}

/// Native save dialog without going through the webview (same osascript
/// approach as `commands::save_as_dialog`, inlined because the issuing webview
/// may already be gone).
fn native_save_dialog(default_name: &str) -> Result<Option<String>> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "POSIX path of (choose file name with prompt \"保存长截图\" default name \"{}\")",
            default_name.replace('"', "\\\"")
        );
        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| anyhow!("无法打开保存对话框：{e}"))?;
        if !output.status.success() {
            return Ok(None); // user cancelled
        }
        let path = String::from_utf8_lossy(&output.stdout)
            .trim()
            .trim_matches('\'')
            .to_string();
        return Ok(if path.is_empty() { None } else { Some(path) });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = default_name;
        Err(anyhow!("当前平台不支持另存为对话框"))
    }
}
