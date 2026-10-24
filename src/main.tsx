// The IPC mock must be the first import: ESM evaluates imports in source
// order, and route modules read the Tauri API at module scope (e.g.
// ScrollScreen's `getCurrentWindow()`), so the mock has to be installed before
// any of them evaluate. Inside the real Tauri app this module is inert.
import "./lib/ipc-mock";

import React from "react";
import ReactDOM from "react-dom/client";
import { Overlay } from "./routes/Overlay";
import { Pin } from "./routes/Pin";
import { Chat } from "./routes/Chat";
import { ScrollScreen } from "./routes/ScrollScreen";
import { ScrollRenderBar } from "./routes/ScrollRenderBar";
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
  // "settings" is the pre-split name; old window URLs still land on the AI pane.
  if (value === "settings") return "ai";
  return value === "gallery" ||
    value === "about" ||
    value === "ai" ||
    value === "general" ||
    value === "shortcuts"
    ? value
    : "gallery";
}

function pickView(): React.ReactElement {
  const params = new URLSearchParams(window.location.search);
  switch (params.get("view")) {
    case "pin":
      return <Pin pinId={params.get("id") ?? ""} />;
    case "chat":
      return <Chat />;
    case "scrollscreen":
      // The long-screenshot fullscreen panel (`scroll_screenshot_panel_<id>`).
      return <ScrollScreen />;
    case "scrollbar":
      // The long-screenshot control bar (`recorder_bar_panel`).
      return <ScrollRenderBar />;
    case "main":
      return <Main initialTab={pickTab(params.get("tab"))} />;
    // The settings window was folded into `main`; keep the route so an old
    // window URL (or a bookmarked dev URL) still renders something sensible.
    case "settings":
      return <Main initialTab="ai" />;
    case "overlay":
    default:
      return <Overlay monitorId={Number(params.get("monitor") ?? 0)} />;
  }
}

installBootGuard();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{pickView()}</React.StrictMode>,
);
// Once React owns the window, a runtime error must not blank it any more.
markMounted();
