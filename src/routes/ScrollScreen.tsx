/**
 * Long-screenshot fullscreen panel (`scroll_screenshot_panel_<id>`).
 *
 * Stroke-by-stroke port of the reference `assets_scrollScreen-Bo1n5gwJ.js`
 * chunk (see `.tmp/ref-scroll/scroll.pretty.js`): a transparent panel over
 * the LIVE screen where the user frames a selection, an operations bar with
 * the reference's two-stage arm (1000ms beat → recording, 1500ms → capture),
 * sticky-style tips, and a live preview of the stitched image placed beside
 * the selection. During recording the window turns click-through so the
 * scrolled page keeps receiving the wheel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, events, type ScrollScreenshotData } from "../lib/ipc";

type Bounds = { x: number; y: number; width: number; height: number };

type HandleDir =
  | "top"
  | "top-right"
  | "right"
  | "right-bottom"
  | "bottom"
  | "bottom-left"
  | "left"
  | "left-top"
  | "move";

const win = getCurrentWindow();

/* ------------------------------------------------------------- geometry */

/** Normalise a drag into a rect (reference `Ie`; `W = 0` — no minimum). */
function normalize(
  a: { x: number; y: number },
  b: { x: number; y: number },
  w: number,
  h: number,
): Bounds {
  let x0 = a.x;
  let y0 = a.y;
  let x1 = b.x;
  let y1 = b.y;
  if (x0 > x1) [x0, x1] = [x1, x0];
  if (y0 > y1) [y0, y1] = [y1, y0];
  x0 = Math.max(0, x0);
  x1 = Math.min(w, x1);
  y0 = Math.max(0, y0);
  y1 = Math.min(h, y1);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Capture inset (reference `Pe`): 3px per edge, clamped to odd sizes. */
function captureInset(b: Bounds, scale: number): Bounds & { scaleFactor: number } {
  const w = Math.round(b.width * scale);
  const h = Math.round(b.height * scale);
  const ix = Math.max(0, Math.min(3, Math.floor((w - 1) / 2)));
  const iy = Math.max(0, Math.min(3, Math.floor((h - 1) / 2)));
  return {
    x: Math.round(b.x * scale) + ix,
    y: Math.round(b.y * scale) + iy,
    width: w - ix * 2,
    height: h - iy * 2,
    scaleFactor: scale,
  };
}

/** Resize one edge set (reference `$e`); min size 200 (reference `p`). */
const MIN_SIZE = 200;

function resize(
  e: { clientX: number; clientY: number },
  dir: HandleDir,
  start: { x: number; y: number },
  origin: Bounds,
): [{ x: number; y: number }, { x: number; y: number }] {
  const dx = e.clientX - start.x;
  const dy = e.clientY - start.y;
  let { x: l, y: t } = origin;
  let r = origin.x + origin.width;
  let b = origin.y + origin.height;
  switch (dir) {
    case "top":
      if (b - (t + dy) >= MIN_SIZE) t += dy;
      else t = b - MIN_SIZE;
      break;
    case "top-right":
      if (b - (t + dy) >= MIN_SIZE) t += dy;
      else t = b - MIN_SIZE;
      if (r + dx - l >= MIN_SIZE) r += dx;
      else r = l + MIN_SIZE;
      break;
    case "right":
      if (r + dx - l >= MIN_SIZE) r += dx;
      else r = l + MIN_SIZE;
      break;
    case "right-bottom":
      if (r + dx - l >= MIN_SIZE) r += dx;
      else r = l + MIN_SIZE;
      if (b + dy - t >= MIN_SIZE) b += dy;
      else b = t + MIN_SIZE;
      break;
    case "bottom":
      if (b + dy - t >= MIN_SIZE) b += dy;
      else b = t + MIN_SIZE;
      break;
    case "bottom-left":
      if (r - (l + dx) >= MIN_SIZE) l += dx;
      else l = r - MIN_SIZE;
      if (b + dy - t >= MIN_SIZE) b += dy;
      else b = t + MIN_SIZE;
      break;
    case "left":
      if (r - (l + dx) >= MIN_SIZE) l += dx;
      else l = r - MIN_SIZE;
      break;
    case "left-top":
      if (r - (l + dx) >= MIN_SIZE) l += dx;
      else l = r - MIN_SIZE;
      if (b - (t + dy) >= MIN_SIZE) t += dy;
      else t = b - MIN_SIZE;
      break;
    case "move":
      l += dx;
      t += dy;
      r += dx;
      b += dy;
      break;
  }
  return [
    { x: l, y: t },
    { x: r, y: b },
  ];
}

/** Clamp the resized rect (reference `Ne`): inside the screen, min 200. */
function clampResize(
  a: { x: number; y: number },
  b: { x: number; y: number },
  bounds: Bounds,
  vw: number,
  vh: number,
  dir: HandleDir,
): Bounds {
  let { x: l, y: t } = a;
  let { x: r, y: bo } = b;
  if (l > r) [l, r] = [r, l];
  if (t > bo) [t, bo] = [bo, t];
  l = Math.max(0, l);
  if (dir === "move") r = l + bounds.width;
  r = Math.min(vw, r);
  if (dir === "move") l = r - bounds.width;
  t = Math.max(0, t);
  if (dir === "move") bo = t + bounds.height;
  bo = Math.min(vh, bo);
  if (dir === "move") t = bo - bounds.height;
  let w = r - l;
  let h = bo - t;
  if (w < MIN_SIZE) {
    if (dir === "move") w = bounds.width;
    else if (dir.includes("right")) r = l + MIN_SIZE;
    else if (dir.includes("left")) l = r - MIN_SIZE;
    else r = l + MIN_SIZE;
    w = r - l;
  }
  if (h < MIN_SIZE) {
    if (dir === "move") h = bounds.height;
    else if (dir.includes("bottom")) bo = t + MIN_SIZE;
    else if (dir.includes("top")) t = bo - MIN_SIZE;
    else bo = t + MIN_SIZE;
    h = bo - t;
  }
  return { x: l, y: t, width: Math.round(w), height: Math.round(h) };
}

/* -------------------------------------------------------- preview placement
 * Reference `Fe`: fit the preview beside the selection — right if it fits,
 * then left, then above, then below, else the bottom-left corner fallback.
 * macOS boxes: max 360×520, min width 240, gap 10, screen edge margin 20. */

const PREVIEW_GAP = 10;
const PREVIEW_EDGE = 20;
const PREVIEW_MAX_W = 360;
const PREVIEW_MIN_W = 240;
const PREVIEW_MAX_H = 520;

function fitByWidth(
  iw: number,
  ih: number,
  maxW: number,
  maxH: number,
  minW: number,
): { width: number; height: number } {
  const ratio = iw / ih;
  let width = maxW;
  let height = width / ratio;
  if (height > maxH) {
    height = maxH;
    width = height * ratio;
  }
  if (width < minW) {
    width = minW;
    height = width / ratio;
    if (height > maxH) {
      height = maxH;
      width = height * ratio;
    }
  }
  return { width, height };
}

function placePreview(
  img: { naturalWidth: number; naturalHeight: number },
  b: Bounds,
  vw: number,
  vh: number,
): { x: number; y: number; width: number; height: number } {
  const fit = fitByWidth(img.naturalWidth, img.naturalHeight, PREVIEW_MAX_W, PREVIEW_MAX_H, PREVIEW_MIN_W);
  const bottomFor = (h: number) => Math.max(b.y + b.height - h, PREVIEW_EDGE);
  const sideFor = (maxW: number) => {
    const maxH = Math.min(
      PREVIEW_MAX_H,
      Math.max(PREVIEW_MIN_W / (img.naturalWidth / img.naturalHeight), b.y + b.height - PREVIEW_EDGE),
    );
    return fitByWidth(img.naturalWidth, img.naturalHeight, maxW, maxH, PREVIEW_MIN_W);
  };
  const need = PREVIEW_MAX_W + PREVIEW_GAP;

  if (vw - (b.x + b.width) >= need) {
    const s = sideFor(fit.width);
    return { x: b.x + b.width + PREVIEW_GAP, y: bottomFor(s.height), ...s };
  }
  if (b.x >= need) {
    const s = sideFor(fit.width);
    return { x: b.x - s.width - PREVIEW_GAP, y: bottomFor(s.height), ...s };
  }
  if (b.y >= PREVIEW_MAX_H + PREVIEW_GAP) {
    const maxH = Math.min(PREVIEW_MAX_H, b.y - PREVIEW_GAP);
    const f = fitByWidth(img.naturalWidth, img.naturalHeight, Math.min(PREVIEW_MAX_W, b.width), maxH, PREVIEW_MIN_W);
    return {
      x: b.x,
      y: Math.max(PREVIEW_EDGE, b.y - f.height - PREVIEW_GAP),
      ...f,
    };
  }
  if (vh - (b.y + b.height) >= PREVIEW_MAX_H + PREVIEW_GAP) {
    const maxH = Math.min(PREVIEW_MAX_H, vh - (b.y + b.height) - PREVIEW_GAP);
    const f = fitByWidth(img.naturalWidth, img.naturalHeight, Math.min(PREVIEW_MAX_W, b.width), maxH, PREVIEW_MIN_W);
    return { x: b.x, y: b.y + b.height + PREVIEW_GAP, ...f };
  }
  // Reference fallback: bottom-left of the selection, 65% of its height.
  const maxH = Math.min(PREVIEW_MAX_H, b.height * 0.65);
  const f = fitByWidth(
    img.naturalWidth,
    img.naturalHeight,
    Math.min(PREVIEW_MAX_W, Math.max(PREVIEW_MIN_W, b.width - 40)),
    maxH,
    PREVIEW_MIN_W,
  );
  return { x: b.x + PREVIEW_GAP, y: b.y + PREVIEW_GAP, ...f };
}

/* -------------------------------------------------------------- icons */

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
      {/* eslint-disable-next-line react/no-danger -- static path strings, same as Toolbar */}
      <g dangerouslySetInnerHTML={{ __html: paths }} />
    </svg>
  );
}

const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M4 18h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check:
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
};

/* ------------------------------------------------------- selection frame */

const HANDLES: HandleDir[] = [
  "top",
  "top-right",
  "right",
  "right-bottom",
  "bottom",
  "bottom-left",
  "left",
  "left-top",
];

function handleCursor(dir: HandleDir): string {
  switch (dir) {
    case "top":
    case "bottom":
      return "ns-resize";
    case "left":
    case "right":
      return "ew-resize";
    case "top-right":
    case "bottom-left":
      return "nesw-resize";
    case "right-bottom":
    case "left-top":
      return "nwse-resize";
    default:
      return "default";
  }
}

function handlePoint(dir: HandleDir, b: Bounds): { x: number; y: number } {
  switch (dir) {
    case "top":
      return { x: b.x + b.width / 2, y: b.y };
    case "top-right":
      return { x: b.x + b.width, y: b.y };
    case "right":
      return { x: b.x + b.width, y: b.y + b.height / 2 };
    case "right-bottom":
      return { x: b.x + b.width, y: b.y + b.height };
    case "bottom":
      return { x: b.x + b.width / 2, y: b.y + b.height };
    case "bottom-left":
      return { x: b.x, y: b.y + b.height };
    case "left":
      return { x: b.x, y: b.y + b.height / 2 };
    case "left-top":
      return { x: b.x, y: b.y };
    default:
      return { x: 0, y: 0 };
  }
}

/**
 * The selection chrome: four 30% dim rects, a white solid + black dashed
 * double border, the move surface, and 8 round resize handles
 * (reference `assets_index-DEPgd5qH` `D`).
 */
function SelectionFrame({
  bounds,
  cursor,
  interactive,
  canResize,
  onHandleDown,
  onMoveDown,
}: {
  bounds: Bounds;
  cursor: string;
  interactive: boolean;
  canResize: boolean;
  onHandleDown: (e: React.MouseEvent, dir: HandleDir) => void;
  onMoveDown: (e: React.MouseEvent) => void;
}) {
  const mask = (x: number, y: number, w: number | string, h: number | string) => (
    <rect x={x} y={y} width={w} height={h} fill="rgba(0,0,0,0.3)" style={{ pointerEvents: "all", cursor }} />
  );
  return (
    <svg
      className="scrollpanel-canvas"
      style={{ position: "fixed", left: 0, top: 0, width: "100vw", height: "100vh", pointerEvents: "none", zIndex: 100 }}
    >
      {/* eslint-disable react/no-unknown-property -- calc() strings are valid SVG lengths */}
      {mask(0, 0, "100%", bounds.y)}
      {mask(0, bounds.y + bounds.height, "100%", `calc(100% - ${bounds.y + bounds.height}px)`)}
      {mask(0, bounds.y, bounds.x, bounds.height)}
      {mask(bounds.x + bounds.width, bounds.y, `calc(100% - ${bounds.x + bounds.width}px)`, bounds.height)}
      <rect
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        fill="none"
        stroke="white"
        strokeWidth={1}
        style={{ pointerEvents: "none" }}
      />
      <rect
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        fill="none"
        stroke="black"
        strokeWidth={1}
        strokeDasharray="2,3"
        style={{ pointerEvents: "none" }}
      />
      <rect
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        fill="none"
        style={{ cursor: "move", pointerEvents: interactive ? "all" : "none" }}
        onMouseDown={onMoveDown}
      />
      {canResize &&
        HANDLES.map((dir) => {
          const p = handlePoint(dir, bounds);
          return (
            <circle
              key={dir}
              cx={p.x}
              cy={p.y}
              r={5}
              fill="white"
              stroke="black"
              strokeWidth={1}
              style={{ cursor: handleCursor(dir), pointerEvents: "all" }}
              onMouseDown={(e) => onHandleDown(e, dir)}
            />
          );
        })}
    </svg>
  );
}

/** Size chip above the selection: `${w}*${h}` (reference `Be`). */
function SizeBadge({
  bounds,
  vw,
  vh,
}: {
  bounds: Bounds;
  vw: number;
  vh: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos] = useMemo(() => {
    const h = 28;
    const x = Math.min(Math.max(bounds.x, 0), Math.max(vw - 80, 0));
    const y = Math.max(bounds.y - (h + 10), 0);
    return [{ x, y }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds.x, bounds.y, vw, vh, ref.current?.getBoundingClientRect().width]);
  return (
    <div
      ref={ref}
      className="scrollpanel-size"
      style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
    >
      {`${Math.round(bounds.width)}*${Math.round(bounds.height)}`}
    </div>
  );
}

/* ------------------------------------------------------- operations bar */

type BarButton = {
  id: string;
  title: string;
  icon: string;
  onClick: () => void;
};

/* ------------------------------------------------------------- the panel */

export function ScrollScreen() {
  /* store — the reference zustand fields, lifted into one component */
  const [monitorId, setMonitorId] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [canDraw, setCanDraw] = useState(true);
  const [cursor, setCursor] = useState("crosshair");
  const [isMove, setIsMove] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [isStart, setIsStart] = useState(false);
  const [selScale, setSelScale] = useState<number | null>(null);
  const [imagePos, setImagePos] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [previewUrl, setPreviewUrl] = useState("");

  /* local UI state */
  const [barPos, setBarPos] = useState<{ x: number; y: number } | null>(null);
  const [barDragging, setBarDragging] = useState(false);
  const [barUserMoved, setBarUserMoved] = useState(false);
  const [barBox, setBarBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [errorTip, setErrorTip] = useState<string | null>(null);
  const [hideStartTip, setHideStartTip] = useState(false);

  const barRef = useRef<HTMLDivElement | null>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const drew = useRef(false);
  const resizeRef = useRef<{
    dir: HandleDir;
    start: { x: number; y: number };
    origin: Bounds;
  } | null>(null);
  /* The arm timers' beat counter (reference `C`): every cancel bumps it, both
   * timers verify it before firing. */
  const beat = useRef(0);
  const armTimer1 = useRef<number | null>(null);
  const armTimer2 = useRef<number | null>(null);

  const dpr = () => window.devicePixelRatio || 1;

  const quit = useCallback(() => {
    void api.hideScrollScreenshotPanel().catch(() => {});
    setBounds(null);
    setIsRecording(false);
    setIsStart(false);
    setPreviewUrl("");
  }, []);

  /** Disarm both timers (reference `P`). */
  const cancelArm = useCallback(() => {
    beat.current += 1;
    if (isStart) setIsStart(false);
    if (armTimer1.current !== null) {
      window.clearTimeout(armTimer1.current);
      armTimer1.current = null;
    }
    if (armTimer2.current !== null) {
      window.clearTimeout(armTimer2.current);
      armTimer2.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStart]);

  /* ---------------------------------------------------- data + lifecycle */

  useEffect(() => {
    const un: Promise<() => void>[] = [
      events.onScrollScreenshotData((d: ScrollScreenshotData) => {
        const scale = dpr();
        setCanDraw(true);
        setCursor("crosshair");
        setSize({ w: d.width * scale, h: d.height * scale });
        setMonitorId(d.monitorId);
        setSelScale(d.selectionScaleFactor);
        if (d.boundsWidth && d.boundsHeight) {
          setIsMove(false);
          setIsRecording(false);
          setBounds({ x: d.x, y: d.y, width: d.boundsWidth, height: d.boundsHeight });
        }
      }),
      events.onScrollScreenClear(() => {
        if (boundsRef.current) quit();
        else {
          setBounds(null);
          setIsMove(true);
          setIsRecording(false);
          setIsStart(false);
        }
      }),
      events.onScrollScreenshotClickStop(() => {
        setIsRecording(false);
        void win.setIgnoreCursorEvents(false).catch(() => {});
      }),
      events.onScrollScreenshotDrawn(() => {
        setCanDraw(false);
        setCursor("default");
      }),
      events.onShowScrollTip((on) => setIsStart(on)),
      events.onScrollScreenshotError((e) => {
        setErrorTip(e?.message || "拼接失败，请回到拼接点缓慢滚动页面");
        window.setTimeout(() => setErrorTip(null), 3000);
      }),
      events.onScrollImageUpdate(async (e) => {
        if (!e?.path) return;
        const url = `${convertFileSrc(e.path)}?timestamp=${Date.now()}`;
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => resolve();
          img.src = url;
        });
        setPreviewUrl(url);
      }),
    ];
    // Mount handshake (reference: invoke + emit `scroll_screenshot_panel_loaded_event`).
    void api.scrollPanelLoaded().catch(() => {});
    return () => {
      for (const p of un) void p.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* isRecording → click-through (reference `$.setIgnoreCursorEvents(a)`). */
  useEffect(() => {
    void win.setIgnoreCursorEvents(isRecording).catch(() => {});
  }, [isRecording]);

  /* Escape quits when not recording (reference keydown). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isRecording) quit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isRecording, quit]);

  /* Selection settled → notify Rust once (reference `ze` effect). */
  useEffect(() => {
    if (!drew.current && bounds && !isMove && bounds.width) {
      void api.drawnScrollScreenshot().catch(() => {});
      drew.current = true;
    }
  }, [bounds, isMove]);

  /* Reset the drawn flag when bounds are cleared. */
  useEffect(() => {
    if (!bounds) drew.current = false;
  }, [bounds]);

  useEffect(() => {
    if (isStart || isMove) setHideStartTip(true);
  }, [isStart, isMove]);

  /* Preview placement follows the selection (reference `Ye` + `Fe`). */
  useEffect(() => {
    if (!previewUrl || !bounds) return;
    const img = new Image();
    img.onload = () => {
      setImagePos(placePreview(img, bounds, size.w, size.h));
    };
    img.src = previewUrl;
  }, [previewUrl, bounds, size.w, size.h]);

  /* ---------------------------------------------------------- draw phase */

  const onBackgroundDown = useCallback(
    (e: React.MouseEvent) => {
      if (drawStart.current || (bounds && bounds.width) || e.button !== 0 || !canDraw) return;
      drawStart.current = { x: e.clientX, y: e.clientY };
      setIsMove(false);
    },
    [bounds, canDraw],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (drawStart.current) {
        setBounds(normalize(drawStart.current, { x: e.clientX, y: e.clientY }, size.w, size.h));
        setIsMove(true);
      }
    };
    const onUp = () => {
      if (drawStart.current) {
        drawStart.current = null;
        setIsMove(false);
        setCursor("default");
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [size.w, size.h]);

  useEffect(() => {
    if (bounds && bounds.width) setCursor("default");
  }, [bounds]);

  /* --------------------------------------------------------- resize phase */

  const onHandleDown = useCallback(
    (e: React.MouseEvent, dir: HandleDir) => {
      if (e.button !== 0 || !bounds || !bounds.width) return;
      resizeRef.current = { dir, start: { x: e.clientX, y: e.clientY }, origin: bounds };
    },
    [bounds],
  );

  const onMaskDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || !bounds || !bounds.width) return;
      resizeRef.current = { dir: "move", start: { x: e.clientX, y: e.clientY }, origin: bounds };
    },
    [bounds],
  );

  useEffect(() => {
    const apply = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r || !bounds) return;
      const [a, b] = resize(e, r.dir, r.start, r.origin);
      setBounds(clampResize(a, b, bounds, size.w, size.h, r.dir));
    };
    const onMove = (e: MouseEvent) => {
      if (isRecording) return;
      if (resizeRef.current) {
        apply(e);
        setIsMove(true);
      }
    };
    const onUp = (e: MouseEvent) => {
      if (isRecording) return;
      if (resizeRef.current) {
        apply(e);
        resizeRef.current = null;
        setIsMove(false);
        setCursor("default");
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [bounds, isRecording, size.w, size.h]);

  /* Snap the bar to the selection until the user drags it (reference `Te`). */
  useEffect(() => {
    if (!bounds || !barRef.current) return;
    if (!bounds.width) return;
    if (!barUserMoved && !barDragging) {
      const rect = barRef.current.getBoundingClientRect();
      let x = bounds.x + bounds.width - rect.width;
      let y = bounds.y + bounds.height + 10;
      if (y + rect.height > size.h - 10) y = bounds.y - rect.height - 10;
      x = Math.max(0, Math.min(x, size.w - rect.width));
      y = Math.max(0, Math.min(y, size.h - rect.height));
      if (!barPos || Math.abs(barPos.x - x) > 1 || Math.abs(barPos.y - y) > 1) setBarPos({ x, y });
    }
    const rect = barRef.current.getBoundingClientRect();
    if (
      !barBox ||
      Math.abs(barBox.x - rect.x) > 1 ||
      Math.abs(barBox.y - rect.y) > 1 ||
      Math.abs(barBox.width - rect.width) > 1 ||
      Math.abs(barBox.height - rect.height) > 1
    ) {
      setBarBox({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds?.x, bounds?.y, bounds?.width, bounds?.height, isMove, barUserMoved, barDragging, barPos, size.w, size.h]);

  /* Reset the user's drag override when the selection changes. */
  useEffect(() => {
    setBarUserMoved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds?.x, bounds?.y, bounds?.width, bounds?.height]);

  /* Bar dragging (reference `ue`/`Z`/`q`). */
  useEffect(() => {
    if (!barDragging) return;
    const start = dragOffset.current;
    const onMove = (e: MouseEvent) => {
      const x = Math.max(0, Math.min(e.clientX - start.x, size.w - (barBox?.width ?? 0)));
      const y = Math.max(0, Math.min(e.clientY - start.y, size.h - (barBox?.height ?? 0)));
      setBarPos({ x, y });
    };
    const onUp = () => setBarDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barDragging, size.w, size.h]);

  const dragOffset = useRef({ x: 0, y: 0 });

  const onBarDown = useCallback(
    (e: React.MouseEvent) => {
      const rect = barRef.current?.getBoundingClientRect();
      if (!barPos || !rect) return;
      if ((e.target as HTMLElement).closest(".scrollpanel-bar-btn")) return;
      e.preventDefault();
      e.stopPropagation();
      dragOffset.current = { x: e.clientX - barPos.x, y: e.clientY - barPos.y };
      setBarDragging(true);
      setBarUserMoved(true);
    },
    [barPos],
  );

  /* ------------------------------------------------------------ actions */

  /** `xw_YYYYMMDDHHmmss.png` (reference save name). */
  const stampName = () => {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `xw_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
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

  const cropRect = (b: Bounds) => ({
    monitorId: monitorId ?? 0,
    x: Math.round(b.x * dpr()),
    y: Math.round(b.y * dpr()),
    width: Math.round(b.width * dpr()),
    height: Math.round(b.height * dpr()),
  });

  /** 保存 (copy) — reference `he`. */
  const onSaveCopy = useCallback(async () => {
    cancelArm();
    if (!bounds) return;
    const extra = await autoSavePath();
    try {
      await api.screenshotCrop({ ...cropRect(bounds), actionType: "copy", filePath: "", autoSavePath: extra });
    } finally {
      quit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, cancelArm, quit, monitorId]);

  /** 下载 (saveAs) — reference `de`; cancelling the dialog quits anyway. */
  const onSaveAs = useCallback(async () => {
    cancelArm();
    if (!bounds) return;
    const picked = await saveDialog({
      defaultPath: stampName(),
      filters: [{ name: "Image", extensions: ["png"] }],
    });
    if (!picked) {
      quit();
      return;
    }
    const extra = await autoSavePath();
    try {
      await api.screenshotCrop({ ...cropRect(bounds), actionType: "saveAs", filePath: picked, autoSavePath: extra });
    } finally {
      quit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, cancelArm, quit, monitorId]);

  /** 开始滚动 — reference `ge`: 1000ms beat → recording, 1500ms → capture. */
  const onStartScroll = useCallback(() => {
    if (isRecording || isMove || !bounds) return;
    cancelArm();
    setIsStart(true);
    const myBeat = beat.current;
    armTimer1.current = window.setTimeout(() => {
      armTimer1.current = null;
      if (beat.current !== myBeat || !boundsRef.current || !isStartRef.current) return;
      setIsRecording(true);
      setIsStart(false);
    }, 1000);
    armTimer2.current = window.setTimeout(() => {
      armTimer2.current = null;
      const b = boundsRef.current;
      if (beat.current !== myBeat || !b || !isRecordingRef.current) return;
      const scale = selScaleRef.current ?? window.devicePixelRatio;
      const rect = captureInset(b, scale);
      void api
        .startScrollScreenshot({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          scaleFactor: rect.scaleFactor,
        })
        .catch((e: unknown) => {
          if (beat.current === myBeat) {
            setIsStart(false);
            setIsRecording(false);
            setErrorTip(String(e));
            window.setTimeout(() => setErrorTip(null), 3000);
          }
        });
    }, 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, isMove, cancelArm]);

  /* Refs so the arm timers read live values without re-arming. */
  const boundsRef = useRef<Bounds | null>(null);
  const isStartRef = useRef(false);
  const isRecordingRef = useRef(false);
  const selScaleRef = useRef<number | null>(null);
  useEffect(() => {
    boundsRef.current = bounds;
    isStartRef.current = isStart;
    isRecordingRef.current = isRecording;
    selScaleRef.current = selScale;
  }, [bounds, isStart, isRecording, selScale]);

  /* Disarm on unmount. */
  useEffect(() => cancelArm(), [cancelArm]);

  /* Right-click cancels while still drawable (reference `ze` `b`). */
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 2 || isRecording || !canDraw) return;
      e.preventDefault();
      quit();
    },
    [isRecording, canDraw, quit],
  );

  const canResize = (bounds?.width ?? 0) > 0 && !isRecording;

  const barButtons: BarButton[] = [
    { id: "download", title: "下载", icon: ICONS.download, onClick: () => void onSaveAs() },
    { id: "close", title: "关闭", icon: ICONS.close, onClick: () => { cancelArm(); quit(); } },
    { id: "check", title: "保存", icon: ICONS.check, onClick: () => void onSaveCopy() },
  ];

  if (size.w <= 0) return null;

  return (
    <div
      className="scrollpanel"
      style={{ width: size.w, height: size.h, cursor }}
      onMouseDown={onBackgroundDown}
      onContextMenu={onContextMenu}
    >
      {bounds && bounds.width > 0 && (
        <>
          <SelectionFrame
            bounds={bounds}
            cursor={cursor}
            interactive={!isRecording}
            canResize={canResize}
            onHandleDown={onHandleDown}
            onMoveDown={onMaskDown}
          />
          {/* Tips live over the selection (reference `recording-area-tips`). */}
          <div
            className="scrollpanel-tips"
            style={{ position: "fixed", left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
          >
            {!isRecording && !hideStartTip && (
              <div className="scrollpanel-tip">点击开始滚动进行长截图</div>
            )}
            {isStart && (
              <div className="scrollpanel-tip">
                <p>将鼠标移入选区域后将开始滚动截图</p>
                <p>截图过程中请不要手动滚动</p>
              </div>
            )}
            {errorTip && <div className="scrollpanel-tip">{errorTip}</div>}
          </div>
          {/* Move surface over the selection (reference `#recording-area-mask`). */}
          <div
            className="scrollpanel-mask"
            style={{
              position: "fixed",
              left: bounds.x,
              top: bounds.y,
              width: bounds.width,
              height: bounds.height,
              pointerEvents: isRecording ? "none" : "auto",
              zIndex: 99,
            }}
            onMouseDown={onMaskDown}
          />
          {canResize && <SizeBadge bounds={bounds} vw={size.w} vh={size.h} />}
        </>
      )}

      {/* Operations bar (reference `Te`). */}
      <div
        ref={barRef}
        className="scrollpanel-bar"
        id="operation-btn"
        style={{
          opacity: !isRecording && barPos && !isMove && bounds?.width ? 1 : 0,
          pointerEvents: isRecording ? "none" : "auto",
          zIndex: 101,
          transform: `translate(${barPos?.x ?? 0}px, ${barPos?.y ?? 0}px)`,
          cursor: barDragging ? "grabbing" : "grab",
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onMouseDown={onBarDown}
      >
        <div className="scrollpanel-bar-buttons">
          <div
            className="scrollpanel-bar-btn scrollpanel-bar-start"
            onClick={onStartScroll}
          >
            <Icon paths={ICONS.play} />
            <span>开始滚动</span>
          </div>
          {barButtons.map((b) => (
            <div
              key={b.id}
              className="scrollpanel-bar-btn"
              title={b.title}
              onClick={b.onClick}
            >
              <Icon paths={b.icon} />
            </div>
          ))}
        </div>
      </div>

      {/* Live stitched preview (reference `Ye`). */}
      {previewUrl && (
        <img
          src={previewUrl}
          alt=""
          className="scrollpanel-preview"
          style={{
            position: "fixed",
            width: imagePos.width,
            height: imagePos.height,
            top: imagePos.y,
            left: imagePos.x,
            zIndex: 100,
          }}
        />
      )}
    </div>
  );
}
