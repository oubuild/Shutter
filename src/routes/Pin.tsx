import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { api, errorText } from "../lib/ipc";

/**
 * Floating always-on-top pin window — stroke-by-stroke port of the reference
 * `assets_index-CM6hgQ3v.js` (`pin_panel_*`): a padded rounded image card that
 * lands 1:1 at the selection, zooms with the wheel (step 0.1, smallest side
 * 150px, largest 8× the initial size, live % badge) and resizes through
 * aspect-locked invisible edge zones that anchor the opposite side. Drag to
 * move, hover for the action circles, Escape closes only while focused.
 */

const MIN_SIDE = 150;
const ZOOM_STEP = 0.1;
const ZOOM_MAX = 8;
const HINT_MS = 2200;
const BADGE_MS = 1000;

type Size = { w: number; h: number };
type Pos = { x: number; y: number };
type ZoneDir =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

function clampSize(w: number, h: number, init: Size): Size {
  const ratio = init.w / init.h;
  if (w < MIN_SIDE) {
    w = MIN_SIDE;
    h = Math.round(w / ratio);
  }
  if (h < MIN_SIDE) {
    h = MIN_SIDE;
    w = Math.round(h * ratio);
  }
  if (w > init.w * ZOOM_MAX) {
    w = Math.floor(init.w * ZOOM_MAX);
    h = Math.round(w / ratio);
  }
  if (h > init.h * ZOOM_MAX) {
    h = Math.floor(init.h * ZOOM_MAX);
    w = Math.round(h * ratio);
  }
  return { w, h };
}

/** Floating always-on-top pin window: show a captured crop, drag, zoom, copy, save. */
export function Pin({ pinId }: { pinId: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [badge, setBadge] = useState<string | null>(null);

  /** Window inner size in logical px; the wheel zoom scales from this. */
  const initRef = useRef<Size>({ w: 0, h: 0 });
  const curRef = useRef<Size>({ w: 0, h: 0 });
  const zoomRef = useRef(1);

  const hintTimer = useRef<number | null>(null);
  const badgeTimer = useRef<number | null>(null);
  /** Active edge drag; null while not resizing. */
  const resizeRef = useRef<{
    dir: ZoneDir;
    startClient: Pos;
    startSize: Size;
    startPos: Pos;
  } | null>(null);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), HINT_MS);
  }, []);

  const flashBadge = useCallback((zoom: number) => {
    setBadge(`${Math.round(zoom * 100)}%`);
    if (badgeTimer.current !== null) window.clearTimeout(badgeTimer.current);
    badgeTimer.current = window.setTimeout(() => setBadge(null), BADGE_MS);
  }, []);

  const close = useCallback(async () => {
    try {
      await api.closePin(pinId);
    } catch (e: unknown) {
      showHint(`关闭失败：${errorText(e)}`);
    }
  }, [pinId, showHint]);

  // Escape closes only while the pin is focused (reference: tauri://focus +
  // tauri://blur gate) — an Escape aimed at another app must not eat pins.
  useEffect(() => {
    const win = getCurrentWindow();
    let focused = false;
    const un = [
      win.listen("tauri://focus", () => {
        focused = true;
      }),
      win.listen("tauri://blur", () => {
        focused = false;
      }),
    ];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !focused) return;
      event.preventDefault();
      void close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      for (const p of un) void p.then((f) => f());
    };
  }, [close]);

  useEffect(() => {
    if (pinId === "") {
      setError("缺少截图 ID");
      return;
    }
    let cancelled = false;
    api
      .cropDataUrl(pinId)
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [pinId]);

  // Baseline sizes: the window opens as image + 2×PAD (Rust frames it), and
  // every zoom/resize keeps that aspect ratio.
  useEffect(() => {
    const w = Math.floor(window.innerWidth);
    const h = Math.floor(window.innerHeight);
    if (w <= 0 || h <= 0) return;
    initRef.current = { w, h };
    curRef.current = { w, h };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUrl]);

  const copy = useCallback(async () => {
    try {
      if (dataUrl === null) return;
      const Ctor = typeof ClipboardItem === "undefined" ? null : ClipboardItem;
      const clipboard = navigator.clipboard;
      if (Ctor === null || clipboard === undefined || typeof clipboard.write !== "function") {
        showHint("当前环境不支持写入图片剪贴板");
        return;
      }
      const blob = await (await fetch(dataUrl)).blob();
      await clipboard.write([new Ctor({ "image/png": blob })]);
      showHint("已复制到剪贴板");
    } catch (e: unknown) {
      showHint(`复制失败：${errorText(e)}`);
    }
  }, [dataUrl, showHint]);

  const save = useCallback(async () => {
    try {
      const path = await api.saveCrop(pinId);
      showHint(path === "" ? "已保存" : path);
    } catch (e: unknown) {
      showHint(`保存失败：${errorText(e)}`);
    }
  }, [pinId, showHint]);

  // React binds wheel listeners passively, so handle it natively to preventDefault.
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const init = initRef.current;
      const cur = curRef.current;
      if (init.w <= 0 || cur.w <= 0) return;
      const dir = event.deltaY < 0 ? 1 : -1;
      const next = Math.min(
        ZOOM_MAX,
        Math.max(MIN_SIDE / init.w, zoomRef.current + dir * ZOOM_STEP),
      );
      if (next === zoomRef.current) return;
      const ratio = next / zoomRef.current;
      const size = clampSize(
        Math.floor(cur.w * ratio),
        Math.floor(cur.h * ratio),
        init,
      );
      zoomRef.current = next;
      curRef.current = size;
      flashBadge(next);
      getCurrentWindow()
        .setSize(new LogicalSize(size.w, size.h))
        .catch((e: unknown) => showHint(`缩放失败：${errorText(e)}`));
    };
    // Reference binds on `document`, so the whole surface zooms.
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => document.removeEventListener("wheel", onWheel);
  }, [flashBadge, showHint]);

  /* ------------------------------------------- aspect-locked edge resize */

  const onZoneDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, dir: ZoneDir) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const win = getCurrentWindow();
      void (async () => {
        const [scale, inner, outer] = await Promise.all([
          win.scaleFactor(),
          win.innerSize(),
          win.outerPosition(),
        ]);
        resizeRef.current = {
          dir,
          startClient: { x: event.clientX, y: event.clientY },
          startSize: {
            w: Math.round(inner.width / scale),
            h: Math.round(inner.height / scale),
          },
          startPos: {
            x: outer.x / scale,
            y: outer.y / scale,
          },
        };
      })().catch(() => undefined);
    },
    [],
  );

  // One pair of document listeners drives whichever zone is held, mirroring
  // the reference (mousemove/mouseup mounted once, state kept in refs).
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const r = resizeRef.current;
      const init = initRef.current;
      if (!r || init.w <= 0) return;
      const ratio = init.w / init.h;
      const dx = event.clientX - r.startClient.x;
      const dy = event.clientY - r.startClient.y;
      let { w, h } = r.startSize;
      let x = r.startPos.x;
      let y = r.startPos.y;
      let anchored = false;
      switch (r.dir) {
        case "right":
          w = r.startSize.w + dx;
          h = Math.round(w / ratio);
          break;
        case "bottom":
          h = r.startSize.h + dy;
          w = Math.round(h * ratio);
          break;
        case "bottom-right":
          if (Math.abs(dx) >= Math.abs(dy)) {
            w = r.startSize.w + dx;
            h = Math.round(w / ratio);
          } else {
            h = r.startSize.h + dy;
            w = Math.round(h * ratio);
          }
          break;
        case "bottom-left":
          w = r.startSize.w - dx;
          h = Math.round(w / ratio);
          x = r.startPos.x + r.startSize.w - w;
          anchored = true;
          break;
        case "top-right":
          h = r.startSize.h - dy;
          w = Math.round(h * ratio);
          y = r.startPos.y + r.startSize.h - h;
          anchored = true;
          break;
        case "top-left":
          w = r.startSize.w - dx;
          h = Math.round(w / ratio);
          x = r.startPos.x + r.startSize.w - w;
          y = r.startPos.y + r.startSize.h - h;
          anchored = true;
          break;
        case "left":
          w = r.startSize.w - dx;
          h = Math.round(w / ratio);
          x = r.startPos.x + r.startSize.w - w;
          anchored = true;
          break;
        case "top":
          h = r.startSize.h - dy;
          w = Math.round(h * ratio);
          y = r.startPos.y + r.startSize.h - h;
          anchored = true;
          break;
      }
      const clamped = clampSize(w, h, init);
      if (clamped.w !== w) x = r.startPos.x + r.startSize.w - clamped.w;
      if (clamped.h !== h) y = r.startPos.y + r.startSize.h - clamped.h;
      const win = getCurrentWindow();
      const moves = [win.setSize(new LogicalSize(clamped.w, clamped.h))];
      if (anchored) moves.push(win.setPosition(new LogicalPosition(Math.round(x), Math.round(y))));
      void Promise.all(moves).catch(() => undefined);
      curRef.current = clamped;
    };
    const onUp = () => {
      const r = resizeRef.current;
      if (!r) return;
      resizeRef.current = null;
      const init = initRef.current;
      if (init.w > 0) {
        zoomRef.current = Math.min(ZOOM_MAX, curRef.current.w / init.w);
        flashBadge(zoomRef.current);
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [flashBadge]);

  const onMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest(".pin-actions") !== null) return;
      event.preventDefault();
      getCurrentWindow()
        .startDragging()
        .catch((e: unknown) => showHint(errorText(e)));
    },
    [showHint],
  );

  const ZONES: Array<{ dir: ZoneDir; style: CSSProperties; cursor: string }> = [
    { dir: "top", style: { left: 0, right: 0, top: 0, height: 4 }, cursor: "ns-resize" },
    { dir: "bottom", style: { left: 0, right: 0, bottom: 0, height: 4 }, cursor: "ns-resize" },
    { dir: "left", style: { left: 0, top: 0, bottom: 0, width: 4 }, cursor: "ew-resize" },
    { dir: "right", style: { right: 0, top: 0, bottom: 0, width: 4 }, cursor: "ew-resize" },
    { dir: "top-left", style: { left: 0, top: 0, width: 10, height: 10 }, cursor: "nwse-resize" },
    { dir: "top-right", style: { right: 0, top: 0, width: 10, height: 10 }, cursor: "nesw-resize" },
    { dir: "bottom-left", style: { left: 0, bottom: 0, width: 10, height: 10 }, cursor: "nesw-resize" },
    { dir: "bottom-right", style: { right: 0, bottom: 0, width: 10, height: 10 }, cursor: "nwse-resize" },
  ];

  if (error !== null) {
    return <div className="pin-root"><div className="pin-error">{error}</div></div>;
  }
  if (dataUrl === null) return null;

  return (
    <div className="pin-root" onMouseDown={onMouseDown}>
      <img src={dataUrl} alt="" draggable={false} />
      {ZONES.map(({ dir, style, cursor }) => (
        <div
          key={dir}
          className="pin-zone"
          style={{ ...style, cursor }}
          onMouseDown={(e) => onZoneDown(e, dir)}
        />
      ))}
      <div className="pin-actions" onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" className="pin-circle" title="复制" onClick={() => void copy()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        </button>
        <button type="button" className="pin-circle" title="保存" onClick={() => void save()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4v10" />
            <path d="M8 10l4 4 4-4" />
            <path d="M4 18h16" />
          </svg>
        </button>
        <button type="button" className="pin-circle pin-circle-close" title="关闭" onClick={() => void close()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      {badge !== null && <div className="pin-badge">{badge}</div>}
      {hint !== null && <div className="pin-hint">{hint}</div>}
    </div>
  );
}
