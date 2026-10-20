/**
 * Main window shell: a rounded card with a left nav and one section per
 * destination.
 *
 * Window chrome is the OS's: `windows::open_main` keeps native decorations on
 * every platform, so macOS draws its traffic lights and Windows/Linux draw
 * their caption buttons. macOS additionally uses the overlay title-bar style,
 * which transparently extends the webview under the title bar — that is why
 * the header below leaves a 92px gutter for the traffic lights and carries the
 * drag region.
 *
 * On Windows/Linux the native title bar already provides the app title and the
 * drag behaviour, so the custom header is not rendered there.
 *
 * All three panes stay mounted and are hidden with `hidden`; switching tabs is
 * therefore a paint, not a remount. That keeps the gallery thumbnails, the
 * settings form state and every scroll position, and it removes the flash of
 * "加载中…" a remount used to show on every switch.
 */

import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { events } from "../lib/ipc";
import { IS_MAC } from "../lib/shortcut";
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
  /**
   * Panes are mounted on first visit and then kept alive, so switching is a
   * paint and form/scroll state survives. Mounting all three at launch instead
   * would make the gallery load thumbnails in the background while the user is
   * still on another tab, which is what made startup feel heavy.
   */
  const [mounted, setMounted] = useState<Record<Tab, boolean>>({
    gallery: initialTab === "gallery",
    settings: initialTab === "settings",
    about: initialTab === "about",
  });

  useEffect(() => {
    setMounted((prev) => (prev[tab] ? prev : { ...prev, [tab]: true }));
  }, [tab]);

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

  // Double-click-to-zoom is the macOS convention; the hidden title bar means
  // the system cannot do it for us.
  const onHeaderDoubleClick = useCallback(() => {
    void getCurrentWindow()
      .toggleMaximize()
      .catch(() => undefined);
  }, []);

  return (
    <div className="flex h-full w-full bg-secondary font-sans text-compact color-base" data-platform={IS_MAC ? "macos" : "other"}>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-secondary">
        {IS_MAC && (
          <header
            className="flex h-13 flex-none select-none items-center gap-3 border-b border-base bg-base/85 pl-[92px] pr-4"
            data-tauri-drag-region
            onDoubleClick={onHeaderDoubleClick}
          >
            <div className="ml-3.5 min-w-0 truncate text-compact font-600 tracking-wide color-muted" data-tauri-drag-region>
              Shutter
            </div>
          </header>
        )}

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[152px] flex-none flex-col gap-0.5 border-r border-base bg-secondary p-3">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`w-full rounded-md px-2.5 py-2 text-left text-compact transition-none ${
                  tab === item.id
                    ? "bg-primary-500/10 font-600 color-primary-600"
                    : "border border-transparent color-muted hover:bg-hover hover:color-base"
                }`}
                aria-current={tab === item.id ? "page" : undefined}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <main className="flex min-h-0 min-w-0 flex-1">
            {mounted.gallery && (
              <div className={tab === "gallery" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
                <Gallery active={tab === "gallery"} />
              </div>
            )}
            {mounted.settings && (
              <div className={tab === "settings" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
                <SettingsView active={tab === "settings"} />
              </div>
            )}
            {mounted.about && (
              <div className={tab === "about" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
                <About />
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
