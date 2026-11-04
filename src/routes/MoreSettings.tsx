/**
 * The 更多设置 fixed window: the full settings surface under one segmented
 * tab bar (AI 服务 / 截图与保存 / 快捷键 / 更新与关于), replacing the old
 * left-nav layout.
 *
 * The first three tabs are one SettingsView instance whose `section` prop
 * swaps — never a remount — because separate instances would hold stale
 * snapshots of the same Settings object and a save from one could overwrite
 * edits in another (the rule Settings.tsx is built around). The 更新与关于
 * tab composes UpdatePanel + AboutMeta (both keep-alive too, so returning to
 * a settings tab restores the unsaved form exactly).
 *
 * Rust steers an already-open window through `settings://tab` (tray 设置…,
 * the AI window's 去设置) instead of recreating it.
 */

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { events, type MoreSettingsTab } from "../lib/ipc";
import { SettingsView, type SettingsSection } from "./Settings";
import { UpdatePanel } from "../components/UpdatePanel";
import { AboutMeta } from "../components/AboutMeta";

const TABS: Array<{ id: MoreSettingsTab; label: string }> = [
  { id: "ai", label: "AI 服务" },
  { id: "general", label: "截图与保存" },
  { id: "shortcuts", label: "快捷键" },
  { id: "update", label: "更新与关于" },
];

function isMoreSettingsTab(value: string): value is MoreSettingsTab {
  return value === "ai" || value === "general" || value === "shortcuts" || value === "update";
}

/** The 更新与关于 tab head: compact horizontal brand row. */
function BrandRow() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);
  return (
    <div className="flex items-center gap-4">
      <img
        src="icon-256.png"
        alt="Shutter"
        width={56}
        height={56}
        className="h-14 w-14 flex-none rounded-2xl shadow-md"
        draggable={false}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-base font-600 tracking-tight color-base">Shutter</span>
          <span className="flex-none rounded bg-sunken px-2 py-0.5 font-mono text-micro color-muted">
            v{version ?? "…"}
          </span>
        </div>
        <p className="m-0 mt-1 text-mini leading-5 color-faint">
          原生极简菜单栏截图标注工具；就地完成框选标注，或通过视觉模型一键理解文字与图像。
        </p>
      </div>
    </div>
  );
}

export function MoreSettings({ initialTab = "ai" }: { initialTab?: MoreSettingsTab }) {
  const [tab, setTab] = useState<MoreSettingsTab>(initialTab);
  /** The section the (possibly hidden) SettingsView last rendered. */
  const [section, setSection] = useState<SettingsSection>(
    initialTab === "update" ? "ai" : initialTab,
  );
  const [updateMounted, setUpdateMounted] = useState(initialTab === "update");

  const switchTab = (next: MoreSettingsTab) => {
    setTab(next);
    if (next === "update") {
      setUpdateMounted(true);
    } else {
      setSection(next);
    }
  };

  // A reused window is steered to a tab rather than rebuilt.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    events
      .onSettingsTab((next) => {
        if (isMoreSettingsTab(next)) switchTab(next);
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

  const showSettings = tab !== "update";

  return (
    <div className="flex h-full w-full flex-col bg-secondary font-sans text-compact color-base">
      <div
        className="flex flex-none items-center justify-center border-b border-base bg-base px-4 py-2.5"
        role="tablist"
        aria-label="更多设置"
      >
        {/* Monochrome segmented control: sunken track, solid primary segment. */}
        <div className="inline-flex items-center gap-0.5 rounded-lg bg-sunken p-[3px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)]">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`h-6 rounded-md px-4 text-mini transition-all duration-150 ${
                tab === item.id
                  ? "bg-primary-500 font-500 text-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] dark:bg-neutral-200 dark:text-neutral-900"
                  : "color-muted hover:color-base"
              }`}
              onClick={() => switchTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* One shared SettingsView across all settings tabs (hidden, not
          unmounted, while 更新与关于 is up). */}
      <div className={showSettings ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
        <SettingsView section={section} active={showSettings} headerless />
      </div>

      {updateMounted && (
        <div className={showSettings ? "hidden" : "flex min-h-0 min-w-0 flex-1 flex-col"}>
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-7 py-5">
            <BrandRow />
            <div className="pref-divider ml-0" />
            <UpdatePanel />
            <div className="pref-divider ml-0" />
            <AboutMeta />
          </div>
        </div>
      )}
    </div>
  );
}
