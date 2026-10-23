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

export type Settings = {
  baseUrl: string;
  model: string;
  translateLang: string;
  saveDir: string | null;
  copyAfterCapture: boolean;
  autoSave: boolean;
  /** Global capture hotkey as a `global-hotkey` accelerator string. */
  captureShortcut: string;
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

/** Which phase a scroll-capture session is in. */
export type ScrollPhase = "idle" | "recording" | "paused" | "finished" | "failed";

/** Live state of the scroll-capture session, pushed via `scroll://state`. */
export type ScrollStatus = {
  sessionId: string | null;
  phase: ScrollPhase;
  /** Total height of the stitched image, in physical px. */
  height: number;
  /** Selection width/height in physical px. */
  width: number;
  /** Whether the auto-scroller is injecting wheel events (vs manual mode). */
  autoScroll: boolean;
  /** Why the auto-scroller stopped, in user-facing Chinese. */
  note: string | null;
};

/** Result of finishing a scroll capture, via `scroll://done`. */
export type ScrollDone = {
  sessionId: string;
  ok: boolean;
  /** Stitched dimensions in physical px. */
  width: number;
  height: number;
  message: string | null;
  savedPath: string | null;
};

/** Preview update payload, via `scroll://preview`. */
export type ScrollPreview = {
  sessionId: string;
  /** Atomic-replaced PNG of the stitched image so far. */
  path: string;
  width: number;
  height: number;
};

/** Transient hint shown over the selection, via `scroll://tip`. */
export type ScrollTip = {
  sessionId: string;
  /** Kind selects styling/urgency, matching the reference's state machine. */
  kind: "info" | "warn" | "error" | "bottom";
  text: string;
};

/** How `scroll_stop` should dispose of the stitched image. */
export type ScrollFinishAction = "save" | "copy" | "cancel";

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
  openMain: (tab?: "gallery" | "settings" | "about") =>
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
  /* Long screenshot (scroll stitching). */
  scrollStart: (monitorId: number, rect: Rect) =>
    invoke<ScrollStatus>("scroll_start", { monitorId, rect }),
  scrollPause: () => invoke<ScrollStatus>("scroll_pause"),
  scrollResume: () => invoke<ScrollStatus>("scroll_resume"),
  scrollStop: (action: ScrollFinishAction) =>
    invoke<ScrollDone | null>("scroll_stop", { action }),
  scrollStatus: () => invoke<ScrollStatus>("scroll_status"),
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
  /** Fired when the tray wants a specific control focused (e.g. shortcuts). */
  onUiFocus: (cb: (target: string) => void): Promise<UnlistenFn> =>
    listen<string>("ui://focus", (e) => cb(e.payload)),
  /* Long screenshot events. */
  onScrollState: (cb: (s: ScrollStatus) => void): Promise<UnlistenFn> =>
    listen<ScrollStatus>("scroll://state", (e) => cb(e.payload)),
  onScrollPreview: (cb: (p: ScrollPreview) => void): Promise<UnlistenFn> =>
    listen<ScrollPreview>("scroll://preview", (e) => cb(e.payload)),
  onScrollTip: (cb: (t: ScrollTip) => void): Promise<UnlistenFn> =>
    listen<ScrollTip>("scroll://tip", (e) => cb(e.payload)),
  onScrollDone: (cb: (d: ScrollDone) => void): Promise<UnlistenFn> =>
    listen<ScrollDone>("scroll://done", (e) => cb(e.payload)),
};

/** Errors from Rust arrive as strings; normalise them for display. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
