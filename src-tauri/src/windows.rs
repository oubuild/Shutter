//! Utility windows (settings, chat) and the tray menu.

use anyhow::Result;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

/// A fullscreen chromeless layer window: transparent, borderless, always on
/// top, non-resizable. The one shape shared by the screenshot overlay, the
/// scroll panel and the scroll control bar (`focused(false)` — the bar must
/// not steal focus from the page being captured). Pin windows deliberately
/// differ (shadow, resizable) and stay hand-built in `pin.rs`.
pub fn layer_window(
    app: &AppHandle,
    label: &str,
    url: &str,
    title: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    focused: bool,
) -> Result<WebviewWindow> {
    Ok(WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .position(x, y)
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        .focused(focused)
        .visible(true)
        .build()?)
}

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
    // `visible(true)` is the default, but an Accessory app can end up with a
    // window that is built yet never ordered on screen. Being explicit (and
    // centering it) makes an auxiliary window always land in front of the user.
    .visible(true)
    .center()
    .build()?;
    let _ = win.show();
    focus_when_ready(win.clone());
    log::info!(
        "window {label} built: visible={:?} size={:?} pos={:?}",
        win.is_visible(),
        win.inner_size(),
        win.outer_position()
    );
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
        focus_when_ready(win.clone());
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

    // Keep the native window frame: the OS owns the traffic lights on macOS and
    // the caption buttons on Windows/Linux, so behaviour (close, minimise,
    // zoom, resize, full-screen) is exactly what the platform expects.
    //
    // macOS additionally gets the overlay title-bar style: the title is hidden,
    // the view extends under the title bar, and the traffic lights are inset to
    // line up with the webview's 52px header row (see `Main.tsx`). This only
    // works with `decorations(true)` — without decorations macOS reports a
    // borderless window and draws no buttons at all.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(18.0, 20.0));
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(true).transparent(false);
    }

    let win = builder.build()?;
    focus_when_ready(win.clone());
    Ok(win)
}

/// Open the settings section of the main window.
pub fn open_settings(app: &AppHandle) -> Result<()> {
    open_main(app, "settings")?;
    Ok(())
}

/// Bring a freshly built window to the front once it is actually on screen.
///
/// This is a menu-bar (Accessory) app: creating a window does not activate the
/// app, and `set_focus()` is a no-op while the window is still loading/not
/// visible (tao checks `isVisible` first). A single delayed call is not enough
/// in dev, where the webview can take a second to boot. Retry until the window
/// reports focus so the first click the user makes is not swallowed by macOS
/// merely activating the window.
pub(crate) fn focus_when_ready(win: WebviewWindow) {
    std::thread::spawn(move || {
        for _ in 0..30 {
            let _ = win.show();
            let _ = win.set_focus();
            if win.is_focused().unwrap_or(false) {
                log::info!("window {} shown and focused", win.label());
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        log::warn!("window {} did not take focus", win.label());
    });
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
    log::info!("open_chat: crop={crop_id:?} action={action:?}");
    let win = open(app, "chat", &view, "Shutter AI", 680.0, 720.0).map_err(|e| {
        log::error!("open_chat failed: {e:#}");
        e
    })?;
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

/// Menu-bar menu. Rebuilt (not mutated) whenever the capture hotkey changes so
/// the displayed accelerator cannot go stale.
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let accel = format_accelerator(&crate::settings::load_settings().capture_shortcut);
    let capture = MenuItem::with_id(app, "capture", format!("截图  {accel}"), true, None::<&str>)?;
    let gallery = MenuItem::with_id(app, "gallery", "打开 Shutter", true, None::<&str>)?;
    let chat = MenuItem::with_id(app, "chat", "AI 助手", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let shortcuts = MenuItem::with_id(app, "shortcuts", "快捷键…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Shutter", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &capture,
            &chat,
            &PredefinedMenuItem::separator(app)?,
            &gallery,
            &settings,
            &shortcuts,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

/// Repaint the tray menu after a rebind (the capture row shows the accelerator).
pub fn refresh_tray(app: &AppHandle) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(build_tray_menu(app)?))?;
    }
    Ok(())
}

/// Accelerator → the label a menu can show.
///
/// macOS convention is a run of symbols (`⌘⇧A`); the other platforms spell the
/// modifiers out (`Ctrl+Shift+A`).
pub fn format_accelerator(accel: &str) -> String {
    let tokens: Vec<&str> = accel.split('+').map(str::trim).filter(|t| !t.is_empty()).collect();
    let Some((key, mods)) = tokens.split_last() else {
        return accel.to_string();
    };
    if mods.is_empty() {
        return key_label(key);
    }

    #[cfg(target_os = "macos")]
    {
        // Exact token matching: "CmdOrControl" contains "CONTROL" as a
        // substring but means ⌘ on macOS, so substring tests would add a stray ⌃.
        let has = |needles: &[&str]| {
            mods.iter().any(|m| {
                let upper = m.to_uppercase();
                needles.contains(&upper.as_str())
            })
        };
        let mut out = String::new();
        if has(&["CTRL", "CONTROL"]) {
            out.push('⌃');
        }
        if has(&["ALT", "OPTION"]) {
            out.push('⌥');
        }
        if has(&["SHIFT"]) {
            out.push('⇧');
        }
        if has(&[
            "CMD",
            "COMMAND",
            "SUPER",
            "CMDORCONTROL",
            "CMDORCTRL",
            "COMMANDORCONTROL",
            "COMMANDORCTRL",
        ]) {
            out.push('⌘');
        }
        out.push_str(&key_label(key));
        out
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut parts: Vec<String> = mods.iter().map(|m| modifier_name(m)).collect();
        parts.push(key_label(key));
        parts.join("+")
    }
}

#[cfg(target_os = "macos")]
fn key_label(token: &str) -> String {
    let upper = token.to_uppercase();
    if let Some(rest) = upper.strip_prefix("KEY") {
        return rest.to_string();
    }
    if let Some(rest) = upper.strip_prefix("DIGIT") {
        return rest.to_string();
    }
    match upper.as_str() {
        "ENTER" | "RETURN" => "↩".into(),
        "ESCAPE" | "ESC" => "⎋".into(),
        "SPACE" => "Space".into(),
        "TAB" => "⇥".into(),
        "BACKSPACE" => "⌫".into(),
        "DELETE" => "⌦".into(),
        "ARROWUP" | "UP" => "↑".into(),
        "ARROWDOWN" | "DOWN" => "↓".into(),
        "ARROWLEFT" | "LEFT" => "←".into(),
        "ARROWRIGHT" | "RIGHT" => "→".into(),
        "BACKQUOTE" => "`".into(),
        "MINUS" => "-".into(),
        "EQUAL" => "=".into(),
        "BRACKETLEFT" => "[".into(),
        "BRACKETRIGHT" => "]".into(),
        "BACKSLASH" => "\\".into(),
        "SEMICOLON" => ";".into(),
        "QUOTE" => "'".into(),
        "COMMA" => ",".into(),
        "PERIOD" => ".".into(),
        "SLASH" => "/".into(),
        other => other.to_string(),
    }
}

#[cfg(not(target_os = "macos"))]
fn key_label(token: &str) -> String {
    let upper = token.to_uppercase();
    if let Some(rest) = upper.strip_prefix("KEY") {
        return rest.to_string();
    }
    if let Some(rest) = upper.strip_prefix("DIGIT") {
        return rest.to_string();
    }
    match upper.as_str() {
        "ENTER" | "RETURN" => "Enter".into(),
        "ESCAPE" | "ESC" => "Esc".into(),
        "SPACE" => "Space".into(),
        "TAB" => "Tab".into(),
        "BACKSPACE" => "Backspace".into(),
        "DELETE" => "Delete".into(),
        "ARROWUP" | "UP" => "Up".into(),
        "ARROWDOWN" | "DOWN" => "Down".into(),
        "ARROWLEFT" | "LEFT" => "Left".into(),
        "ARROWRIGHT" | "RIGHT" => "Right".into(),
        other => other.to_string(),
    }
}

#[cfg(not(target_os = "macos"))]
fn modifier_name(token: &str) -> String {
    match token.to_uppercase().as_str() {
        "SHIFT" => "Shift".into(),
        "ALT" | "OPTION" => "Alt".into(),
        "CMD" | "COMMAND" | "SUPER" => "Cmd".into(),
        _ => "Ctrl".into(),
    }
}

pub fn set_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;

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
            // Open the preferences pane and scroll it to the shortcuts card.
            // The window may still be loading on first open, so the focus event
            // is replayed once the webview is up.
            "shortcuts" => {
                let _ = open_settings(app);
                let handle = app.clone();
                std::thread::spawn(move || {
                    use tauri::Emitter;
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    let _ = handle.emit("ui://focus", "shortcuts");
                });
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
