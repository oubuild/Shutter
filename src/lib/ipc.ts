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

export type Rect = { x: number; y: number; width: number; height: number };

export type CaptureAction = "copy" | "save" | "pin";

export type CaptureResult = {
  cropId: string;
  previewDataUrl: string;
  width: number;
  height: number;
  message: string | null;
  savedPath: string | null;
};

export type AiAction = "extract" | "translate" | "explain" | "ask";

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
};

export const api = {
  captureScreens: () => invoke<CaptureSession>("capture_screens"),
  currentSession: () => invoke<CaptureSession | null>("current_session"),
  cancelCapture: () => invoke<void>("cancel_capture"),
  confirmCapture: (
    monitorId: number,
    rect: Rect,
    action: CaptureAction,
    overlayDataUrl: string | null,
  ) =>
    invoke<CaptureResult>("confirm_capture", {
      monitorId,
      rect,
      action,
      overlayDataUrl,
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
  copyText: (text: string) => invoke<void>("copy_text_to_clipboard", { text }),
  openSettings: () => invoke<void>("open_settings_window"),
  openChat: (cropId?: string, action?: AiAction) =>
    invoke<void>("open_chat_window", { cropId: cropId ?? null, action: action ?? null }),
  framePath: (monitorId: number, sessionId: string) =>
    invoke<string | null>("frame_path", { monitorId, sessionId }),
  saveCrop: (cropId: string) => invoke<string>("save_crop", { cropId }),
  cropDataUrl: (cropId: string) => invoke<string>("crop_data_url", { cropId }),
  pinCrop: (cropId: string) => invoke<void>("pin_crop", { cropId }),
  closePin: (pinId: string) => invoke<void>("close_pin", { pinId }),
};

export const events = {
  onAiDelta: (cb: (d: AiDelta) => void): Promise<UnlistenFn> =>
    listen<AiDelta>("ai://delta", (e) => cb(e.payload)),
  onAiDone: (cb: (d: AiDone) => void): Promise<UnlistenFn> =>
    listen<AiDone>("ai://done", (e) => cb(e.payload)),
  /** Fired when a new crop is handed to the chat window. */
  onAiBind: (cb: (d: AiBind) => void): Promise<UnlistenFn> =>
    listen<AiBind>("ai://bind", (e) => cb(e.payload)),
};

/** Errors from Rust arrive as strings; normalise them for display. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
