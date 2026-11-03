/**
 * Main window: the gallery plus a slim header carrying the settings entry.
 *
 * The settings used to live here as nav tabs; they are now a popover menu
 * under the header's gear button (see SettingsMenu) whose secondary pages
 * open as separate fixed windows (`windows::open_settings_page`), so this
 * shell renders exactly one pane — the gallery — and keeps it mounted for the
 * window's whole life. The window itself is a fixed 400×740 companion strip
 * (`windows::open_main`), so there is no zoom-on-double-click to wire.
 *
 * Window chrome stays the OS's: macOS draws its traffic lights over the view
 * (the header leaves a 92px gutter and carries the drag region),
 * Windows/Linux have their native title bar and get the same slim header only
 * so the settings button exists there too.
 */

import { useRef, useState } from "react";
import { IS_MAC } from "../lib/shortcut";
import { IconSettings } from "../components/Icons";
import { SettingsMenu } from "../components/SettingsMenu";
import { Gallery } from "./Gallery";

export function Main() {
  const [menuOpen, setMenuOpen] = useState(false);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);

  const headerProps = IS_MAC
    ? { "data-tauri-drag-region": true }
    : {};

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden bg-secondary font-sans text-compact color-base"
      data-platform={IS_MAC ? "macos" : "other"}
    >
      <header
        className={`relative flex h-13 flex-none select-none items-center gap-3 border-b border-base bg-base/85 pr-4 ${
          IS_MAC ? "pl-[92px]" : "pl-4"
        }`}
        {...headerProps}
      >
        <div
          className="ml-3.5 min-w-0 truncate text-compact font-600 tracking-wide color-muted"
          data-tauri-drag-region={IS_MAC ? true : undefined}
        >
          Shutter
        </div>

        <div className="flex flex-1 justify-end" data-tauri-drag-region={IS_MAC ? true : undefined}>
          <button
            ref={settingsBtnRef}
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg color-muted transition-colors duration-100 outline-none hover:bg-hover hover:color-base focus-visible:ring-2 focus-visible:ring-primary-500/40"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="设置"
            title="设置"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <IconSettings size={16} />
          </button>
        </div>

        <SettingsMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          triggerRef={settingsBtnRef}
        />
      </header>

      <main className="flex min-h-0 min-w-0 flex-1">
        <Gallery />
      </main>
    </div>
  );
}
