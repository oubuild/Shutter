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
import { Main } from "./routes/Main";
import { SettingsView } from "./routes/Settings";
import { MoreSettings } from "./routes/MoreSettings";
import { About } from "./routes/About";
import type { MoreSettingsTab, SettingsWindowPage } from "./lib/ipc";
import { IS_MAC } from "./lib/shortcut";
import { installBootGuard, markMounted } from "./lib/boot-guard";
import "./styles/capture.css";
// UnoCSS output: the antfu design layer + utilities used by the settings pane.
// Loaded after app.css so utility classes win over the legacy element rules.
import "virtual:uno.css";

/**
 * One bundle, every window shape. The Rust side opens each window with
 * `index.html?view=<name>`, so routing stays a plain query parameter and we
 * avoid pulling in a router for static screens. The settings secondary
 * windows add `page` (`shortcut` / `save` / `more`) and, for `more`, a `tab`.
 */

/** Roots like SettingsView/About are flex children (`flex-1`) with their own
 *  scroll area; without this flex column they would grow past the window and
 *  clip (no scrollbar) — exactly what happened to the about page's tail. */
function windowShell(node: React.ReactElement): React.ReactElement {
  return (
    <div
      className="flex h-full w-full flex-col bg-secondary font-sans text-compact color-base"
      data-platform={IS_MAC ? "macos" : "other"}
    >
      {node}
    </div>
  );
}

function pickSettingsPage(value: string | null): SettingsWindowPage {
  return value === "shortcut" || value === "save" || value === "more" ? value : "more";
}

function pickMoreTab(value: string | null): MoreSettingsTab {
  return value === "general" || value === "shortcuts" || value === "update" ? value : "ai";
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
      return <Main />;
    case "settings": {
      const page = pickSettingsPage(params.get("page"));
      if (page === "shortcut") return windowShell(<SettingsView section="shortcuts" />);
      if (page === "save") return windowShell(<SettingsView section="general" />);
      return <MoreSettings initialTab={pickMoreTab(params.get("tab"))} />;
    }
    case "about":
      return windowShell(<About />);
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
