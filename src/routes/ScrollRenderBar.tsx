/**
 * Long-screenshot control bar (the `/scrollRenderBar` window — here
 * `index.html?view=scrollbar`, window label `recorder_bar_panel`).
 *
 * Stroke-by-stroke port of the reference `index-DwzZEF1Z.js` chunk (see
 * `.tmp/ref-scroll/scrollbar.pretty.js`): learns its monitor from
 * `start_screen_recording_event`, answers Rust's mount handshake
 * (`scroll_screenshot_bar_panel_loaded` — a watchdog tears the session down
 * without it), toggles 暂停/继续 via `cancel_scroll_screenshot_event`, and
 * finishes through `save_scroll_screenshot` + `hide_scroll_screenshot_panel`
 * + `close_panel`. While the stitched image is being produced it collapses
 * to a spinner plus close.
 */

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, events, type ScrollSaveAction } from "../lib/ipc";

const win = getCurrentWindow();

function Icon({ paths, size = 24 }: { paths: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* eslint-disable-next-line react/no-danger -- static path strings */}
      <g dangerouslySetInnerHTML={{ __html: paths }} />
    </svg>
  );
}

const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M4 18h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check:
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
};

/** `xw_YYYYMMDDHHmmss.png` (reference save name). */
function stampName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `xw_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

export function ScrollRenderBar() {
  const monitorId = useRef<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [processing, setProcessing] = useState(false);
  const closed = useRef(false);

  useEffect(() => {
    let offStart: (() => void) | null = null;
    let offPause: (() => void) | null = null;
    let alive = true;
    (async () => {
      try {
        // The mount handshake first (reference `await w.emit("scroll_screenshot_bar_panel_loaded")`;
        // a Rust watchdog closes the session if this never arrives). The owning
        // monitor rides the response — the `start_screen_recording_event`
        // broadcast races this webview's load and can be missed.
        const start = await api.scrollBarLoaded();
        if (!alive) return;
        if (start) {
          monitorId.current = start.monitor_id;
          setProcessing(false);
          setPaused(false);
        }
        // Register the remaining listeners only after the handshake: a
        // listener's client-side registry is installed by a fire-and-forget
        // eval that is reliably lost while the webview is still loading.
        offStart = await events.onStartScreenRecording(({ monitor_id }) => {
          monitorId.current = monitor_id;
          setProcessing(false);
          setPaused(false);
        });
        if (!alive) {
          offStart();
          offStart = null;
          return;
        }
        offPause = await events.onScrollPauseState((p) => setPaused(p));
      } catch (e) {
        offStart?.();
        offPause?.();
        if (!alive) return;
        console.error("初始化长截图控制条监听失败:", e);
        // Reference recovery: a bar that cannot listen stops the session.
        void api.hideScrollScreenshotPanel().catch(() => {});
      }
    })();
    return () => {
      alive = false;
      offStart?.();
      offPause?.();
    };
  }, []);

  /** Close the bar (reference `v`). */
  const close = () => {
    setProcessing(false);
    void api.hideScrollScreenshotPanel().catch(() => {});
    void api.closePanel(win.label).catch(() => {});
  };

  /** Finish: pause the scroller, then dispose of the stitched image. */
  const finish = async (
    actionType: ScrollSaveAction,
    filePath: string,
    autoSavePath: string,
  ) => {
    if (closed.current) return;
    closed.current = true;
    setProcessing(true);
    setPaused(true);
    try {
      await api.cancelScrollScreenshot(true);
      await api.saveScrollScreenshot({
        monitorId: monitorId.current,
        actionType,
        filePath,
        autoSavePath,
      });
    } catch (e) {
      console.error("保存长截图失败: ", e);
      closed.current = false;
      setProcessing(false);
      // Reference surfaces the failure via a toast window; the pill below is
      // the closest local equivalent.
      alert(typeof e === "string" ? e : "长截图保存失败");
      return;
    }
    close();
  };

  /** Optional extra write for copies (reference `copy_auto_save`). */
  const autoSavePath = async (): Promise<string> => {
    try {
      const s = await api.getSettings();
      if (!s.autoSave) return "";
      const dir = s.saveDir || (await api.saveDirectory());
      return dir ? `${dir}/${Date.now()}.png` : "";
    } catch {
      return "";
    }
  };

  /** 下载 — native save dialog; cancelling just closes (reference). */
  const onDownload = async () => {
    if (processing) return;
    const picked = await saveDialog({
      defaultPath: stampName(),
      filters: [{ name: "Image", extensions: ["png"] }],
    });
    if (!picked) {
      close();
      return;
    }
    const extra = await autoSavePath();
    await finish("saveAs", picked, extra);
  };

  /** 保存 — copy to clipboard (+ auto-save when enabled). */
  const onSaveCopy = async () => {
    if (processing) return;
    const extra = await autoSavePath();
    await finish("copy", "", extra);
  };

  /** 停止滚动/继续滚动 — reference `N`. */
  const onToggleScroll = async () => {
    if (processing) return;
    const next = !paused;
    setPaused(next);
    await api.cancelScrollScreenshot(next).catch(() => {});
  };

  return (
    <div
      className="scrollbar-card"
      onMouseDown={(e) => {
        // Draggable everywhere except the buttons (reference drag helper).
        if ((e.target as HTMLElement).closest(".scrollbar-btn")) return;
        void win.startDragging();
      }}
    >
      {processing ? (
        <div className="scrollbar-processing">
          <div className="scrollbar-processing-main">
            <span className="scrollbar-spinner" />
            <span>正在生成长截图…</span>
          </div>
          <div className="scrollbar-btn" title="关闭" onClick={close}>
            <Icon paths={ICONS.close} />
          </div>
        </div>
      ) : (
        <div className="scrollbar-row">
          <div className="scrollbar-btn scrollbar-toggle" onClick={() => void onToggleScroll()}>
            <Icon paths={paused ? ICONS.play : ICONS.pause} />
            <span>{paused ? "继续滚动" : "停止滚动"}</span>
          </div>
          <div className="scrollbar-btn" title="下载" onClick={() => void onDownload()}>
            <Icon paths={ICONS.download} />
          </div>
          <div className="scrollbar-btn" title="关闭" onClick={close}>
            <Icon paths={ICONS.close} />
          </div>
          <div className="scrollbar-btn" title="保存" onClick={() => void onSaveCopy()}>
            <Icon paths={ICONS.check} />
          </div>
        </div>
      )}
    </div>
  );
}
