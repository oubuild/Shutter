//! Shutter — macOS screenshot + annotation + pin + DeepSeek vision assistant.

pub mod ai;
pub mod capture;
pub mod commands;
pub mod compose;
pub mod gallery;
pub mod output;
pub mod overlay;
pub mod pin;
pub mod session;
pub mod settings;
pub mod types;
pub mod windows;

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// The accelerator currently bound to the capture hotkey.
///
/// Kept in managed state so the plugin's global handler can tell "our"
/// shortcut from any future binding without re-reading `settings.json` on every
/// keypress.
pub struct CaptureHotkey(pub Mutex<Option<Shortcut>>);

/// Parse a `global-hotkey` accelerator, normalising the error to a string the
/// settings page can show.
pub fn parse_accelerator(accel: &str) -> Result<Shortcut, String> {
    let shortcut: Shortcut = accel
        .trim()
        .parse()
        .map_err(|e| format!("无效的快捷键「{accel}」：{e}"))?;
    // A global hotkey with fewer than two modifiers shadows ordinary app
    // shortcuts (⌘1, ⌘A, …) everywhere on the system.
    if shortcut.mods.bits().count_ones() < 2 {
        return Err("全局快捷键需要至少两个修饰键（如 ⌘⇧）".into());
    }
    Ok(shortcut)
}

/// (Re)register the capture hotkey and remember it for the global handler.
///
/// Only this one global shortcut exists, so clearing the manager first is the
/// simplest way to guarantee a rebind cannot leave the old accelerator live.
pub fn register_capture_hotkey(app: &AppHandle, accel: &str) -> Result<(), String> {
    let shortcut = parse_accelerator(accel)?;
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    manager
        .register(shortcut)
        .map_err(|e| format!("注册快捷键失败：{e}"))?;
    if let Some(state) = app.try_state::<CaptureHotkey>() {
        *state.0.lock().expect("capture hotkey lock") = Some(shortcut);
    }
    log::info!("registered capture hotkey {accel}");
    Ok(())
}

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // Only the accelerator currently bound to capture fires; a
                    // rebind replaces it, so compare ids rather than key codes.
                    let Some(state) = app.try_state::<CaptureHotkey>() else {
                        return;
                    };
                    let current = *state.0.lock().expect("capture hotkey lock");
                    if !current.is_some_and(|c| c.id() == shortcut.id()) {
                        return;
                    }
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = commands::start_capture(&app).await {
                            log::error!("capture shortcut failed: {e:#}");
                        }
                    });
                })
                .build(),
        )
        .manage(Arc::new(session::Store::new()))
        .manage(CaptureHotkey(Mutex::new(None)))
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
            // default if the accelerator is no longer parseable (hand-edited
            // settings.json, removed keyboard layout, another app owns it).
            let configured = settings::load_settings().capture_shortcut;
            log::info!("capture hotkey: {configured}");
            if let Err(e) = register_capture_hotkey(app.handle(), &configured) {
                log::warn!("cannot register {configured} ({e}); trying the default");
                let fallback = types::default_capture_shortcut();
                if let Err(e) = register_capture_hotkey(app.handle(), &fallback) {
                    log::warn!("cannot register the default hotkey ({e}); the tray menu still works");
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

            if !settings::has_api_key() {
                log::info!("no API key configured yet; the AI actions will prompt for one");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture_screens,
            commands::current_session,
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
            commands::pin_crop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Shutter")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                // Closing the last window must not quit a menu-bar app.
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
