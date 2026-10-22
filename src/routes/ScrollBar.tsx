/** Long-screenshot control bar (reference `recorder_bar_panel`).
 *
 * A compact always-on-top strip Rust parks near the bottom of the primary
 * monitor for the duration of a scroll-capture session: pause/resume the
 * auto-scroller, finish with save/copy, or cancel. The window itself is
 * transparent and borderless; only this bar paints.
 */

import { useEffect, useState } from "react";
import { api, events, errorText, type ScrollStatus } from "../lib/ipc";

const IDLE: ScrollStatus = {
  sessionId: null,
  phase: "idle",
  height: 0,
  width: 0,
  autoScroll: false,
  note: null,
};

/** One button in the bar: inline SVG (Toolbar's icon style) + label. */
function BarButton({
  label,
  svg,
  title,
  disabled,
  onClick,
}: {
  label: string;
  svg: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="scrollbar-btn"
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="scrollbar-btn-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
      <span className="scrollbar-btn-label">{label}</span>
    </button>
  );
}

const S = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  pause: S('<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
  resume: S('<path d="M8 5.5v13l11-6.5z"/>'),
  save: S('<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M4 18h16"/>'),
  copy: S(
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  ),
  cancel: S('<path d="M6 6l12 12M18 6 6 18"/>'),
};

export function ScrollBar() {
  const [status, setStatus] = useState<ScrollStatus>(IDLE);
  const [error, setError] = useState<string | null>(null);

  // Sync on mount — Rust opens this window per session, but the webview may
  // boot after the first `scroll://state` event.
  useEffect(() => {
    let cancelled = false;
    api
      .scrollStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((e: unknown) => setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unlisteners = [
      events.onScrollState((s) => {
        setStatus(s);
        setError(null);
      }),
      events.onScrollDone(() => {
        // Rust closes this window on done; local reset is just a fallback.
        setStatus(IDLE);
      }),
    ];
    return () => {
      for (const p of unlisteners) p.then((u) => u()).catch(() => undefined);
    };
  }, []);

  const running = status.phase === "recording" || status.phase === "paused";

  const act = (fn: () => Promise<unknown>) => () => {
    fn().catch((e: unknown) => setError(errorText(e)));
  };

  const toggle = act(async () => {
    const next =
      status.phase === "paused" ? await api.scrollResume() : await api.scrollPause();
    setStatus(next);
  });

  return (
    <div className="scrollbar-root" data-tauri-drag-region>
      <div className="scrollbar-group" data-tauri-drag-region>
        <button
          className="scrollbar-btn"
          type="button"
          title={status.phase === "paused" ? "继续" : "暂停"}
          aria-label={status.phase === "paused" ? "继续" : "暂停"}
          disabled={!running}
          onClick={toggle}
        >
          <span
            className="scrollbar-btn-icon"
            aria-hidden="true"
            dangerouslySetInnerHTML={{
              __html: status.phase === "paused" ? ICONS.resume : ICONS.pause,
            }}
          />
          <span className="scrollbar-btn-label">{status.phase === "paused" ? "继续" : "暂停"}</span>
        </button>
      </div>

      <span className="scrollbar-sep" />

      <div className="scrollbar-group">
        <BarButton
          label="保存"
          title="保存长截图"
          svg={ICONS.save}
          disabled={!running}
          onClick={act(() => api.scrollStop("save").then(() => undefined))}
        />
        <BarButton
          label="复制"
          title="复制长截图到剪贴板"
          svg={ICONS.copy}
          disabled={!running}
          onClick={act(() => api.scrollStop("copy").then(() => undefined))}
        />
      </div>

      <span className="scrollbar-sep" />

      <BarButton
        label="取消"
        title="取消本次长截图"
        svg={ICONS.cancel}
        onClick={act(() => api.scrollStop("cancel").then(() => undefined))}
      />

      {/* Live size readout, reference `${w}*${h}` badge. */}
      <span className="scrollbar-badge" title="当前拼接尺寸">
        {status.width > 0 ? `${status.width} × ${status.height}` : "—"}
      </span>

      {error && <span className="scrollbar-error" title={error}>{error}</span>}
    </div>
  );
}
