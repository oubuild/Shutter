/**
 * Main window shell: a rounded card with a draggable header, a left nav, and
 * one section per destination.
 *
 * The window is created borderless and transparent (see `windows::open_main`),
 * so the card, its radius and the header drag region all live here. macOS keeps
 * its native traffic lights, inset via `traffic_light_position`; the header
 * leaves room for them on the left.
 */

import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { events } from "../lib/ipc";
import { Gallery } from "./Gallery";
import { SettingsView } from "./Settings";
import { About } from "./About";

export type Tab = "gallery" | "settings" | "about";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "gallery", label: "图库" },
  { id: "settings", label: "设置" },
  { id: "about", label: "关于" },
];

function isTab(value: string | null): value is Tab {
  return value === "gallery" || value === "settings" || value === "about";
}

export function Main({ initialTab }: { initialTab: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);

  // The tray reopens the existing window and steers it through this event, so
  // the window is never recreated (which would reset gallery scroll position).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    events
      .onUiTab((next) => {
        if (isTab(next)) setTab(next);
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const close = useCallback(() => {
    // Hide rather than close: the app is a menu-bar agent, and a hidden window
    // reopens instantly from the tray without a reload.
    void getCurrentWindow()
      .hide()
      .catch(() => undefined);
  }, []);

  return (
    <div className="main-root">
      <div className="main-card">
        <header className="main-header" data-tauri-drag-region>
          <div className="main-header-title" data-tauri-drag-region>
            Shutter
          </div>
        </header>

        <div className="main-body">
          <nav className="main-nav">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${tab === item.id ? "active" : ""}`}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
            <div className="nav-spacer" />
            <button type="button" className="nav-item subtle" onClick={close}>
              隐藏窗口
            </button>
          </nav>

          <main className="main-content">
            {tab === "gallery" && <Gallery />}
            {tab === "settings" && <SettingsView />}
            {tab === "about" && <About />}
          </main>
        </div>
      </div>
    </div>
  );
}
