import React from "react";
import ReactDOM from "react-dom/client";
import { Overlay } from "./routes/Overlay";
import { Pin } from "./routes/Pin";
import { Chat } from "./routes/Chat";
import { Main, type Tab } from "./routes/Main";
import "./styles/app.css";

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

// Surface boot failures visibly instead of leaving a blank transparent window.
window.addEventListener("error", (e) => {
  (window as unknown as { __bootError?: string }).__bootError = String(e.message);
  const el = document.getElementById("root");
  if (el) {
    el.innerHTML = `<pre style="color:#fff;background:#b91c1c;padding:12px;margin:0;font-size:12px;white-space:pre-wrap">boot error: ${e.message}</pre>`;
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{pickView()}</React.StrictMode>,
);
