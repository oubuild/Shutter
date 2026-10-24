import React from "react";
import ReactDOM from "react-dom/client";
import { Overlay } from "./routes/Overlay";
import { Pin } from "./routes/Pin";
import { Chat } from "./routes/Chat";
import { ScrollBar } from "./routes/ScrollBar";
import { Main, type Tab } from "./routes/Main";
import { installBootGuard, markMounted } from "./lib/boot-guard";
import "./styles/capture.css";
// UnoCSS output: the antfu design layer + utilities used by the settings pane.
// Loaded after app.css so utility classes win over the legacy element rules.
import "virtual:uno.css";

/**
 * One bundle, five window shapes. The Rust side opens every window with
 * `index.html?view=<name>`, so routing stays a plain query parameter and we
 * avoid pulling in a router for five static screens.
 */
function pickTab(value: string | null): Tab {
  return value === "settings" || value === "about" ? value : "gallery";
}

function pickView(): React.ReactElement {
  const params = new URLSearchParams(window.location.search);
  switch (params.get("view")) {
    case "pin":
      return <Pin pinId={params.get("id") ?? ""} />;
    case "chat":
      return <Chat />;
    case "scrollbar":
      return <ScrollBar />;
    case "main":
      return <Main initialTab={pickTab(params.get("tab"))} />;
    // The settings window was folded into `main`; keep the route so an old
    // window URL (or a bookmarked dev URL) still renders something sensible.
    case "settings":
      return <Main initialTab="settings" />;
    case "overlay":
    default:
      return <Overlay monitorId={Number(params.get("monitor") ?? 0)} />;
  }
}

/**
 * A colourful stand-in for the frozen desktop, as a data URL.
 *
 * Browsers cannot read the screen, but the mosaic/blur tools still need a real
 * image to sample. Gradients plus hard edges make a wrong block size or an
 * offset mask obvious at a glance, which flat grey would hide.
 */
function mockFrameUrl(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#1b77ff"/>
        <stop offset="0.5" stop-color="#f22b24"/>
        <stop offset="1" stop-color="#05a532"/>
      </linearGradient>
    </defs>
    <rect width="1440" height="900" fill="url(#g)"/>
    <g fill="#fff" font-family="-apple-system, sans-serif">
      <text x="80" y="160" font-size="64" font-weight="700">Shutter mock frame</text>
      <text x="80" y="240" font-size="28" opacity="0.85">mosaic / blur tools sample this image</text>
    </g>
    <g stroke="#000" stroke-width="6" fill="none">
      <rect x="120" y="320" width="360" height="240"/>
      <circle cx="700" cy="440" r="120"/>
      <path d="M900 320 L1200 560 M1200 320 L900 560"/>
    </g>
    <g fill="#000" opacity="0.6">
      ${Array.from({ length: 18 }, (_, i) => `<rect x="${80 + i * 72}" y="700" width="36" height="120"/>`).join("")}
    </g>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Automation affordance: when the page is opened in a plain browser (no Tauri
 * runtime — e.g. driving the dev server from a test), install a canned IPC
 * mock so every window can be exercised end to end. Inside the real app
 * `__TAURI_INTERNALS__` always exists and this block is inert.
 *
 * The mock also backs the AI window's stream protocol: `ai_ask` answers with
 * canned text over `ai://delta` / `ai://done`, and `window.__emitTauriEvent`
 * lets a test replay any event (including `ai://bind`) deterministically.
 */
function installIpcMock() {
  if ("__TAURI_INTERNALS__" in window) return;

  type EventHandler = (payload: unknown) => void;
  type Listener = { eventId: number; handler: number };
  /** Rust hands the webview callback ids; `plugin:event|listen` binds them to names. */
  const callbacks = new Map<number, EventHandler>();
  /**
   * Event name → listeners. Tauri keeps two ids per listener: the callback id
   * (where the handler lives) and the event id returned by `listen`, which is
   * what `unlisten` passes back. Removing by callback id would leak a handler
   * on every StrictMode remount and double every streamed delta.
   */
  const listeners = new Map<string, Listener[]>();
  let nextId = 1;
  let nextEventId = 1;

  const dropListener = (event: string, eventId: number) => {
    listeners.set(
      event,
      (listeners.get(event) ?? []).filter((entry) => entry.eventId !== eventId),
    );
  };

  const session = {
    sessionId: "mock",
    monitors: [
      {
        id: 0,
        name: "Mock",
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        pixelWidth: 2880,
        pixelHeight: 1800,
        scaleFactor: 2,
        isPrimary: true,
      },
    ],
  };

  const settings = {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    translateLang: "简体中文",
    saveDir: null as string | null,
    copyAfterCapture: true,
    autoSave: true,
    captureShortcut: "CmdOrControl+Shift+KeyA",
  };

  const presets = [
    {
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      note: "官方端点",
    },
    {
      label: "通义千问",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-vl-max",
      note: "阿里云百炼",
    },
    {
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      note: "官方端点",
    },
  ];

  /**
   * Stand-in for the frozen screenshot Rust keeps. Drawn once with canvas so
   * the preview, the zoom controls and the copy/save buttons all have real
   * pixels (and a real natural size) to work with.
   */
  function sampleCrop(): string {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 760;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return "";
    const font = '-apple-system, "PingFang SC", "Helvetica Neue", sans-serif';
    const round = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    ctx.fillStyle = "#e8ecf2";
    ctx.fillRect(0, 0, 1200, 760);

    // Window chrome.
    ctx.fillStyle = "rgba(24, 32, 44, 0.08)";
    round(44, 52, 1112, 664, 18);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    round(40, 44, 1120, 664, 18);
    ctx.fill();

    ctx.fillStyle = "#f7f8fa";
    round(40, 44, 1120, 64, 18);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(40, 96, 1120, 12);
    ["#f26d6d", "#f2c14e", "#5ec26a"].forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(72 + i * 22, 76, 6, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = "#4b5563";
    ctx.font = `600 19px ${font}`;
    ctx.textAlign = "center";
    ctx.fillText("产品讨论 · 截图工具", 600, 83);
    ctx.textAlign = "left";

    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, 108);
    ctx.lineTo(1160, 108);
    ctx.stroke();

    // Incoming bubble.
    ctx.fillStyle = "#f1f3f6";
    round(88, 148, 520, 150, 14);
    ctx.fill();
    ctx.fillStyle = "#24262b";
    ctx.font = `17px ${font}`;
    const incoming = [
      "这个截图工具的标注功能挺顺手，",
      "但导出速度有点慢，一张要等两秒。",
      "另外希望支持把标注结果直接发到群里。",
    ];
    incoming.forEach((line, i) => ctx.fillText(line, 112, 186 + i * 34));

    // Reply bubble.
    ctx.fillStyle = "#2563eb";
    round(612, 330, 500, 120, 14);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `17px ${font}`;
    const outgoing = ["导出慢是因为在等缩略图落盘，", "我这两周会改成先返回再写文件。"];
    outgoing.forEach((line, i) => ctx.fillText(line, 640, 372 + i * 34));

    // Timestamp + system line.
    ctx.fillStyle = "#9aa0aa";
    ctx.font = `14px ${font}`;
    ctx.textAlign = "center";
    ctx.fillText("今天 10:24", 600, 132);
    ctx.fillText("对方正在输入…", 600, 520);
    ctx.textAlign = "left";

    // Composer.
    ctx.strokeStyle = "#e5e7eb";
    ctx.beginPath();
    ctx.moveTo(40, 596);
    ctx.lineTo(1160, 596);
    ctx.stroke();
    ctx.fillStyle = "#f7f8fa";
    round(88, 620, 960, 56, 12);
    ctx.fill();
    ctx.fillStyle = "#9aa0aa";
    ctx.font = `16px ${font}`;
    ctx.fillText("输入消息…", 112, 655);
    ctx.fillStyle = "#2563eb";
    round(1064, 620, 88, 56, 12);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 16px ${font}`;
    ctx.textAlign = "center";
    ctx.fillText("发送", 1108, 655);
    ctx.textAlign = "left";

    return canvas.toDataURL("image/png");
  }

  const cropUrl = sampleCrop();

  const canned: Record<string, string> = {
    extract:
      "这个截图工具的标注功能挺顺手，但导出速度有点慢，一张要等两秒。\n另外希望支持把标注结果直接发到群里。\n\n导出慢是因为在等缩略图落盘，我这两周会改成先返回再写文件。\n今天 10:24",
    translate:
      "The annotation features in this screenshot tool are quite handy, but exporting is a bit slow — about two seconds per image.\n\nI'd also like to send the annotated result straight to the group chat.\n\nExporting is slow because it waits for the thumbnail to be written to disk. I'll change it to return first and write the file afterwards within two weeks.",
    explain:
      "这段对话在讨论截图工具的体验问题：\n\n1. 用户认可标注功能，但认为导出耗时约 2 秒偏慢；\n2. 用户希望标注结果能直接分享到群聊；\n3. 开发方解释慢在「等待缩略图落盘」，并承诺两周内改为先返回结果、异步写文件。\n\n结论：这是一个已定位原因、有明确排期的性能问题，外加一个待评估的分享需求。",
    reply:
      "可以试这几条：\n\n1. 收到，导出慢的原因已经定位到缩略图落盘，两周内会改成先返回再写文件。\n2. 分享到群聊的需求我记下了，下个版本评估一下实现方式。\n3. 这两周先给你一个临时方案：导出后自动复制到剪贴板，直接粘贴发群。",
    ask:
      "根据截图里的对话，可以确认三点：\n\n1. 标注功能本身获得认可；\n2. 导出速度是当前主要抱怨点，约 2 秒/张；\n3. 对方已定位原因（缩略图落盘）并给出两周内的修复计划。\n\n如果你要回复对方，重点可以放在确认排期和分享需求的优先级上。",
  };

  /** Test hook: streamed answers can be paused so a spec can emit deltas itself. */
  const mock = {
    autoStream: true,
    lastRequestId: null as string | null,
    lastAction: null as string | null,
    lastCopied: null as string | null,
    openedSettings: 0,
    settings,
    emit: (event: string, payload: unknown) => emitEvent(event, payload),
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
  };

  /* --------------------------------------------- long screenshot (scroll) */

  /**
   * The mock's stand-in for the stitched image: a canvas data-URL of a tall
   * gradient with repeating text lines, cached per height so the thumbnail
   * visibly grows as `height` climbs. The mock IPC hands this out through
   * `convertFileSrc` for the well-known preview path.
   */
  function scrollPreviewUrl(height: number): string {
    const w = 600;
    const h = Math.max(400, Math.round(height));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return "";
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#eef2f7");
    grad.addColorStop(1, "#dfe7f2");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    // Fixed header band, so the sticky-strip behaviour is visible too.
    ctx.fillStyle = "#24262b";
    ctx.fillRect(0, 0, w, 36);
    ctx.fillStyle = "#ffffff";
    ctx.font = '600 15px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText("Shutter mock · 长截图预览", 16, 24);
    ctx.fillStyle = "#4b5563";
    ctx.font = '14px -apple-system, "PingFang SC", sans-serif';
    let y = 64;
    let line = 1;
    while (y < h - 12) {
      ctx.fillText(`第 ${line} 行 · 滚动拼接内容 (${Math.round(y)}px)`, 16, y);
      y += 28;
      line += 1;
    }
    return canvas.toDataURL("image/png");
  }

  const previewByHeight = new Map<number, string>();

  /** Long-screenshot session state machine, mirroring the Rust worker. */
  const scrollMock = {
    sessionId: null as string | null,
    phase: "idle" as "idle" | "armed" | "recording" | "paused" | "finished" | "failed",
    height: 400,
    width: 600,
    timer: null as number | null,
    previewPath: "mock-scroll-preview",

    state() {
      return {
        sessionId: this.sessionId,
        phase: this.phase,
        height: this.phase === "idle" ? 0 : this.height,
        width: this.phase === "idle" ? 0 : this.width,
        autoScroll: true,
        note: null as string | null,
      };
    },

    publish() {
      const height = this.height;
      let url = previewByHeight.get(height);
      if (url === undefined) {
        url = scrollPreviewUrl(height);
        previewByHeight.set(height, url);
      }
      // The overlay's convertFileSrc is the identity in the mock, so the
      // preview component needs the data-URL under the well-known path.
      const w = (window as unknown as { __scrollPreviewUrl?: string });
      w.__scrollPreviewUrl = url;
      emitEvent("scroll://preview", {
        sessionId: this.sessionId,
        path: this.previewPath,
        width: this.width,
        height,
      });
      emitEvent("scroll://state", this.state());
    },

    tick() {
      this.height = Math.min(this.height + 220, 2600);
      this.publish();
      if (this.height >= 2600) {
        this.finish("已到达页面底部");
      }
    },

    start() {
      this.stopTimer();
      this.sessionId = "mock-scroll";
      // Reference flow: the session starts armed (isStart) and only begins
      // scrolling when the pointer enters the selection mask.
      this.phase = "armed";
      this.height = 400;
      emitEvent("scroll://state", this.state());
      return this.state();
    },

    /** Pointer entered the selection mask: begin scrolling. */
    enter() {
      if (this.phase === "armed") {
        this.phase = "recording";
        emitEvent("scroll://state", this.state());
        this.stopTimer();
        this.timer = window.setInterval(() => this.tick(), 700);
      }
      return this.state();
    },

    /** Pointer left the selection: park back in armed (timer stops). */
    leave() {
      if (this.phase === "recording") {
        this.stopTimer();
        this.phase = "armed";
        emitEvent("scroll://state", this.state());
      }
      return this.state();
    },

    pause() {
      this.stopTimer();
      if (this.phase === "recording") {
        this.phase = "paused";
        emitEvent("scroll://state", this.state());
      }
      return this.state();
    },

    resume() {
      if (this.phase === "paused") {
        this.phase = "recording";
        emitEvent("scroll://state", this.state());
        this.stopTimer();
        this.timer = window.setInterval(() => this.tick(), 700);
      }
      return this.state();
    },

    stopTimer() {
      if (this.timer !== null) {
        window.clearInterval(this.timer);
        this.timer = null;
      }
    },

    finish(message: string | null) {
      this.stopTimer();
      this.phase = "finished";
      const done = {
        sessionId: this.sessionId ?? "mock-scroll",
        ok: message !== null ? message.includes("已") : true,
        width: this.width,
        height: this.height,
        message: message ?? "已复制到剪贴板",
        savedPath: null as string | null,
      };
      emitEvent("scroll://done", done);
      this.sessionId = null;
      this.phase = "idle";
      this.height = 400;
      return done;
    },

    stop(action: "save" | "copy" | "cancel") {
      if (!this.sessionId) return null;
      if (action === "cancel") {
        this.stopTimer();
        this.phase = "idle";
        const done = {
          sessionId: "mock-scroll",
          ok: false,
          width: this.width,
          height: this.height,
          message: null as string | null,
          savedPath: null as string | null,
        };
        emitEvent("scroll://done", done);
        this.sessionId = null;
        this.height = 400;
        return done;
      }
      return this.finish(action === "copy" ? "已复制到剪贴板" : null);
    },
  };

  function emitEvent(event: string, payload: unknown) {
    for (const entry of [...(listeners.get(event) ?? [])]) {
      const handler = callbacks.get(entry.handler);
      if (handler !== undefined) handler({ event, id: entry.eventId, payload });
    }
  }

  /** Chunked replay of a canned answer, mimicking token-by-token streaming. */
  function streamCanned(requestId: string, action: string) {
    const text = canned[action] ?? canned.ask;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 3) chunks.push(text.slice(i, i + 3));
    let index = 0;
    const tick = () => {
      if (!mock.autoStream) return;
      if (index >= chunks.length) {
        emitEvent("ai://done", { requestId, ok: true, error: null });
        return;
      }
      emitEvent("ai://delta", { requestId, text: chunks[index] });
      index += 1;
      window.setTimeout(tick, 28);
    };
    window.setTimeout(tick, 220);
  }

  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) =>
      new Promise((resolve) => {
        switch (cmd) {
          case "current_session":
            resolve(session);
            break;
          case "frame_path":
            // A browser has no frozen desktop, so hand the overlay a synthetic
            // frame instead of null: the mosaic and highlight tools filter real
            // pixels, and with no image they would silently render nothing.
            resolve(mockFrameUrl());
            break;
          case "confirm_capture":
            resolve({
              cropId: "mock-crop",
              previewDataUrl: cropUrl,
              width: 1200,
              height: 760,
              message: null,
              savedPath: null,
            });
            break;
          case "get_settings":
            resolve(mock.settings);
            break;
          case "save_settings_cmd":
            Object.assign(mock.settings, args.settings ?? {});
            resolve(null);
            break;
          case "model_presets":
            resolve(presets);
            break;
          case "list_models":
            resolve(["deepseek-chat", "deepseek-flash", "deepseek-reasoner", "qwen-vl-max"]);
            break;
          case "test_connection": {
            const baseUrl = String(args.baseUrl ?? "");
            if (baseUrl.includes("bad")) {
              resolve({
                ok: false,
                detail: "无法连接到服务：connection refused (os error 61)",
                latencyMs: null,
                via: null,
                models: [],
              });
              break;
            }
            resolve({
              ok: true,
              detail: "连接正常",
              latencyMs: 312,
              via: "models",
              models: ["deepseek-chat", "deepseek-flash", "deepseek-reasoner"],
            });
            break;
          }
          case "api_key_status":
            resolve(true);
            break;
          case "set_api_key":
            resolve(null);
            break;
          case "clear_api_key":
            resolve(null);
            break;
          case "copy_text_to_clipboard":
            mock.lastCopied = String(args.text ?? "");
            resolve(null);
            break;
          case "save_crop":
            resolve("/Users/ryanuo/Pictures/Shutter/Shutter mock-crop.png");
            break;
          case "crop_data_url":
            resolve(cropUrl);
            break;
          case "capture_screens":
            resolve(session);
            break;
          case "open_settings_window":
            mock.openedSettings += 1;
            resolve(null);
            break;
          case "open_main_window":
          case "open_chat_window":
            resolve(null);
            break;
          case "debug_report":
          case "cancel_capture":
            resolve(null);
            break;
          /* ------------------------------------------------- scroll capture */
          case "scroll_status":
            resolve(scrollMock.state());
            break;
          case "scroll_start": {
            const status = scrollMock.start();
            resolve(status);
            break;
          }
          case "scroll_enter": {
            const status = scrollMock.enter();
            resolve(status);
            break;
          }
          case "scroll_leave":
            resolve(scrollMock.leave());
            break;
          case "scroll_pause":
            resolve(scrollMock.pause());
            break;
          case "scroll_resume":
            resolve(scrollMock.resume());
            break;
          case "scroll_stop": {
            const action = String(args.action ?? "cancel") as
              | "save"
              | "copy"
              | "cancel";
            resolve(scrollMock.stop(action));
            break;
          }
          case "ai_ask": {
            const requestId = String(args.requestId ?? "");
            const request = (args.request ?? {}) as { action?: string };
            mock.lastRequestId = requestId;
            mock.lastAction = request.action ?? null;
            // Rust returns immediately; the answer arrives as events.
            if (mock.autoStream) streamCanned(requestId, request.action ?? "ask");
            resolve(null);
            break;
          }
          case "plugin:event|listen": {
            const event = String(args.event ?? "");
            const handler = Number(args.handler ?? 0);
            const eventId = nextEventId++;
            listeners.set(event, [...(listeners.get(event) ?? []), { eventId, handler }]);
            resolve(eventId);
            break;
          }
          case "plugin:event|unlisten": {
            dropListener(String(args.event ?? ""), Number(args.eventId ?? 0));
            resolve(null);
            break;
          }
          default:
            console.info("[ipc-mock]", cmd, args ?? {});
            resolve(null);
        }
      }),
    transformCallback(callback: EventHandler, once = false) {
      const id = nextId++;
      callbacks.set(id, (payload) => {
        callback(payload);
        if (once) callbacks.delete(id);
      });
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    // The well-known mock preview path resolves to the growing data-URL the
    // scroll mock republishes; every other path passes through untouched.
    convertFileSrc: (path: string) => {
      if (path === "mock-scroll-preview") {
        const w = window as unknown as { __scrollPreviewUrl?: string };
        return w.__scrollPreviewUrl ?? path;
      }
      return path;
    },
    metadata: { currentWindow: { label: "overlay-1" }, currentWebview: { label: "overlay-1" } },
  };

  // The event plugin unlistens through this global before invoking the backend.
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown })
    .__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    registerListener() {},
    unregisterListener(event: string, eventId: number) {
      dropListener(event, eventId);
    },
  };

  // Test hook: replay an event the way Rust would (`ai://bind`, `ui://tab`, …).
  (window as unknown as { __emitTauriEvent: unknown }).__emitTauriEvent = emitEvent;
  (window as unknown as { __ipcMock: unknown }).__ipcMock = mock;
  (window as unknown as { __scrollMock: unknown }).__scrollMock = scrollMock;
}

installIpcMock();

installBootGuard();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{pickView()}</React.StrictMode>,
);
// Once React owns the window, a runtime error must not blank it any more.
markMounted();
