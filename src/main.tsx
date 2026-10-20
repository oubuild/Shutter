import React from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactDOM from "react-dom/client";
import { Overlay } from "./routes/Overlay";
import { Pin } from "./routes/Pin";
import { SettingsView } from "./routes/Settings";
import { Chat } from "./routes/Chat";
import "./styles/app.css";

/**
 * One bundle, five window shapes. The Rust side opens every window with
 * `index.html?view=<name>`, so routing stays a plain query parameter and we
 * avoid pulling in a router for four static screens.
 */
function report(stage: string, detail: unknown) {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  invoke("debug_report", { stage, detail: text }).catch(() => undefined);
}

function pickView(): React.ReactElement {
  const params = new URLSearchParams(window.location.search);
  switch (params.get("view")) {
    case "pin":
      return <Pin pinId={params.get("id") ?? ""} />;
    case "settings":
      return <SettingsView />;
    case "chat":
      return <Chat />;
    case "overlay":
    default:
      return (
        <Overlay
          monitorId={Number(params.get("monitor") ?? 0)}
        />
      );
  }
}

// Surface boot failures visibly instead of leaving a blank transparent window.
window.addEventListener("error", (e) => {
  (window as unknown as { __bootError?: string }).__bootError = String(e.message);
  const el = document.getElementById("root");
  if (el) el.innerHTML = `<pre style="color:#fff;background:#b91c1c;padding:12px;margin:0;font-size:12px;white-space:pre-wrap">boot error: ${e.message}</pre>`;
});

report("boot", { href: location.href, ready: document.readyState });

try {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{pickView()}</React.StrictMode>,
  );
  report("rendered", "react tree mounted");
} catch (e) {
  report("render-failed", String(e));
  throw e;
}
