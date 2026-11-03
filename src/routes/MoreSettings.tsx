/**
 * The 更多设置 fixed window: the full settings surface under one top tab bar
 * (AI 服务 / 截图与保存 / 快捷键 / 更新), replacing the old left-nav layout.
 *
 * The first three tabs are one SettingsView instance whose `section` prop
 * swaps — never a remount — because separate instances would hold stale
 * snapshots of the same Settings object and a save from one could overwrite
 * edits in another (the rule Settings.tsx is built around). The 更新 tab is
 * the UpdatePanel (it persists immediately, outside the form), kept alive the
 * same way so returning to a settings tab restores the unsaved form exactly.
 *
 * Rust steers an already-open window through `settings://tab` (tray 设置…,
 * the AI window's 去设置) instead of recreating it.
 */

import { useEffect, useState } from "react";
import { events, type MoreSettingsTab } from "../lib/ipc";
import { SettingsView, type SettingsSection } from "./Settings";
import { UpdatePanel } from "../components/UpdatePanel";

const TABS: Array<{ id: MoreSettingsTab; label: string }> = [
  { id: "ai", label: "AI 服务" },
  { id: "general", label: "截图与保存" },
  { id: "shortcuts", label: "快捷键" },
  { id: "update", label: "更新" },
];

function isMoreSettingsTab(value: string): value is MoreSettingsTab {
  return value === "ai" || value === "general" || value === "shortcuts" || value === "update";
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
        className="flex flex-none items-center gap-1 border-b border-base bg-base px-4 py-2.5"
        role="tablist"
        aria-label="更多设置"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`rounded-md px-3 py-1.5 text-compact transition-none ${
              tab === item.id
                ? "bg-primary-500/10 font-600 color-primary-600 dark:color-neutral-200"
                : "border border-transparent color-muted hover:bg-hover hover:color-base"
            }`}
            onClick={() => switchTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* One shared SettingsView across all settings tabs (hidden, not
          unmounted, while the 更新 tab is up). */}
      <div className={showSettings ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
        <SettingsView section={section} active={showSettings} headerless />
      </div>

      {updateMounted && (
        <div className={showSettings ? "hidden" : "flex min-h-0 min-w-0 flex-1 flex-col"}>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <UpdatePanel divided={false} />
          </div>
        </div>
      )}
    </div>
  );
}
