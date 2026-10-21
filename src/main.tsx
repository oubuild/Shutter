import React from "react";
import ReactDOM from "react-dom/client";
import { Overlay } from "./routes/Overlay";
import { Pin } from "./routes/Pin";
import { Chat } from "./routes/Chat";
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
 * Automation affordance: when the page is opened in a plain browser (no Tauri
 * runtime — e.g. driving the dev server from a test), install a canned IPC
 * mock so the overlay can be exercised end to end. Inside the real app
 * `__TAURI_INTERNALS__` always exists and this block is inert.
 */
function installIpcMock() {
  if ("__TAURI_INTERNALS__" in window) return;
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
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) =>
      new Promise((resolve) => {
        switch (cmd) {
          case "current_session":
            resolve(session);
            break;
          case "frame_path":
            // No frozen frame in the browser; the overlay still renders its
            // chrome, selection and tools, which is what automation needs.
            resolve(null);
            break;
          case "confirm_capture":
            resolve({
              cropId: "mock-crop",
              previewDataUrl: "",
              width: 100,
              height: 100,
              message: null,
              savedPath: null,
            });
            break;
          case "plugin:event|listen":
            resolve(`mock-${Math.random().toString(36).slice(2)}`);
            break;
          default:
            console.info("[ipc-mock]", cmd, args ?? {});
            resolve(null);
        }
      }),
    metadata: { currentWindow: { label: "overlay-1" }, currentWebview: { label: "overlay-1" } },
  };
}

installIpcMock();

installBootGuard();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{pickView()}</React.StrictMode>,
);
// Once React owns the window, a runtime error must not blank it any more.
markMounted();
