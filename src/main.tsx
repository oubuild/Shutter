import React from "react";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{pickView()}</React.StrictMode>,
);
