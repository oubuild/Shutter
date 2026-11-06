//! Shutter — macOS screenshot + annotation + pin + DeepSeek vision assistant.

pub mod ai;
pub mod capture;
pub mod commands;
pub mod compose;
pub mod gallery;
pub mod ocr;
pub mod output;
pub mod overlay;
pub mod pin;
pub mod scroll;
pub mod session;
pub mod settings;
pub mod types;
pub mod updater;
pub mod windows;

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// What a registered global hotkey does when it fires.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HotkeyAction {
    /// Start a plain capture overlay.
    Capture,
    /// Start the overlay in scroll mode: framing a selection hands the
    /// session straight to the long-screenshot panel (tray 长截图 semantics).
    Scroll,
    /// Start the overlay in pin mode: framing a selection pins it.
    Pin,
}

/// The accelerators currently registered, with their actions.
///
/// Kept in managed state so the plugin's global handler can tell "our"
/// shortcuts from any future binding without re-reading `settings.json` on
/// every keypress.
pub struct Hotkeys(pub Mutex<Vec<(Shortcut, HotkeyAction)>>);

/// Parse a `global-hotkey` accelerator, normalising the error to a string the
/// settings page can show.
pub fn parse_accelerator(accel: &str) -> Result<Shortcut, String> {
    let shortcut: Shortcut = accel
        .trim()
        .parse()
        .map_err(|e| format!("无效的快捷键「{accel}」：{e}"))?;
    // A bare key would fire while the user is typing in any app, so at least
    // one modifier is required — but ONE is enough (the reference presets
    // include single-modifier combos like Option+R); demanding two made every
    // binding a three-key chord for no safety gain.
    if shortcut.mods.bits().count_ones() < 1 {
        return Err("全局快捷键需要至少一个修饰键（⌘ / ⌃ / ⌥ / ⇧）".into());
    }
    Ok(shortcut)
}

/// (Re)register every global hotkey from `settings` and remember them for the
/// global handler.
///
/// `unregister_all` first so a rebind cannot leave the old accelerator live.
/// An empty accelerator disables that binding instead of failing — the only
/// way to turn a hotkey off without losing its value.
pub fn register_hotkeys(app: &AppHandle, settings: &crate::types::Settings) -> Result<(), String> {
    let bindings: Vec<(Shortcut, HotkeyAction)> = [
        (settings.capture_shortcut.trim(), HotkeyAction::Capture),
        (settings.scroll_shortcut.trim(), HotkeyAction::Scroll),
        (settings.pin_shortcut.trim(), HotkeyAction::Pin),
    ]
    .into_iter()
    .filter(|(accel, _)| !accel.is_empty())
    .map(|(accel, action)| parse_accelerator(accel).map(|s| (s, action)))
    .collect::<Result<Vec<_>, String>>()?;

    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    for (shortcut, action) in &bindings {
        manager
            .register(*shortcut)
            .map_err(|e| format!("注册快捷键失败：{e}"))?;
        log::info!("registered hotkey {shortcut:?} → {action:?}");
    }
    if let Some(state) = app.try_state::<Hotkeys>() {
        *state.0.lock().expect("hotkeys lock") = bindings;
    }
    Ok(())
}

/// Startup permission preflight.
///
/// Only screen recording is requested up front — every capture path needs it,
/// and macOS shows that dialog exactly once. Accessibility is deliberately
/// NOT prompted here: the reference tool gates it at long-screenshot start
/// (`check_accessibility_permission` + the /permissionLong guide), never at
/// launch — a system prompt on every start until granted is exactly the nag
/// its flow avoids. The scroll session checks `AXIsProcessTrusted` silently
/// (scroll/autoscroll.rs) and falls back to manual scrolling without it.
#[cfg(target_os = "macos")]
fn preflight_permissions() {
    // Screen recording first: the capture warm-up below it would otherwise
    // grab black frames on a fresh install.
    let capture_access = core_graphics::access::ScreenCaptureAccess;
    if !capture_access.preflight() {
        let granted = capture_access.request();
        log::info!("screen recording permission requested (granted now: {granted})");
    }
}

/** The crop→action binding the chat window should boot with. `open_chat`
 *  emits `ai://bind` immediately and once more after 700ms, but a webview
 *  that is still loading (dev especially) misses both; the window therefore
 *  pulls this on mount. Cleared on read — later captures reach an
 *  already-live window through the event. */
#[derive(Default)]
pub struct ChatBind(std::sync::Mutex<Option<(String, Option<String>)>>);

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // Only accelerators currently bound fire; a rebind replaces
                    // them, so compare ids rather than key codes.
                    let Some(state) = app.try_state::<Hotkeys>() else {
                        return;
                    };
                    let action = state
                        .0
                        .lock()
                        .expect("hotkeys lock")
                        .iter()
                        .find(|(s, _)| s.id() == shortcut.id())
                        .map(|(_, a)| *a);
                    let Some(action) = action else {
                        return;
                    };
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let result = match action {
                            HotkeyAction::Capture => commands::start_capture(&app).await,
                            HotkeyAction::Scroll => {
                                // Same handover as the tray's 长截图 row: the
                                // overlay boots in scroll mode, so framing a
                                // selection starts the session directly.
                                crate::overlay::request_boot_tool("scroll");
                                commands::start_capture(&app).await
                            }
                            HotkeyAction::Pin => {
                                crate::overlay::request_boot_tool("pin");
                                commands::start_capture(&app).await
                            }
                        };
                        if let Err(e) = result {
                            log::error!("hotkey {action:?} failed: {e:#}");
                        }
                    });
                })
                .build(),
        )
        .manage(Arc::new(session::Store::new()))
        .manage(Hotkeys(Mutex::new(Vec::new())))
        .manage(ChatBind::default())
        .setup(|app| {
            // Menu-bar agent: no Dock icon, no app menu.
            //
            // Both halves are required. `LSUIElement` in Info.plist stops the
            // icon from flashing during launch, but Tauri resets the policy to
            // Regular once it starts, so this call is what actually keeps the
            // app out of the Dock.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            windows::set_tray(app.handle())?;

            // Register whatever the user last saved, falling back to the
            // defaults if an accelerator is no longer parseable (hand-edited
            // settings.json, removed keyboard layout, another app owns it).
            let settings = settings::load_settings();
            log::info!(
                "hotkeys: capture={} scroll={} pin={}",
                settings.capture_shortcut,
                settings.scroll_shortcut,
                settings.pin_shortcut
            );
            if let Err(e) = register_hotkeys(app.handle(), &settings) {
                log::warn!("cannot register the saved hotkeys ({e}); trying the defaults");
                let mut fallback = crate::types::Settings::default();
                // Keep every field the user actually configured; only the
                // hotkeys fall back, so a broken accelerator cannot poison
                // the rest of the registration.
                fallback.base_url = settings.base_url.clone();
                fallback.model = settings.model.clone();
                if let Err(e) = register_hotkeys(app.handle(), &fallback) {
                    log::warn!("cannot register the default hotkeys ({e}); the tray menu still works");
                }
            }

            // Automation hooks: let tests drive the overlay without sending a
            // global shortcut (which needs Accessibility permission). Compiled
            // out unless the `debug-hooks` feature is enabled.
            #[cfg(feature = "debug-hooks")]
            log::info!("debug capture-on-start env: {:?}", std::env::var("CAP_PHOTO_CAPTURE_ON_START"));
            #[cfg(feature = "debug-hooks")]
            if std::env::var("CAP_PHOTO_CAPTURE_ON_START").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    log::info!("capture-on-start: firing");
                    let result = tauri::async_runtime::block_on(commands::start_capture(&handle));
                    match result {
                        Ok(s) => {
                            log::info!("capture-on-start ok: session {} monitors {}", s.session_id, s.monitors.len());

                        }
                        Err(e) => log::error!("capture-on-start failed: {e:#}"),
                    }
                    if std::env::var("CAP_PHOTO_PLAIN_TEST").is_ok() {
                        let _ = commands::debug_plain_window(handle.clone());
                    }
                });
            }

            // Independent of capture: open an auxiliary window for UI checks.
            #[cfg(feature = "debug-hooks")]
            if let Ok(view) = std::env::var("CAP_PHOTO_OPEN_VIEW") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(900));
                    if let Err(e) = commands::debug_open_view(handle, view) {
                        log::error!("debug_open_view failed: {e}");
                    }
                });
            }

            // Drive the overlay → long-screenshot handover without a mouse:
            // fires the capture first (see above), then hands a fixed
            // selection to `open_scroll_screenshot_event` exactly the way the
            // overlay toolbar does.
            #[cfg(feature = "debug-hooks")]
            if std::env::var("CAP_PHOTO_SCROLL_ON_START").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2600));
                    let payload = {
                        let Ok((monitors, _)) = crate::capture::capture_all() else {
                            log::error!("scroll-on-start: cannot enumerate displays");
                            return;
                        };
                        let m = &monitors[0];
                        crate::scroll::types::OpenScroll {
                            x: (m.width as f64 * 0.25).round(),
                            y: (m.height as f64 * 0.25).round(),
                            bounds_width: (m.width as f64 * 0.5).round(),
                            bounds_height: (m.height as f64 * 0.4).round(),
                            monitor_ids: m.id,
                            selection_scale_factor: m.scale_factor,
                        }
                    };
                    log::info!("scroll-on-start: firing handover {payload:?}");
                    let result = tauri::async_runtime::block_on(
                        commands::open_scroll_screenshot_event(handle.clone(), payload.clone()),
                    );
                    match result {
                        Ok(()) => log::info!("scroll-on-start: handover ok"),
                        Err(e) => log::error!("scroll-on-start failed: {e}"),
                    }
                    // Optionally drive the panel's 开始 click too, so the
                    // control bar + handshake watchdog path gets exercised
                    // without a mouse.
                    if std::env::var("CAP_PHOTO_SCROLL_AUTOSTART").is_ok() {
                        std::thread::sleep(std::time::Duration::from_millis(4000));
                        let start = crate::scroll::types::StartScroll {
                            x: payload.x + 3.0,
                            y: payload.y + 3.0,
                            width: payload.bounds_width - 6.0,
                            height: payload.bounds_height - 6.0,
                            scale_factor: payload.selection_scale_factor,
                        };
                        log::info!("scroll-on-start: firing start {start:?}");
                        match tauri::async_runtime::block_on(
                            commands::start_scroll_screenshot_event(handle.clone(), start),
                        ) {
                            Ok(()) => log::info!("scroll-on-start: start ok"),
                            Err(e) => log::error!("scroll-on-start start failed: {e}"),
                        }
                    }
                });
            }

            // Warm ScreenCaptureKit once: the first capture in a fresh process
            // pays a large one-off cost, which users feel as a laggy hotkey.
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                let started = std::time::Instant::now();
                match crate::capture::capture_all() {
                    Ok((monitors, _frames)) => log::info!(
                        "capture pipeline warm in {:?} ({} monitor(s))",
                        started.elapsed(),
                        monitors.len()
                    ),
                    Err(e) => log::warn!("capture warmup failed: {e:#}"),
                }
            });

            // Ask for screen recording + accessibility once, at launch, like
            // the reference tool — never in the middle of a capture flow.
            #[cfg(target_os = "macos")]
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(600));
                preflight_permissions();
            });

            if !settings::has_api_key() {
                log::info!("no API key configured yet; the AI actions will prompt for one");
            }

            Ok(())
        })
            .invoke_handler(tauri::generate_handler![
                commands::capture_screens,
                commands::current_session,
                commands::list_windows,
                commands::debug_report,
            #[cfg(feature = "debug-hooks")]
            commands::debug_plain_window,
            #[cfg(feature = "debug-hooks")]
            commands::debug_open_view,
            commands::frame_path,
            commands::cancel_capture,
            commands::confirm_capture,
                commands::ai_ask,
                commands::ai_actions,
                commands::ocr_providers,
                commands::ocr_set_provider,
                commands::ocr_download_model,
                commands::ocr_extract,
                commands::action_hint,
            commands::get_settings,
            commands::model_presets,
            commands::save_settings_cmd,
            commands::set_api_key,
            commands::clear_api_key,
            commands::api_key_status,
            commands::test_connection,
            commands::list_models,
            commands::copy_text_to_clipboard,
            commands::open_settings_window,
            commands::open_about_window,
            commands::chat_pending_bind,
            commands::autostart_status,
            commands::set_autostart,
            commands::exit_app,
            commands::open_main_window,
            commands::list_gallery,
            commands::gallery_thumbnail,
            commands::gallery_full_image,
            commands::delete_gallery_item,
            commands::save_directory,
            commands::reveal_path,
            commands::open_directory,
            commands::choose_directory,
            commands::save_as_dialog,
            commands::open_chat_window,
            commands::close_pin,
            commands::save_crop,
            commands::crop_data_url,
            commands::crop_preview,
                commands::pin_crop,
                commands::open_scroll_screenshot_event,
                commands::scroll_screenshot_panel_loaded_event,
                commands::drawn_scroll_screenshot_event,
                commands::start_scroll_screenshot_event,
                commands::scroll_screenshot_bar_panel_loaded,
                commands::cancel_scroll_screenshot_event,
                commands::save_scroll_screenshot,
                commands::screenshot_crop_event,
                commands::hide_scroll_screenshot_panel,
                commands::close_panel,
                updater::check_app_update,
                updater::install_app_update,
            ])
        .build(tauri::generate_context!())
        .expect("error while building Shutter")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                // Closing the last window must not quit a menu-bar app.
                if code.is_none() {
                    // A scroll session owns threads and windows; stop it once
                    // its own windows are gone (the user closed them), so the
                    // exit it would otherwise keep alive cannot recurse. A
                    // session whose panel is still on screen must survive:
                    // this event also fires on transient zero-window moments,
                    // which used to tear a just-opened session down before its
                    // panel ever mounted.
                    let scroll_alive = _app
                        .webview_windows()
                        .keys()
                        .any(|l| l.starts_with("scroll_screenshot_panel_") || l == "recorder_bar_panel");
                    if !scroll_alive {
                        crate::scroll::teardown(_app);
                    }
                    api.prevent_exit();
                }
            }
        });
}
