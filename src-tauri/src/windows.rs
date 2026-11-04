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
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
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
        .build()?;
    raise_above_dock(&win);
    Ok(win)
}

/// Raise a window above the macOS Dock and menu bar.
///
/// Tauri's `always_on_top` tops out at `NSFloatingWindowLevel` (3), which
/// sits UNDER the Dock's composite level — a toolbar or control bar parked
/// near a screen edge is drawn behind the Dock. `kCGPopUpMenuWindowLevel`
/// (101) is far above every system chrome short of the screen saver, which
/// is where capture overlays belong.
///
/// The `setLevel:` call is a raw `msg_send` dispatched to the main thread:
/// layer windows are built from command/hotkey threads, and AppKit property
/// access off the main thread crashes the process (Tauri's own window APIs
/// marshal internally; this must do the same).
#[cfg(target_os = "macos")]
pub(crate) fn raise_above_dock(win: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    let target = win.clone();
    let res = win.app_handle().run_on_main_thread(move || {
        let Ok(ns) = target.ns_window() else {
            return;
        };
        let w = ns as *mut AnyObject;
        if w.is_null() {
            return;
        }
        let w: &AnyObject = unsafe { &*w };
        // kCGPopUpMenuWindowLevel: above the Dock, the menu bar and any
        // status items; only the screen-saver shield is higher.
        let level: isize = 101;
        let _: () = unsafe { msg_send![w, setLevel: level] };
        // Read back: if anything else re-asserts a level, this line is what
        // makes it visible in the log.
        let now: isize = unsafe { msg_send![w, level] };
        log::info!("window {} level -> {now}", target.label());
    });
    if let Err(e) = res {
        log::warn!("raise above dock for {}: {e}", win.label());
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn raise_above_dock(_win: &WebviewWindow) {}

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

/// Open (or refocus) the main window: the gallery shell. `tab` is legacy
/// (only `gallery` is used now that settings live in their own fixed windows);
/// when the window already exists it is only shown and focused — never
/// recreated, which keeps the gallery scroll position.
pub fn open_main(app: &AppHandle, tab: &str) -> Result<WebviewWindow> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.unminimize();
        focus_when_ready(win.clone());
        let _ = tab;
        return Ok(win);
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::App(format!("index.html?view=main&tab={tab}").into()),
    )
    .title("Shutter")
    // The gallery is a fixed companion strip (like the reference tool):
    // 400×740, not resizable or maximizable.
    .inner_size(400.0, 740.0)
    .min_inner_size(400.0, 740.0)
    .maximizable(false)
    .resizable(false);

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

/// Open the settings area of the main window on its first pane (AI 服务).
///
/// Since the settings moved out of the main window into fixed auxiliary
/// windows (popover menu → 二级窗口), this steers to 更多设置 on AI 服务.
pub fn open_settings(app: &AppHandle) -> Result<()> {
    open_settings_page(app, "more", Some("ai"))?;
    Ok(())
}

/// A fixed-size auxiliary window with the standard OS title bar. Reopening
/// reuses the live window (show + focus) instead of stacking copies — the
/// settings forms keep unsaved state, and recreating would flash "加载中…".
pub fn open_fixed_window(
    app: &AppHandle,
    label: &str,
    title: &str,
    query: &str,
    w: f64,
    h: f64,
) -> Result<WebviewWindow> {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        focus_when_ready(win.clone());
        return Ok(win);
    }
    let win = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("index.html?{query}").into()),
    )
    .title(title)
    .inner_size(w, h)
    .min_inner_size(w, h)
    .resizable(false)
    .maximizable(false)
    .transparent(false)
    .visible(true)
    .center()
    .build()?;
    focus_when_ready(win.clone());
    log::info!("fixed window {label} built: {:?}", win.inner_size());
    Ok(win)
}

/// The settings secondary windows opened from the popover menu, the tray and
/// the AI window. `page` is one of `shortcut` / `save` / `more`; only `more`
/// takes a `tab` (its top tab bar). A `more` window that already exists is
/// steered to the tab through `settings://tab` rather than rebuilt.
pub fn open_settings_page(
    app: &AppHandle,
    page: &str,
    tab: Option<&str>,
) -> Result<WebviewWindow> {
    match page {
        "shortcut" => open_fixed_window(
            app,
            "settings_shortcut",
            "快捷键设置",
            "view=settings&page=shortcut",
            460.0,
            560.0,
        ),
        "save" => open_fixed_window(
            app,
            "settings_save",
            "保存设置",
            "view=settings&page=save",
            520.0,
            500.0,
        ),
        _ => {
            let tab = tab.unwrap_or("ai");
            if let Some(win) = app.get_webview_window("settings_more") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
                focus_when_ready(win.clone());
                use tauri::Emitter;
                let _ = win.emit("settings://tab", tab);
                return Ok(win);
            }
            open_fixed_window(
                app,
                "settings_more",
                "更多设置",
                &format!("view=settings&page=more&tab={tab}"),
                640.0,
                660.0,
            )
        }
    }
}

/// The about window (menu 关于 Shutter).
pub fn open_about(app: &AppHandle) -> Result<WebviewWindow> {
    open_fixed_window(app, "about", "关于 Shutter", "view=about", 560.0, 680.0)
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
    // Park the binding for the window to pull on mount — the events below
    // can fire before a still-loading webview has subscribed (dev cold boot).
    if let (Some(state), Some(id)) = (app.try_state::<crate::ChatBind>(), crop_id) {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some((id.to_string(), action.map(str::to_string)));
        }
    }
    let win = open(app, "chat", &view, "Shutter AI", 900.0, 640.0).map_err(|e| {
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
///
/// Item set mirrors the reference tray (截图/录屏/长截图/设置/关于/退出);
/// 录屏 is not implemented in Shutter, and the gallery/shortcuts entries are
/// Shutter's own extras.
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let accel = format_accelerator(&crate::settings::load_settings().capture_shortcut);
    let capture = MenuItem::with_id(app, "capture", format!("截图  {accel}"), true, None::<&str>)?;
    let longshot = MenuItem::with_id(app, "longshot", "长截图", true, None::<&str>)?;
    let gallery = MenuItem::with_id(app, "gallery", "打开 Shutter", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let shortcuts = MenuItem::with_id(app, "shortcuts", "快捷键…", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "关于 Shutter", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Shutter", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &capture,
            &longshot,
            &PredefinedMenuItem::separator(app)?,
            &gallery,
            &settings,
            &shortcuts,
            &about,
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
            "longshot" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    // Boots the overlay with ?boot=scroll: the scroll session
                    // starts once the user frames a selection.
                    crate::overlay::request_boot_tool("scroll");
                    if let Err(e) = crate::commands::start_capture(&app).await {
                        log::error!("long screenshot from tray failed: {e:#}");
                    }
                });
            }
            "gallery" => {
                let _ = open_main(app, "gallery");
            }
            "settings" => {
                let _ = open_settings(app);
            }
            "shortcuts" => {
                let _ = open_settings_page(app, "shortcut", None);
            }
            "about" => {
                let _ = open_about(app);
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
