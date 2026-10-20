//! cap-photo — macOS screenshot + annotation + pin + DeepSeek vision assistant.

pub mod ai;
pub mod capture;
pub mod commands;
pub mod compose;
pub mod output;
pub mod overlay;
pub mod pin;
pub mod session;
pub mod settings;
pub mod types;
pub mod windows;

use std::sync::Arc;
use tauri::RunEvent;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

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
                    if shortcut.matches(Modifiers::SUPER | Modifiers::SHIFT, Code::KeyA) {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = commands::start_capture(&app).await {
                                log::error!("capture shortcut failed: {e:#}");
                            }
                        });
                    }
                })
                .build(),
        )
        .manage(Arc::new(session::Store::new()))
        .setup(|app| {
            // Menu bar app: no dock icon, no default window.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            windows::set_tray(app.handle())?;

            let shortcut = Shortcut::new(
                Some(Modifiers::SUPER | Modifiers::SHIFT),
                Code::KeyA,
            );
            if let Err(e) = app.global_shortcut().register(shortcut) {
                log::warn!("cannot register Cmd+Shift+A ({e}); the tray menu still works");
            }

            // Debug hook: lets automation verify the overlay without sending a
            // global shortcut (which needs Accessibility permission).
            log::info!("debug capture-on-start env: {:?}", std::env::var("CAP_PHOTO_CAPTURE_ON_START"));
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
            if let Ok(view) = std::env::var("CAP_PHOTO_OPEN_VIEW") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(900));
                    if let Err(e) = commands::debug_open_view(handle, view) {
                        log::error!("debug_open_view failed: {e}");
                    }
                });
            }

            if !settings::has_api_key() {
                log::info!("no API key configured yet; the AI actions will prompt for one");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture_screens,
            commands::current_session,
            commands::debug_report,
            commands::debug_plain_window,
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
            commands::copy_text_to_clipboard,
            commands::open_settings_window,
            commands::open_chat_window,
            commands::close_pin,
            commands::save_crop,
            commands::crop_data_url,
            commands::pin_crop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building cap-photo")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                // Closing the last window must not quit a menu-bar app.
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
