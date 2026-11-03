/**
 * The floating settings menu anchored under the header's sliders button.
 *
 * One popover, four groups (设计稿 macOS 轻量 popover): capture actions with
 * their live accelerators, app configuration (the autostart switch reads and
 * writes the OS login item — nothing is faked), recommended links and the
 * about/feedback/quit tail. Secondary destinations open as separate fixed
 * windows (`api.openSettings` / `api.openAbout`), so this menu never grows a
 * nested pane.
 *
 * Closing is wired three ways: outside mousedown, Escape, and window blur
 * (opening a settings window or an external link blurs the main window and
 * must dismiss the menu). The exit is a 130ms fade; the entrance is the
 * `menu-pop` keyframe (uno.config.ts) — no bounce, no overshoot.
 */

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorText } from "../lib/ipc";
import { formatAccelerator } from "../lib/shortcut";
import { LINKS, openExternal } from "../lib/links";
import { IconChevronRight } from "./Icons";
import { Toggle } from "./Toggle";

type Props = {
  open: boolean;
  onClose: () => void;
  /** The header trigger. Clicks on it toggle the menu, so they are not "outside". */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
};

/** One menu row: label left, accessory (shortcut / tag / switch / chevron) right. */
function Row({
  label,
  accessory,
  disabled = false,
  onClick,
}: {
  label: string;
  accessory?: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={`flex h-9 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-[13px] color-ink transition-colors duration-100 ${
        disabled ? "pointer-events-none op-45" : "hover:bg-surface-alt"
      }`}
      onClick={onClick}
    >
      <span className="min-w-0 truncate">{label}</span>
      {accessory}
    </button>
  );
}

function ShortcutHint({ accel }: { accel: string | null }) {
  if (accel === null) return null;
  return <span className="flex-none text-mini color-muted">{formatAccelerator(accel)}</span>;
}

function Chevron() {
  return <IconChevronRight size={14} className="flex-none color-faint" />;
}

/** The light 推荐 pill; the neutral cousin marks not-yet-shipped rows. */
function Pill({ children, tone = "primary" }: { children: React.ReactNode; tone?: "primary" | "neutral" }) {
  return (
    <span
      className={`flex-none rounded-full border px-1.5 py-px text-micro leading-4 ${
        tone === "primary"
          ? "border-primary-500/45 color-primary-600 dark:color-neutral-300"
          : "border-line color-faint"
      }`}
    >
      {children}
    </span>
  );
}

export function SettingsMenu({ open, onClose, triggerRef }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** Stays mounted through the fade-out, then unmounts. */
  const [render, setRender] = useState(open);

  // Live values refreshed every time the menu opens.
  const [captureAccel, setCaptureAccel] = useState<string | null>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setRender(true);
      return;
    }
    const timer = window.setTimeout(() => setRender(false), 130);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAutostartError(null);
    api
      .getSettings()
      .then((s) => alive && setCaptureAccel(s.captureShortcut))
      .catch(() => undefined);
    api
      .autostartStatus()
      .then((v) => alive && setAutostart(v))
      .catch(() => alive && setAutostart(false));
    return () => {
      alive = false;
    };
  }, [open]);

  // Outside mousedown (the trigger itself toggles, so it is excluded).
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      if (target && triggerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, onClose, triggerRef]);

  // Escape closes; a click that left the window (settings window, browser
  // tab) closes it too — the menu must not survive a blur.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    let unlisten: (() => void) | null = null;
    let alive = true;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) onClose();
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
      unlisten?.();
    };
  }, [open, onClose]);

  /** Flip the login item, then trust whatever the OS reports back. */
  const toggleAutostart = () => {
    if (autostart === null || autostartBusy) return;
    const next = !autostart;
    setAutostartBusy(true);
    setAutostartError(null);
    api
      .setAutoStart(next)
      .then(() => api.autostartStatus())
      .then((v) => setAutostart(v))
      .catch((e) => {
        setAutostartError(errorText(e));
        api
          .autostartStatus()
          .then(setAutostart)
          .catch(() => undefined);
      })
      .finally(() => setAutostartBusy(false));
  };

  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };

  if (!render) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="设置"
      className={`absolute right-4 top-full z-dropdown mt-2 w-[256px] max-w-[calc(100vw-24px)] origin-top-right rounded-[24px] border border-line bg-surface pb-1 pt-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.14)] transition-opacity duration-[130ms] ${
        open ? "menu-pop" : "pointer-events-none opacity-0"
      }`}
    >
      <div className="max-h-[calc(100vh-96px)] overflow-y-auto px-1.5">
        {/* 截图功能 */}
        <Row
          label="截图"
          accessory={<ShortcutHint accel={captureAccel} />}
          onClick={act(() => void api.captureScreens().catch(() => undefined))}
        />
        <Row label="录屏" accessory={<Pill tone="neutral">敬请期待</Pill>} disabled />
        <Row
          label="长截图"
          accessory={<span className="flex-none text-mini color-muted">选区内 C</span>}
          onClick={act(() => void api.captureScreens().catch(() => undefined))}
        />
        <Row label="带壳截图" accessory={<Pill tone="neutral">敬请期待</Pill>} disabled />

        <div className="mx-1.5 my-1 border-t border-line" />

        {/* 应用配置 */}
        <Row
          label="快捷键设置"
          accessory={<Chevron />}
          onClick={act(() => void api.openSettings("shortcut").catch(() => undefined))}
        />
        <div
          role="menuitem"
          aria-label="开机自启动"
          className={`flex h-9 w-full items-center justify-between gap-3 rounded-lg px-3 text-[13px] color-ink transition-colors duration-100 ${
            autostartBusy ? "pointer-events-none" : "hover:bg-surface-alt"
          }`}
          onClick={toggleAutostart}
        >
          <span className="min-w-0 truncate">开机自启动</span>
          <Toggle
            label="开机自启动"
            checked={autostart ?? false}
            disabled={autostart === null || autostartBusy}
            onChange={toggleAutostart}
          />
        </div>
        {autostartError && (
          <div className="px-3 pb-1.5 text-micro leading-5 text-error-600">{autostartError}</div>
        )}
        <Row
          label="保存设置"
          accessory={<Chevron />}
          onClick={act(() => void api.openSettings("save").catch(() => undefined))}
        />
        <Row
          label="更多设置"
          accessory={<Chevron />}
          onClick={act(() => void api.openSettings("more").catch(() => undefined))}
        />

        <div className="mx-1.5 my-1 border-t border-line" />

        {/* 推荐服务 */}
        <Row
          label="Shutter 官网"
          accessory={<Pill>推荐</Pill>}
          onClick={act(() => openExternal(LINKS.website))}
        />
        <Row
          label="GitHub"
          accessory={<Pill>推荐</Pill>}
          onClick={act(() => openExternal(LINKS.github))}
        />

        <div className="mx-1.5 my-1 border-t border-line" />

        {/* 其他 */}
        <Row
          label="关于 Shutter"
          accessory={<Chevron />}
          onClick={act(() => void api.openAbout().catch(() => undefined))}
        />
        <Row
          label="问题反馈"
          accessory={<Chevron />}
          onClick={act(() => openExternal(LINKS.feedback))}
        />
        <Row label="退出" onClick={act(() => void api.exitApp().catch(() => undefined))} />
      </div>
    </div>
  );
}
