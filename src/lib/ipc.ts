/** Typed wrappers over the Rust command surface. Keep in sync with commands.rs. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type MonitorInfo = {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  scaleFactor: number;
  isPrimary: boolean;
};

export type CaptureSession = {
  sessionId: string;
  monitors: MonitorInfo[];
};

/** An on-screen window for the overlay's hover-to-select (macOS only). */
export type WindowInfo = {
  id: number;
  /** Global logical points, same space as MonitorInfo.x/y. */
  x: number;
  y: number;
  width: number;
  height: number;
  owner: string;
  title: string;
};

export type Rect = { x: number; y: number; width: number; height: number };

export type CaptureAction = "copy" | "save" | "pin" | "ask";

export type CaptureResult = {
  cropId: string;
  previewDataUrl: string;
  width: number;
  height: number;
  message: string | null;
  savedPath: string | null;
};

export type AiAction = "extract" | "translate" | "explain" | "ask" | "reply";

export type AiRequest = {
  cropId: string;
  action: AiAction;
  lang?: string;
  question?: string;
};

export type AiBind = { cropId: string; action: AiAction | null };

export type AiDelta = { requestId: string; text: string };
export type AiDone = { requestId: string; ok: boolean; error: string | null };

export type Preset = {
  label: string;
  baseUrl: string;
  model: string;
  note: string;
};

/** Where in-app updates download from; the CNB mirror is the default. */
export type UpdateSource = "cnb" | "github";

export type Settings = {
  baseUrl: string;
  model: string;
  translateLang: string;
  saveDir: string | null;
  copyAfterCapture: boolean;
  autoSave: boolean;
  /** Global capture hotkey as a `global-hotkey` accelerator string. */
  captureShortcut: string;
  /**
   * Serialized `UpdateSource`; kept optional because construction sites (the
   * settings form) don't set it — the backend defaults to the CNB mirror and
   * always returns the effective value.
   */
  updateSource?: UpdateSource;
};

/** Answer of `check_app_update` (Rust updater.rs). */
export type AppUpdateInfo = {
  currentVersion: string;
  latestVersion: string;
  notes: string | null;
};

/** Payload of the `app-update-progress` event. */
export type AppUpdateProgress = {
  downloaded: number;
  total: number | null;
};

/**
 * Result of the settings page's "test connection" probe.
 *
 * The backend reports failures in-band (`ok: false` plus `detail`) rather than
 * as a rejected invoke, so the UI can show the upstream message verbatim.
 */
export type ConnectionReport = {
  ok: boolean;
  /** Short human-readable verdict, already localised by Rust. */
  detail: string;
  /** Round trip of the deciding request, absent when it never got a response. */
  latencyMs: number | null;
  /** Which probe answered: `/models`, or a 1-token chat completion. */
  via: "models" | "probe" | null;
  /** Model ids the endpoint advertises; empty when it has no `/models` route. */
  models: string[];
};

/** One screenshot on disk, as listed by the gallery. */
export type GalleryItem = {
  path: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  /** Seconds since the Unix epoch, from the file's mtime. */
  createdAt: number;
};

/* -------------------------------------------------------- long screenshot */

/** Payload of `open_scroll_screenshot_event` (reference `scrollScreen` chunk).
 *
 * Sent by the screenshot overlay 100ms after it closes itself: Rust builds
 * the `scroll_screenshot_panel_<monitorId>` fullscreen window seeded with
 * these CSS-pixel selection bounds.
 */
export type OpenScrollScreenshot = {
  x: number;
  y: number;
  boundsWidth: number;
  boundsHeight: number;
  monitorIds: number;
  selectionScaleFactor: number;
};

/** Initial data Rust pushes into the scroll panel (`scroll_screenshot_data`). */
export type ScrollScreenshotData = {
  width: number;
  height: number;
  monitorId: number;
  boundsWidth: number;
  boundsHeight: number;
  x: number;
  y: number;
  selectionScaleFactor: number;
};

/** How `save_scroll_screenshot` should dispose of the stitched image
 * (reference `actionType`: "copy" | "saveAs"). */
export type ScrollSaveAction = "copy" | "saveAs";

export const api = {
  captureScreens: () => invoke<CaptureSession>("capture_screens"),
  currentSession: () => invoke<CaptureSession | null>("current_session"),
  /** On-screen windows, front-to-back; empty on platforms without support. */
  listWindows: () => invoke<WindowInfo[]>("list_windows"),
  cancelCapture: () => invoke<void>("cancel_capture"),
  confirmCapture: (
    monitorId: number,
    rect: Rect,
    action: CaptureAction,
    overlayDataUrl: string | null,
    savePath?: string | null,
    /** AI preset to auto-run ("ask" action only); Rust opens the chat window. */
    aiAction?: string | null,
  ) =>
    invoke<CaptureResult>("confirm_capture", {
      monitorId,
      rect,
      action,
      overlayDataUrl,
      savePath: savePath ?? null,
      aiAction: aiAction ?? null,
    }),
  aiAsk: (request: AiRequest, requestId: string) =>
    invoke<void>("ai_ask", { request, requestId }),
  getSettings: () => invoke<Settings>("get_settings"),
  modelPresets: () => invoke<Preset[]>("model_presets"),
  saveSettings: (settings: Settings) =>
    invoke<void>("save_settings_cmd", { settings }),
  /** Ask the backend which release is newest; `null` means up to date. */
  checkAppUpdate: (source: UpdateSource) =>
    invoke<AppUpdateInfo | null>("check_app_update", { source }),
  /** Download + install the expected version; progress via `app-update-progress`. */
  installAppUpdate: (source: UpdateSource, expectedVersion: string) =>
    invoke<void>("install_app_update", { source, expectedVersion }),
  setApiKey: (key: string) => invoke<void>("set_api_key", { key }),
  clearApiKey: () => invoke<void>("clear_api_key"),
  apiKeyStatus: () => invoke<boolean>("api_key_status"),
  /**
   * Probe a base URL + model with an optional not-yet-saved key.
   *
   * `apiKey: null` means "use the key already in the keychain", which is what
   * lets the test button work without forcing the user to save first.
   */
  testConnection: (baseUrl: string, model: string, apiKey: string | null) =>
    invoke<ConnectionReport>("test_connection", { baseUrl, model, apiKey }),
  /** Model ids advertised by `GET {baseUrl}/models`. */
  listModels: (baseUrl: string, apiKey: string | null) =>
    invoke<string[]>("list_models", { baseUrl, apiKey }),
  copyText: (text: string) => invoke<void>("copy_text_to_clipboard", { text }),
  openSettings: () => invoke<void>("open_settings_window"),
  openMain: (tab?: "gallery" | "ai" | "general" | "shortcuts" | "about") =>
    invoke<void>("open_main_window", { tab: tab ?? null }),
  listGallery: () => invoke<GalleryItem[]>("list_gallery"),
  galleryThumbnail: (path: string) =>
    invoke<string>("gallery_thumbnail", { path }),
  galleryFullImage: (path: string) =>
    invoke<string>("gallery_full_image", { path }),
  deleteGalleryItem: (path: string) =>
    invoke<void>("delete_gallery_item", { path }),
  saveDirectory: () => invoke<string>("save_directory"),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  openDirectory: (path: string) => invoke<void>("open_directory", { path }),
  chooseDirectory: () => invoke<string | null>("choose_directory"),
  /**
   * Native "save as" dialog. Returns null when the user cancelled — the
   * caller then cancels the capture (the reference semantics).
   */
  saveAsDialog: (defaultName: string) =>
    invoke<string | null>("save_as_dialog", { defaultName }),
  openChat: (cropId?: string, action?: AiAction) =>
    invoke<void>("open_chat_window", { cropId: cropId ?? null, action: action ?? null }),
  framePath: (monitorId: number, sessionId: string) =>
    invoke<string | null>("frame_path", { monitorId, sessionId }),
  saveCrop: (cropId: string) => invoke<string>("save_crop", { cropId }),
  cropDataUrl: (cropId: string) => invoke<string>("crop_data_url", { cropId }),
  pinCrop: (cropId: string) => invoke<void>("pin_crop", { cropId }),
  closePin: (pinId: string) => invoke<void>("close_pin", { pinId }),
  /* Long screenshot (scroll stitching) — reference command surface. */
  /** Overlay → Rust: close the overlays and build the scroll panel for this
   *  selection (the handover runs inside the command). */
  openScrollScreenshot: (payload: OpenScrollScreenshot) =>
    invoke<void>("open_scroll_screenshot_event", {
      payload: {
        x: payload.x,
        y: payload.y,
        boundsWidth: payload.boundsWidth,
        boundsHeight: payload.boundsHeight,
        monitorIds: payload.monitorIds,
        selectionScaleFactor: payload.selectionScaleFactor,
      },
    }),
  /** Scroll panel → Rust: mount handshake; the seed data rides the response
   *  (events race the webview load and have already proven unreliable). */
  scrollPanelLoaded: () => invoke<ScrollScreenshotData>("scroll_screenshot_panel_loaded_event"),
  /** Scroll panel → Rust: the selection is drawn; capture can begin. */
  drawnScrollScreenshot: () => invoke<void>("drawn_scroll_screenshot_event"),
  /** Scroll panel → Rust: begin scrolling+stitching (1000ms armed beat,
   *  then 1500ms capture arm, exactly the reference timers). */
  startScrollScreenshot: (payload: {
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
  }) =>
    invoke<void>("start_scroll_screenshot_event", {
      payload: {
        x: payload.x,
        y: payload.y,
        width: payload.width,
        height: payload.height,
        scaleFactor: payload.scaleFactor,
      },
    }),
  /** Control bar → Rust: mount handshake (disarms the watchdog); the owning
   *  monitor rides the response, null when no session is live. */
  scrollBarLoaded: () => invoke<{ monitor_id: number } | null>(
    "scroll_screenshot_bar_panel_loaded",
  ),
  /** Control bar / panel → Rust: pause or resume the auto-scroller
   *  (`isCancelScroll` is really "stop scrolling" in the reference). */
  cancelScrollScreenshot: (isCancelScroll: boolean) =>
    invoke<void>("cancel_scroll_screenshot_event", { isCancelScroll }),
  /** Control bar → Rust: finish and dispose of the stitched image.
   *  `monitorId` is the stale-bar guard; null skips it. */
  saveScrollScreenshot: (payload: {
    monitorId: number | null;
    actionType: ScrollSaveAction;
    filePath: string;
    autoSavePath: string;
  }) =>
    invoke<void>("save_scroll_screenshot", {
      payload: {
        monitorId: payload.monitorId,
        actionType: payload.actionType,
        filePath: payload.filePath,
        autoSavePath: payload.autoSavePath,
      },
    }),
  /** Scroll panel → Rust: live crop of the selection (下载/保存 before
   *  recording starts — reference `screenshot_crop_event`). */
  screenshotCrop: (payload: {
    monitorId: number;
    x: number;
    y: number;
    width: number;
    height: number;
    actionType: ScrollSaveAction;
    filePath: string;
    autoSavePath: string;
  }) =>
    invoke<void>("screenshot_crop_event", {
      payload: {
        monitorId: payload.monitorId,
        x: payload.x,
        y: payload.y,
        width: payload.width,
        height: payload.height,
        actionType: payload.actionType,
        filePath: payload.filePath,
        autoSavePath: payload.autoSavePath,
      },
    }),
  /** Panel → Rust: teardown without an image (hide + close). */
  hideScrollScreenshotPanel: () => invoke<void>("hide_scroll_screenshot_panel"),
  /** Reference generic: close one window by label. */
  closePanel: (label: string) => invoke<void>("close_panel", { label }),
};

export const events = {
  onAiDelta: (cb: (d: AiDelta) => void): Promise<UnlistenFn> =>
    listen<AiDelta>("ai://delta", (e) => cb(e.payload)),
  onAiDone: (cb: (d: AiDone) => void): Promise<UnlistenFn> =>
    listen<AiDone>("ai://done", (e) => cb(e.payload)),
  /** Fired when a new crop is handed to the chat window. */
  onAiBind: (cb: (d: AiBind) => void): Promise<UnlistenFn> =>
    listen<AiBind>("ai://bind", (e) => cb(e.payload)),
  /** Fired when the tray asks the main window to switch section. */
  onUiTab: (cb: (tab: string) => void): Promise<UnlistenFn> =>
    listen<string>("ui://tab", (e) => cb(e.payload)),
  /* Long screenshot events (reference names, emitted by Rust). */
  /** Rust → panel: initial window geometry + selection bounds. */
  onScrollScreenshotData: (cb: (d: ScrollScreenshotData) => void): Promise<UnlistenFn> =>
    listen<ScrollScreenshotData>("scroll_screenshot_data", (e) => cb(e.payload)),
  /** Rust → panel: full teardown (right-click quit / Escape). */
  onScrollScreenClear: (cb: () => void): Promise<UnlistenFn> =>
    listen("scroll_screen_clear", () => cb()),
  /** Rust → panel: stitching failed; show the error pill for 3s. */
  onScrollScreenshotError: (cb: (e: { message: string }) => void): Promise<UnlistenFn> =>
    listen<{ message: string }>("scroll_screenshot_error", (e) => cb(e.payload)),
  /** Rust → panel: the image window is up (panel becomes click-through). */
  onScrollScreenshotDrawn: (cb: () => void): Promise<UnlistenFn> =>
    listen("scroll_screenshot_drawn", () => cb()),
  /** Rust → panel: toggle the armed (将鼠标移入…) state. */
  onShowScrollTip: (cb: (on: boolean) => void): Promise<UnlistenFn> =>
    listen<boolean>("show_scroll_tip", (e) => cb(e.payload)),
  /** Rust → panel: stitching stopped; restore the window's cursor events. */
  onScrollScreenshotClickStop: (cb: () => void): Promise<UnlistenFn> =>
    listen("scroll_screenshot_click_stop", () => cb()),
  /** Rust → panel: the accumulated image PNG was replaced; re-read it. */
  onScrollImageUpdate: (
    cb: (e: { path: string }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ path: string }>("scroll_screenshot_image_update_event", (e) =>
      cb(e.payload),
    ),
  /** Rust → bar: which monitor's session is live (reference `monitor_id`). */
  onStartScreenRecording: (
    cb: (e: { monitor_id: number }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ monitor_id: number }>("start_screen_recording_event", (e) =>
      cb(e.payload),
    ),
  /** Rust → control bar: pause state flipped (停止滚动/继续滚动). */
  onScrollPauseState: (cb: (paused: boolean) => void): Promise<UnlistenFn> =>
    listen<boolean>("scroll_screenshot_pause_state", (e) => cb(e.payload)),
};

/** Errors from Rust arrive as strings; normalise them for display. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
