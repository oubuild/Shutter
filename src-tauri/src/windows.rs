//! Utility windows (settings, chat) and the tray menu.

use anyhow::Result;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub fn open(app: &AppHandle, label: &str, view: &str, title: &str, w: f64, h: f64) -> Result<WebviewWindow> {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(win);
    }
    let win = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("index.html?view={view}").into()),
    )
    .title(title)
    .inner_size(w, h)
    .min_inner_size(360.0, 320.0)
    .resizable(true)
    .transparent(false)
    .build()?;
    Ok(win)
}

/// Open (or refocus) the main window: gallery, settings and about in one shell.
///
/// `tab` selects the initial section (`gallery` / `settings` / `about`). When the
/// window already exists it is focused and asked to switch tabs through
/// `ui://tab` rather than being recreated, which keeps the gallery scroll
/// position and avoids a visible reload.
pub fn open_main(app: &AppHandle, tab: &str) -> Result<WebviewWindow> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.unminimize();
        use tauri::Emitter;
        let _ = win.emit("ui://tab", tab);
        return Ok(win);
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::App(format!("index.html?view=main&tab={tab}").into()),
    )
    .title("Shutter")
    .inner_size(1080.0, 720.0)
    .min_inner_size(760.0, 520.0)
    .resizable(true);

    // The rounded card is drawn by the webview, so the native frame has to go.
    // Only macOS gets the transparent variant: a transparent undecorated window
    // on Windows needs extra compositor setup and renders with a black
    // background when it is missing, which is worse than a plain frame.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .decorations(false)
            .transparent(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            // Inset the traffic lights so they sit inside the card and line up
            // with the 52px header row.
            .traffic_light_position(tauri::LogicalPosition::new(18.0, 20.0));
    }

    let win = builder.build()?;

    Ok(win)
}

/// Open the settings section of the main window.
pub fn open_settings(app: &AppHandle) -> Result<()> {
    open_main(app, "settings")?;
    Ok(())
}

/// Open (or refocus) the AI window. A `crop_id` re-binds the window to a new
/// screenshot without recreating it, which keeps the conversation history.
pub fn open_chat(app: &AppHandle, crop_id: Option<&str>, action: Option<&str>) -> Result<()> {
    // First open carries the crop in the URL so the window has it on mount;
    // later opens reuse the window and rebind through `ai://bind`.
    let view = match crop_id {
        Some(id) => format!("chat&crop={id}"),
        None => "chat".to_string(),
    };
    let win = open(app, "chat", &view, "Shutter AI", 680.0, 720.0)?;
    if let Some(crop_id) = crop_id {
        use tauri::Emitter;
        let payload = serde_json::json!({ "cropId": crop_id, "action": action });
        let _ = app.emit("ai://bind", &payload);
        // The window may still be loading on first open; replay the bind once
        // after the webview is up. Re-binding is idempotent.
        let app2 = app.clone();
        let payload2 = payload.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let _ = app2.emit("ai://bind", payload2);
        });
    }
    let _ = win.set_focus();
    Ok(())
}

pub fn set_tray(app: &AppHandle) -> tauri::Result<()> {
    let capture = MenuItem::with_id(app, "capture", "截图  ⌘⇧A", true, None::<&str>)?;
    let gallery = MenuItem::with_id(app, "gallery", "打开 Shutter", true, None::<&str>)?;
    let chat = MenuItem::with_id(app, "chat", "AI 助手", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Shutter", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &capture,
            &chat,
            &PredefinedMenuItem::separator(app)?,
            &gallery,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    // The tray must use the monochrome template icon, not the 512px app icon:
    // macOS tints template images for light/dark menu bars, and the app icon
    // would render oversized and coloured.
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))
        .expect("bundled tray icon");
    TrayIconBuilder::with_id("main")
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "capture" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::commands::start_capture(&app).await {
                        log::error!("capture from tray failed: {e:#}");
                    }
                });
            }
            "chat" => {
                let _ = open_chat(app, None, None);
            }
            "gallery" => {
                let _ = open_main(app, "gallery");
            }
            "settings" => {
                let _ = open_settings(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::commands::start_capture(&app).await {
                        log::error!("capture from tray click failed: {e:#}");
                    }
                });
            }
        })
        .build(app)?;

    Ok(())
}
