/** The screenshot overlay: frozen desktop + selection + annotation canvas. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Layer, Stage } from "react-konva";
import Konva from "konva";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Toolbar, type ToolbarAction } from "../components/Toolbar";
import { ShapeNode } from "../canvas/ShapeNode";
import {
  DEFAULT_TOOL_STYLE,
  MOSAIC_PIXEL_MAX,
  MOSAIC_PIXEL_MIN,
  STROKE_WIDTHS,
  TEXT_SIZES,
  TOOL_KEYS,
  clampIndex,
  mosaicBlockOf,
  moveShape,
  nextId,
  stepDiameterOf,
  strokeWidthOf,
  textSizeOf,
  type Point,
  type Shape,
  type ToolId,
  type ToolStyle,
} from "../canvas/model";
import {
  api,
  errorText,
  events,
  type AiAction,
  type CaptureAction,
  type MonitorInfo,
  type ScrollPreview,
  type WindowInfo,
} from "../lib/ipc";
import {
  MIN_SELECTION,
  boxFromPoints,
  clampBox,
  cursorFor,
  formatSize,
  hitHandle,
  isUsableSelection,
  type Box,
  type Handle,
} from "../lib/geometry";

type Props = { monitorId: number };

type Drag =
  | { mode: "select"; start: Point }
  | { mode: "move"; grab: Point; origin: Box }
  | { mode: "resize"; handle: Exclude<Handle, null | "move">; origin: Box }
  | { mode: "draw"; start: Point }
  | { mode: "shape"; id: string; grab: Point; origin: Shape };

/** Inline text editor: `id` is set when re-editing an existing text shape. */
type TextEdit = { at: Point; value: string; id?: string; style?: ToolStyle };

/** A detected window mapped into this monitor's local coordinates. */
type WinBox = {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  owner: string;
  title: string;
};

/** Opacity step for the wheel, mirroring the reference `I@394891`. */
const WHEEL_OPACITY_STEP = 0.1;

export function Overlay({ monitorId }: Props) {
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null);
  const [, setSessionId] = useState<string | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);

  const [box, setBox] = useState<Box | null>(null);
  const [tool, setTool] = useState<ToolId>("select");
  /** Every per-tool drawing parameter; the toolbar's bubbles edit this. */
  const [style, setStyle] = useState<ToolStyle>(DEFAULT_TOOL_STYLE);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState<Point | null>(null);
  /** Inline text editor: open at the click point while the text tool is used. */
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);

  /* ------------------------------------------- window detect + shape select */
  /** On-screen windows mapped into this monitor's local points (front-to-back). */
  const [winBoxes, setWinBoxes] = useState<WinBox[]>([]);
  /** The window highlighted under the cursor, before any selection exists. */
  const [hoverWin, setHoverWin] = useState<WinBox | null>(null);
  /** The committed annotation the user last grabbed; Delete removes it. */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /* ------------------------------------------------------- scroll capture */
  /** Long-screenshot session state; null = normal capture mode. */
  const [scrollMode, setScrollMode] = useState<{
    sessionId: string;
    /** The selection the capture started from, for preview anchoring. */
    anchor: Box;
    phase: "idle" | "recording" | "paused" | "finished" | "failed";
  } | null>(null);
  /** Live preview thumbnail (decoded url + computed placement). */
  const [scrollPreview, setScrollPreview] = useState<{
    url: string;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  /** Transient tip from Rust (reference state-machine texts). */
  const [scrollTip, setScrollTip] = useState<{ kind: string; text: string } | null>(null);
  /** Decoded images cached by base URL so repeated events don't flicker. */
  const previewCache = useRef(new Map<string, HTMLImageElement>());
  /** The live session id, readable from async callbacks (decode races). */
  const scrollModeRef = useRef<string | null>(null);

  /** Patch drawing parameters; a fresh object each time so React re-renders. */
  const patchStyle = useCallback((patch: Partial<ToolStyle>) => {
    setStyle((prev) => ({ ...prev, ...patch }));
  }, []);

  const drag = useRef<Drag | null>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * The annotation layer, held directly.
   *
   * Export used to reach into `stage.getLayers()[1]`, which silently produced
   * `undefined` (the stage has exactly one layer), so every annotation was
   * dropped on copy/save/pin/AI with no error. Keeping the reference means an
   * export can never again depend on the layer's ordinal position.
   */
  const annotationLayerRef = useRef<Konva.Layer>(null);
  const sourceRef = useRef<HTMLImageElement | null>(null);
  /** Offscreen copy of the frozen frame, reused for pixel sampling. */
  const sampleRef = useRef<HTMLCanvasElement | null>(null);
  /** Live readout for the eyedropper: position + sampled colour channels. */
  const [picker, setPicker] = useState<
    { x: number; y: number; r: number; g: number; b: number } | null
  >(null);
  /** Which colour notation the loupe shows (and the clipboard receives). */
  const [pickerFmt, setPickerFmt] = useState<PickerFmt>("hex");
  const pickerCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** Load the monitor descriptor + frozen frame for this window. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await import("@tauri-apps/api/core")
          .then((m) => m.invoke("debug_report", { stage: "overlay-mount", detail: String(monitorId) }))
          .catch(() => undefined);
        // Rust creates the session and shows this window; it also emits
        // `capture://ready` with the session id. Reuse it instead of capturing
        // a second time (a second capture would include this very overlay).
        const session = await api.currentSession();
        if (!session) throw new Error("截图会话已结束，请重新截图");
        const info = session.monitors.find((m) => m.id === monitorId) ?? session.monitors[0];
        if (!info) throw new Error("没有可用的显示器");
        setMonitor(info);
        setSessionId(session.sessionId);

        const path = await api.framePath(info.id, session.sessionId);
        if (cancelled) return;
        if (!path) throw new Error("无法读取截图帧");
        const src = convertFileSrc(path);
        setFrameSrc(src);

        const img = new Image();
        // The frozen frame is served over the `asset:` scheme. Without a CORS
        // request the drawn copy taints the canvas and every `getImageData`
        // call (the eyedropper) throws SecurityError; Tauri's asset handler does
        // send `Access-Control-Allow-Origin`, so ask for a clean one. This must
        // be set before `src`, or the fetch has already started uncrossed.
        img.crossOrigin = "anonymous";
        img.src = src;
        await img.decode().catch(() => undefined);
        sourceRef.current = img;

        // One full-size copy is enough for every eyedropper sample; drawing
        // the 5MP frame on each pick was both slow and wasteful.
        const sample = document.createElement("canvas");
        sample.width = img.naturalWidth;
        sample.height = img.naturalHeight;
        sample
          .getContext("2d", { willReadFrequently: true })
          ?.drawImage(img, 0, 0);
        // Drop the cache if the copy cannot be read back, so the eyedropper
        // reports "no sample" instead of throwing on every mouse move.
        try {
          sample
            .getContext("2d", { willReadFrequently: true })
            ?.getImageData(0, 0, 1, 1);
          sampleRef.current = sample;
        } catch (e) {
          console.warn("frame canvas is not readable; eyedropper disabled", e);
          sampleRef.current = null;
        }
        // Confirm from the terminal that the eyedropper can actually read the
        // frame: an unreadable (tainted) copy is the failure that used to take
        // the whole capture surface down, and it is invisible otherwise.
        {
          const probe = sampleRef.current;
          const px = probe ? probe.getContext("2d") : null;
          let readable = false;
          let sampleHex: string | null = null;
          try {
            const d = px?.getImageData(
              Math.floor(sample.width / 2),
              Math.floor(sample.height / 2),
              1,
              1,
            ).data;
            if (d) {
              readable = true;
              sampleHex = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
            }
          } catch {
            readable = false;
          }
          void reportDebug("frame-sampler", { readable, sampleHex });
        }
      } catch (e) {
        setToast(errorText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [monitorId]);

  const stageSize = monitor
    ? { w: monitor.width, h: monitor.height }
    : { w: size.w, h: size.h };

  /* On-screen windows for hover-to-select, mapped into this monitor's local
     points. Global → local is a pure subtraction (both are logical points in
     the same display space); windows that miss this monitor drop out. */
  useEffect(() => {
    if (!monitor) return;
    let cancelled = false;
    const local = (list: WindowInfo[]): WinBox[] =>
      list
        .map((w) => {
          const x = Math.max(w.x - monitor.x, 0);
          const y = Math.max(w.y - monitor.y, 0);
          const width = Math.min(w.x - monitor.x + w.width, monitor.width) - x;
          const height = Math.min(w.y - monitor.y + w.height, monitor.height) - y;
          return { id: w.id, x, y, width, height, owner: w.owner, title: w.title };
        })
        .filter((b) => b.width >= 60 && b.height >= 40);
    api
      .listWindows()
      .then((list) => {
        if (!cancelled) setWinBoxes(local(list));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [monitor]);

  /** Topmost detected window under the point, if any. */
  const hitWin = useCallback(
    (p: Point): WinBox | null => {
      for (const b of winBoxes) {
        if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) {
          return b;
        }
      }
      return null;
    },
    [winBoxes],
  );

  // Debug affordance: `?debug=box` preselects a centred region so the toolbar
  // can be exercised without a mouse (used by automation).
  const debugBox = new URLSearchParams(window.location.search).has("debug");
  useEffect(() => {
    if (!debugBox || !monitor || box) return;
    setBox({
      x: Math.round(monitor.width * 0.25),
      y: Math.round(monitor.height * 0.25),
      width: Math.round(monitor.width * 0.5),
      height: Math.round(monitor.height * 0.4),
    });
  }, [debugBox, monitor, box]);

  /* ---------------------------------------------------------------- input */

  const pos = useCallback((): Point => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const p = stage.getPointerPosition();
    return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
  }, []);

  const onMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (busy) return;
      // Right click opens the action menu instead of drawing.
      if (e.evt.button === 2) {
        setMenu(pos());
        return;
      }
      if (e.evt.button !== 0) return;
      setMenu(null);
      const p = pos();

      // Moving/resizing belongs to the select tool. Without this gate a
      // drawing tool pressed inside the selection grabbed the box and moved it,
      // which is why annotations only worked outside the screenshot area.
      // Shapes take precedence over moving the crop box: dragging a committed
      // annotation is the expected action when the cursor is on one.
      if (box && tool === "select") {
        const handle = hitHandle(box, p);
        if (handle && handle !== "move") {
          drag.current = { mode: "resize", handle, origin: box };
          setSelectedId(null);
          return;
        }
        const hit = hitShape(shapes, p);
        if (hit) {
          drag.current = { mode: "shape", id: hit.id, grab: p, origin: hit };
          // Grabbing a shape selects it: the dashed outline says "draggable",
          // and Delete/Backspace now removes exactly this one.
          setSelectedId(hit.id);
          return;
        }
        if (handle === "move") {
          drag.current = { mode: "move", grab: p, origin: box };
          setSelectedId(null);
          return;
        }
      }

      if (tool === "select") {
        drag.current = { mode: "select", start: p };
        setBox({ x: p.x, y: p.y, width: 0, height: 0 });
        setShapes([]);
        setSelectedId(null);
        setHoverWin(null);
        return;
      }

      // Picking a colour does not need a crop, so it works before/without a box.
      if (tool === "picker") {
        // A stale drag from the previous select-tool gesture would otherwise be
        // resumed by the next mousemove, which redraws the selection box from
        // its old origin to the new pointer position (the box appeared to
        // shrink or vanish on the first eyedropper click).
        drag.current = null;
        pickColor(p);
        return;
      }
      // The text tool opens an inline editor at the click point. A
      // `window.prompt` here returned null in the wry webview (WKWebView's
      // UI delegate has no JS text panel), which silently ate every click.
      if (tool === "text") {
        if (!box) return;
        drag.current = null;
        // The browser's default mousedown action focuses the click target —
        // the Konva stage container (tabindex=0) — AFTER React has mounted
        // and autoFocus'd the editor, stealing the caret. The reference
        // defers opening its editor for the same reason.
        e.evt.preventDefault();
        // Clicking an existing text shape re-opens it instead of stacking a
        // new one on top; its own font size and colour win while editing.
        const existing = textShapeAt(shapes, p);
        if (existing) {
          setSelectedId(null);
          setTextEdit({
            at: existing.at,
            value: existing.text,
            id: existing.id,
            style: { ...style, color: existing.color, textSizeIdx: sizeIndex(existing.fontSize) },
          });
          return;
        }
        // The reference places the first line at the click point:
        // x - fontSize/4, y - fontSize + 1.
        const textSize = textSizeOf(style);
        setTextEdit({ at: { x: p.x - textSize / 4, y: p.y - textSize + 1 }, value: "" });
        return;
      }
      if (!box) return;
      drag.current = { mode: "draw", start: p };
      setDraft(makeShape(tool, p, p));
    },
    // makeShape reads style/shapes — they must be listed or the callback keeps
    // the values from the render it was last rebuilt on and new shapes get
    // stale styles (and a frozen step counter).
    [box, busy, pickerFmt, pos, shapes, style, tool],
  );

  const onMouseMove = useCallback(() => {
    const p = pos();
    const d = drag.current;

    // A drag only makes sense while the tool that started it is still active.
    // Switching tools mid-gesture (or a click that never got its mouseup) would
    // otherwise resume a stale selection and resize the crop box under the
    // cursor — the eyedropper's click appeared to destroy the selection.
    const dragAllowed =
      d !== null &&
      (d.mode === "select" || d.mode === "move" || d.mode === "resize" || d.mode === "shape"
        ? tool === "select"
        : tool !== "select" && tool !== "picker");
    if (d && !dragAllowed) {
      drag.current = null;
      setDraft(null);
      if (tool === "picker") {
        const seen = sampleAt(p);
        setPicker(seen ? { x: p.x, y: p.y, ...seen } : null);
        setCursor(PICKER_CURSOR);
      }
      return;
    }

    if (!d) {
      if (tool === "picker") {
        const seen = sampleAt(p);
        setPicker(seen ? { x: p.x, y: p.y, ...seen } : null);
        setCursor(PICKER_CURSOR);
        return;
      }
      if (tool === "select" && !box) {
        // Before any selection the cursor is a live inspect surface, like the
        // reference tool's default state: the window under the cursor is
        // outlined (click selects it whole) and the loupe samples the pixel
        // (取色 without switching tools).
        setHoverWin(hitWin(p));
        const seen = sampleAt(p);
        setPicker(seen ? { x: p.x, y: p.y, ...seen } : null);
        setCursor("crosshair");
        return;
      }
      setHoverWin(null);
      if (box && tool === "select") {
        // A committed shape under the cursor drags it (the reference's
        // "select and move"); only empty space moves/resizes the crop.
        if (hitShape(shapes, p)) {
          setCursor("move");
          return;
        }
        setCursor(cursorFor(hitHandle(box, p)));
      } else {
        setCursor("crosshair");
      }
      return;
    }

    // Any active drag hides the window highlight and the loupe.
    setHoverWin(null);
    setPicker(null);

    switch (d.mode) {
      case "select":
      case "draw": {
        const next = boxFromPoints(d.start, p);
        if (d.mode === "select") {
          setBox(next);
        } else if (draft) {
          setDraft(updateShape(draft, p));
        }
        break;
      }
      case "move": {
        const dx = p.x - d.grab.x;
        const dy = p.y - d.grab.y;
        setBox(
          clampBox(
            { ...d.origin, x: d.origin.x + dx, y: d.origin.y + dy },
            stageSize.w,
            stageSize.h,
            MIN_SELECTION,
          ),
        );
        break;
      }
      case "resize": {
        setBox(resizeBox(d.origin, d.handle, p, stageSize.w, stageSize.h));
        break;
      }
      case "shape": {
        // Translate from the grabbed snapshot, not incrementally, so a fast
        // drag never accumulates rounding drift.
        const dx = p.x - d.grab.x;
        const dy = p.y - d.grab.y;
        setShapes((prev) =>
          prev.map((s) => (s.id === d.id ? moveShape(d.origin, dx, dy) : s)),
        );
        setCursor("move");
        break;
      }
    }
  }, [box, draft, hitWin, pos, shapes, stageSize.h, stageSize.w, tool]);

  // Diagnostic: the eyedropper UI vanished right after being selected, so record
  // every tool transition together with the selection state that gates the
  // toolbar. Compiled out of release builds (debug_report is a no-op there).
  useEffect(() => {
    void reportDebug("tool-change", { tool, box: box ? `${box.width}x${box.height}` : null });
  }, [tool, box]);

  // The loupe is a pre-selection affordance: it follows the cursor with the
  // eyedropper tool, and in select mode only until a box exists. This effect
  // is the cleanup for every other combination (tool switch, box drawn).
  useEffect(() => {
    if (tool === "picker") return;
    setPicker(null);
  }, [tool, box]);

  // Paint the magnifier: a 15x15 pixel window from the frozen frame, drawn
  // nearest-neighbour so every source pixel is a crisp square, with the picked
  // pixel ringed in the middle. Backing store and CSS size equal the HUD's
  // inner width (15*9=135): a non-integer upscale left edge rows unpainted,
  // and a canvas narrower than the panel left a dead strip beside it.
  useEffect(() => {
    // Hover mode: select tool before any selection. Tool mode: the picker.
    const loupeVisible = picker !== null && (tool === "picker" || (tool === "select" && !box));
    if (!loupeVisible) return;
    const canvas = pickerCanvasRef.current;
    const sample = sampleRef.current;
    if (!canvas || !sample || !monitor) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ratio = sample.width / monitor.width;
    const cells = 15;
    const size = canvas.width;
    const cell = size / cells;
    const half = (cells - 1) / 2;
    // Keep the whole window inside the frame: near an edge the window shifts
    // instead of clipping, otherwise drawImage paints a proportionally smaller
    // area and leaves the rest of the loupe blank.
    const cx = Math.min(Math.max(Math.round(picker.x * ratio), half), sample.width - 1 - half);
    const cy = Math.min(Math.max(Math.round(picker.y * ratio), half), sample.height - 1 - half);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(
      sample,
      cx - (cells - 1) / 2,
      cy - (cells - 1) / 2,
      cells,
      cells,
      0,
      0,
      size,
      size,
    );
    const offset = Math.floor(cells / 2) * cell;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
    ctx.strokeRect(offset - 0.5, offset - 0.5, cell + 1, cell + 1);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.strokeRect(offset + 0.5, offset + 0.5, cell - 1, cell - 1);
  }, [picker, tool, box, monitor]);

  const onMouseUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;

    if (d.mode === "select") {
      if (box && !isUsableSelection(box)) {
        // A click on a detected window selects it whole — the reference
        // tool's default gesture, and the reason window detection exists.
        // Only a genuine click counts: a real (if tiny) drag still means
        // "I started drawing a box", so it just cancels.
        const p = pos();
        const moved = Math.hypot(p.x - d.start.x, p.y - d.start.y);
        const w = moved <= 6 ? hitWin(p) : null;
        if (w && w.width >= MIN_SELECTION && w.height >= MIN_SELECTION) {
          setBox(
            clampBox(
              { x: w.x, y: w.y, width: w.width, height: w.height },
              stageSize.w,
              stageSize.h,
              MIN_SELECTION,
            ),
          );
          setHoverWin(null);
          setPicker(null);
        } else {
          setBox(null);
        }
      }
      return;
    }
    if (d.mode === "draw" && draft) {
      if (isShapeUsable(draft)) {
        setShapes((prev) => [...prev, draft]);
        // Reference increments the badge counter on creation, so the next
        // number follows the one just placed.
        if (draft.kind === "step") {
          patchStyle({ stepNext: Math.min(99, draft.index + 1) });
        }
      }
      setDraft(null);
    }
  }, [box, draft, hitWin, pos, patchStyle, stageSize.h, stageSize.w]);

  /** Re-open a committed text shape for editing (reference: editable text). */
  const onDblClick = useCallback(() => {
    const p = pos();
    // A double-click on a text shape edits it; anywhere else keeps the
    // reference's "double-click = copy" behaviour. Editing text must not
    // trigger a copy, or the caret would land on a destroyed webview.
    const hit = textShapeAt(shapes, p);
    if (hit) {
      setSelectedId(null);
      setTextEdit({
        at: hit.at,
        value: hit.text,
        id: hit.id,
        style: { ...style, color: hit.color, textSizeIdx: sizeIndex(hit.fontSize) },
      });
      return;
    }
    if (box) void confirm("copy");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, pos, shapes, style]);

  /**
   * Wheel adjusts the parameter of whatever the pointer is over (reference
   * `I@394891`): text → its font size preset, mosaic → pixel strength,
   * highlight → wash opacity, everything else → stroke width. With nothing
   * under the cursor it edits the active tool's default instead, which is the
   * only way to reach a parameter before the first shape exists.
   */
  const onWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      const p = pos();
      const up = e.evt.deltaY < 0;
      const step = up ? 1 : -1;
      const target = hitShape(shapes, p);
      // Keep the page from scrolling under the canvas.
      e.evt.preventDefault();

      if (target) {
        switch (target.kind) {
          case "text":
            patchStyle({
              textSizeIdx: clampIndex(sizeIndex(target.fontSize) + step, TEXT_SIZES.length),
            });
            setShapes((prev) =>
              prev.map((s) =>
                s.id === target.id && s.kind === "text"
                  ? { ...s, fontSize: TEXT_SIZES[clampIndex(sizeIndex(s.fontSize) + step, TEXT_SIZES.length)] }
                  : s,
              ),
            );
            return;
          case "mosaic":
            setShapes((prev) =>
              prev.map((s) => {
                if (s.id !== target.id || s.kind !== "mosaic") return s;
                const pixel = clamp(
                  s.block / 5 + step,
                  MOSAIC_PIXEL_MIN,
                  MOSAIC_PIXEL_MAX,
                );
                return { ...s, block: mosaicBlockOf(pixel) };
              }),
            );
            return;
          case "highlight":
            setShapes((prev) =>
              prev.map((s) => {
                if (s.id !== target.id || s.kind !== "highlight") return s;
                return {
                  ...s,
                  opacity: clamp(s.opacity + step * WHEEL_OPACITY_STEP, 0, 1),
                };
              }),
            );
            return;
          default: {
            // Stroke width is shared by every stroked kind.
            const current = "strokeWidth" in target ? target.strokeWidth : strokeWidthOf(style);
            const next =
              STROKE_WIDTHS[
                clampIndex(
                  STROKE_WIDTHS.findIndex((w) => w >= current) + step,
                  STROKE_WIDTHS.length,
                )
              ];
            setShapes((prev) =>
              prev.map((s) => (s.id === target.id && "strokeWidth" in s ? { ...s, strokeWidth: next } : s)),
            );
            patchStyle({ strokeIdx: STROKE_WIDTHS.indexOf(next) });
            return;
          }
        }
      }

      // Nothing under the pointer: edit the active tool's own default.
      switch (tool) {
        case "text":
          patchStyle({ textSizeIdx: clampIndex(style.textSizeIdx + step, TEXT_SIZES.length) });
          break;
        case "mosaic":
          patchStyle({
            mosaicPixel: clamp(style.mosaicPixel + step, MOSAIC_PIXEL_MIN, MOSAIC_PIXEL_MAX),
          });
          break;
        case "highlight":
          patchStyle({
            highlightOpacity: clamp(style.highlightOpacity + step * WHEEL_OPACITY_STEP, 0, 1),
          });
          break;
        case "select":
        case "picker":
          break;
        default:
          patchStyle({ strokeIdx: clampIndex(style.strokeIdx + step, STROKE_WIDTHS.length) });
          break;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pos, shapes, style, tool],
  );

  /* ------------------------------------------------------------ shortcuts */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys typed into the inline text editor belong to the editor, not to
      // the global shortcuts (digits would switch tools mid-sentence).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      // Scroll-capture mode owns the keyboard: only Escape (cancel the
      // scroll session) gets through; the capture shortcuts are suppressed
      // so they cannot tear the session down mid-stitch.
      if (scrollMode) {
        if (e.key === "Escape") {
          e.preventDefault();
          void stopScroll("cancel");
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Deselect first, then leave the eyedropper, then cancel: each Esc
        // peels one layer instead of throwing the whole capture away.
        if (selectedId) {
          setSelectedId(null);
          return;
        }
        if (tool === "picker") {
          setTool("select");
          return;
        }
        // Busy means a capture action is in flight; cancelling underneath it
        // would tear the session down while Rust is still encoding.
        if (busy) return;
        void cancel();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !busy) {
        e.preventDefault();
        setShapes((prev) => prev.filter((s) => s.id !== selectedId));
        setSelectedId(null);
        return;
      }
      if (e.key === "Enter" && box && !busy) {
        e.preventDefault();
        void confirm("copy");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setShapes((prev) => prev.slice(0, -1));
        // The popped shape may be the selected one; a dangling id would draw
        // an outline around nothing.
        setSelectedId(null);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (box) void confirm("save");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        if (box) void confirm("copy");
        return;
      }
      if (tool === "picker") {
        // Shift cycles the loupe's notation: HEX → RGB → HSL. Same key
        // Snipaste uses to flip between RGB and HEX under its magnifier.
        if (e.key === "Shift") {
          setPickerFmt((f) =>
            PICKER_FMTS[(PICKER_FMTS.indexOf(f) + 1) % PICKER_FMTS.length],
          );
          return;
        }
        // Q (or C, Snipaste's key) copies what the loupe shows without a
        // click. The Cmd/Ctrl combos returned earlier, so a bare key it is.
        const k = e.key.toLowerCase();
        if ((k === "q" || k === "c") && !e.metaKey && !e.ctrlKey && !e.altKey) {
          if (picker) {
            e.preventDefault();
            copyPicked(picker);
          }
          return;
        }
      }
      // T/F/J and R mirror the toolbar tooltips — they used to be advertised
      // but never wired, i.e. dead keys.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && box && !busy) {
        const k = e.key.toLowerCase();
        if (k === "t") {
          e.preventDefault();
          void runAi("extract");
          return;
        }
        if (k === "f") {
          e.preventDefault();
          void runAi("translate");
          return;
        }
        if (k === "j") {
          e.preventDefault();
          void runAi("explain");
          return;
        }
        if (k === "r") {
          e.preventDefault();
          void confirm("pin");
          return;
        }
        // C starts the long screenshot, mirroring the reference bar's
        // 长截图(C) affordance.
        if (k === "c") {
          e.preventDefault();
          void startScroll();
          return;
        }
      }
      const mapped = TOOL_KEYS[e.key];
      if (mapped && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setTool(mapped);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, busy, monitor, picker, pickerFmt, scrollMode, selectedId, shapes, tool]);

  /* --------------------------------------------------------------- shapes */

  const makeShape = (id: ToolId, from: Point, to: Point): Shape | null => {
    const base = { id: nextId(), color: style.color };
    const strokeWidth = strokeWidthOf(style);
    switch (id) {
      case "rect":
        // Reference default is a 10px corner radius, toggled by "圆角".
        return {
          ...base,
          kind: "rect",
          from,
          to,
          strokeWidth,
          filled: style.filled,
          radius: style.rounded ? 10 : 0,
        };
      case "ellipse":
        return { ...base, kind: "ellipse", from, to, strokeWidth, filled: style.filled };
      case "arrow":
        return {
          ...base,
          kind: "arrow",
          from,
          to,
          strokeWidth,
          head: style.arrowHead,
          dash: style.arrowDash,
        };
      case "pen":
        return { ...base, kind: "pen", points: [from], strokeWidth };
      case "mosaic":
        return {
          ...base,
          kind: "mosaic",
          from,
          to,
          // Freehand smears accumulate points; rectangle mode keeps the drag
          // rectangle and leaves the path empty.
          points: style.mosaicRect ? [] : [from],
          rectSelect: style.mosaicRect,
          block: mosaicBlockOf(style.mosaicPixel),
          mode: style.mosaicMode,
        };
      case "highlight":
        return {
          ...base,
          kind: "highlight",
          from,
          to,
          opacity: style.highlightOpacity,
          blur: style.highlightBlur,
          shape: style.highlightShape,
        };
      case "step": {
        // Reference: the badge number is the current counter, clamped at 99;
        // a 100th badge is silently dropped.
        if (style.stepNext > 99) return null;
        return {
          ...base,
          kind: "step",
          at: from,
          index: style.stepNext,
          radius: stepDiameterOf(style) / 2,
        };
      }
      default:
        return null;
    }
  };

  const updateShape = (shape: Shape, to: Point): Shape => {
    switch (shape.kind) {
      case "rect":
      case "ellipse":
      case "arrow":
      case "highlight":
        return { ...shape, to };
      case "mosaic":
        // Freehand mode paints along the pointer; rectangle mode drags a box.
        return shape.rectSelect
          ? { ...shape, to }
          : { ...shape, to, points: [...shape.points, to] };
      case "pen":
        return { ...shape, points: [...shape.points, to] };
      default:
        return shape;
    }
  };

  const isShapeUsable = (shape: Shape): boolean => {
    switch (shape.kind) {
      case "rect":
      case "ellipse":
      case "arrow":
      case "highlight": {
        const w = Math.abs(shape.to.x - shape.from.x);
        const h = Math.abs(shape.to.y - shape.from.y);
        return w >= 3 || h >= 3;
      }
      case "mosaic":
        // A freehand dab is a valid smear even without a drag distance.
        return shape.rectSelect
          ? Math.abs(shape.to.x - shape.from.x) >= 3 ||
              Math.abs(shape.to.y - shape.from.y) >= 3
          : shape.points.length > 1;
      case "pen":
        return shape.points.length > 1;
      default:
        return true;
    }
  };

  /** Close the inline editor; a non-empty value becomes (or updates) a text shape. */
  const commitText = (cancelled = false) => {
    const edit = textEdit;
    if (!edit) return;
    setTextEdit(null);
    const value = edit.value.trim();
    if (cancelled) return;

    if (edit.id) {
      // Re-edit: drop the shape when the text was cleared, otherwise replace
      // its content in place so its z-order and position survive.
      setShapes((prev) =>
        value
          ? prev.map((s) => (s.id === edit.id && s.kind === "text" ? { ...s, text: value } : s))
          : prev.filter((s) => s.id !== edit.id),
      );
      if (!value) setSelectedId(null);
      return;
    }
    if (!value) return;
    const id = nextId();
    setShapes((prev) => [
      ...prev,
      {
        id,
        color: style.color,
        kind: "text",
        at: edit.at,
        text: value,
        fontSize: textSizeOf(style),
      },
    ]);
    // Committed text lands in the select tool with the shape selected:
    // dragging moves it, Delete removes it, double-click edits it again.
    // Staying in the text tool made all three undiscoverable — a drag just
    // re-opened the editor and no delete path existed at all.
    setTool("select");
    setSelectedId(id);
  };

  // Focus lands in a rAF after mount: the mousedown default action (focusing
  // the stage) runs after the synchronous render, so an immediate focus()
  // loses and typing went to the canvas. Keyed on the editor's position so
  // it re-runs for a new editor, never mid-typing (which would re-select).
  useEffect(() => {
    if (!textEdit) return;
    const raf = requestAnimationFrame(() => {
      textInputRef.current?.focus();
      textInputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textEdit?.at.x, textEdit?.at.y]);

  // Report any error that reaches the window, so a canvas SecurityError is
  // visible in the terminal instead of silently blanking the UI.
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      void reportDebug("overlay-error", `${e.message} @ ${e.filename}:${e.lineno}`);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      void reportDebug("overlay-rejection", String(e.reason));
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  /** Read one pixel out of the cached frame copy. */
  const sampleAt = (p: Point): Rgb | null => {
    const sample = sampleRef.current;
    if (!sample || !monitor) return null;
    const ratio = sample.width / monitor.width;
    const px = Math.min(Math.max(Math.round(p.x * ratio), 0), sample.width - 1);
    const py = Math.min(Math.max(Math.round(p.y * ratio), 0), sample.height - 1);
    // `getImageData` throws SecurityError when the canvas is tainted (the frame
    // is served over the `asset:` scheme). This runs from the pointer handler,
    // so an uncaught throw bubbles out of the React tree and used to take the
    // whole capture UI down mid-gesture — the selection box "vanished" while
    // merely moving the mouse over the picture.
    let data: Uint8ClampedArray;
    try {
      const ctx = sample.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      data = ctx.getImageData(px, py, 1, 1).data;
    } catch (e) {
      // A tainted frame can never be sampled: drop it so the loupe stops trying
      // instead of throwing on every mouse move.
      sampleRef.current = null;
      void reportDebug("picker-sample-blocked", String(e));
      return null;
    }
    return { r: data[0], g: data[1], b: data[2] };
  };

  /** Copy the sampled colour in the notation the loupe currently shows. */
  const copyPicked = (seen: Rgb) => {
    const text = fmtColor(seen, pickerFmt);
    setToast(`已复制 ${text}`);
    void api.copyText(text).catch((e: unknown) => {
      void reportDebug("picker-copy-failed", String(e));
    });
  };

  const pickColor = (p: Point) => {
    const seen = sampleAt(p);
    // Reported through the debug channel so a terminal can confirm what the
    // webview actually did: without it a click that never reached the handler
    // and a click that failed to sample look identical from the outside.
    void reportDebug("picker-pick", {
      x: Math.round(p.x),
      y: Math.round(p.y),
      sampled: seen ? toHex(seen) : null,
    });
    if (!seen) return;
    // Picking a colour also arms it as the drawing colour (the app's existing
    // behaviour, kept deliberately — the reference only copies the value).
    patchStyle({ color: toHex(seen) });
    copyPicked(seen);
  };

  /* --------------------------------------------------------------- output */

  /** Flatten annotations into a transparent PNG sized like the selection. */
  const renderOverlay = (): string | null => {
    const layer = annotationLayerRef.current;
    if (!layer || !box) return null;

    const ratio = window.devicePixelRatio || 1;
    const dataUrl = layer.toDataURL({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      pixelRatio: ratio,
      mimeType: "image/png",
    });
    return hasDrawableContent() ? dataUrl : null;
  };

  const hasDrawableContent = () => shapes.length > 0 || draft !== null;

  const confirm = async (action: CaptureAction) => {
    if (!box || !monitor || busy) return;
    if (!isUsableSelection(box)) {
      setToast("请先拖出一个选区");
      return;
    }
    setBusy(true);
    try {
      let savePath: string | null = null;
      if (action === "save") {
        // The reference tool saves through the native dialog; cancelling it
        // cancels the whole capture (nothing is written anywhere).
        const stamp = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const name = `xw_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(
          stamp.getDate(),
        )}${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;
        const picked = await api.saveAsDialog(name);
        if (picked === null) {
          await api.cancelCapture();
          reset();
          return;
        }
        savePath = picked;
      }
      const overlay = renderOverlay();
      const result = await api.confirmCapture(monitor.id, box, action, overlay, savePath);
      if (result.message) setToast(result.message);

      // Pin's window is opened Rust-side inside confirm_capture now; the old
      // follow-up pinCrop invoke raced this overlay's destruction and lost.
      await getCurrentWindow().hide();
      reset();
    } catch (e) {
      setToast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /** Last time an AI action fired, for the reference tool's 500ms debounce. */
  const lastAiAt = useRef(0);

  const runAi = async (action: AiAction) => {
    if (!box || !monitor || busy) return;
    // The reference bar throttles each AI button to one request per 500ms;
    // double-clicks used to fire two crops here.
    const now = Date.now();
    if (now - lastAiAt.current < 500) return;
    lastAiAt.current = now;
    setBusy(true);
    try {
      const overlay = renderOverlay();
      // One invoke does everything: Rust crops (no clipboard write, no
      // auto-save), opens the chat window bound to `action`, then tears this
      // overlay down. There is deliberately no code after this call — this
      // webview is destroyed inside the command, so a follow-up invoke (the
      // old openChat/hide sequence) would never fire and the chat window
      // never appeared.
      await api.confirmCapture(monitor.id, box, "ask", overlay, null, action);
    } catch (e) {
      setToast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    // A capture action may be mid-flight; tearing the session down under it
    // leaves Rust writing into a closed session.
    if (busy) return;
    reset();
    try {
      await api.cancelCapture();
    } catch {
      /* closing anyway */
    }
  };

  /* ------------------------------------------------------- scroll capture */

  /** Leave scroll mode and return to a fresh capture surface. */
  const exitScrollMode = useCallback(() => {
    scrollModeRef.current = null;
    setScrollMode(null);
    setScrollPreview(null);
    setScrollTip(null);
    previewCache.current.clear();
    reset();
  }, []);

  /** Begin the long screenshot on the current selection (toolbar C). */
  const startScroll = useCallback(async () => {
    if (!box || !monitor || busy || scrollMode) return;
    if (!isUsableSelection(box)) {
      setToast("请先拖出一个选区");
      return;
    }
    const anchor = box;
    setBusy(true);
    try {
      // The overlay hides its chrome first (render below reads scrollMode),
      // then Rust captures the live region behind it.
      const status = await api.scrollStart(monitor.id, anchor);
      if (!status.sessionId) throw new Error("长截图启动失败");
      scrollModeRef.current = status.sessionId;
      setScrollMode({ sessionId: status.sessionId, anchor, phase: status.phase });
      if (status.note) setToast(status.note);
    } catch (e) {
      setToast(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [box, busy, monitor, scrollMode]);

  /** Finish/cancel from the control bar or Escape. */
  const stopScroll = useCallback(
    async (action: "save" | "copy" | "cancel") => {
      try {
        const done = await api.scrollStop(action);
        // The `scroll://done` listener performs the UI teardown; a null result
        // (no session) still unwinds the local mode.
        if (!done) exitScrollMode();
      } catch (e) {
        setToast(errorText(e));
        exitScrollMode();
      }
    },
    [exitScrollMode],
  );

  /**
   * Decode the preview image and place it beside the selection using the
   * reference's decoded algorithm (right -> left -> above -> below ->
   * overlap), with V-aspect fit (maxW 360 / minW 240 / maxH 520, gap 10,
   * edge 20).
   */
  const placePreview = useCallback(
    async (p: ScrollPreview) => {
      const anchor = scrollMode?.anchor;
      if (!anchor) return;
      const base = convertFileSrc(p.path);
      const url = base + "?timestamp=" + Date.now();

      const load = (): Promise<HTMLImageElement> => {
        const cached = previewCache.current.get(base);
        if (cached) return Promise.resolve(cached);
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            previewCache.current.set(base, img);
            resolve(img);
          };
          img.onerror = reject;
          img.src = base;
        });
      };

      try {
        const img = await load();
        // The decode is async: the session may have finished (and the mode
        // exited) while it ran. A stale decode must not resurrect the preview.
        if (!scrollModeRef.current) return;
        const aspect = img.naturalWidth / img.naturalHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const MAX_W = 360;
        const MIN_W = 240;
        const MAX_H = 520;
        const GAP = 10;
        const EDGE = 20;

        // V(l, a, maxW, maxH, minW): the reference's aspect-fit helper.
        const fit = (w: number, maxH: number): { width: number; height: number } => {
          let width = w;
          let height = width / aspect;
          if (height > maxH) {
            height = maxH;
            width = height * aspect;
          }
          if (width < MIN_W) {
            width = MIN_W;
            height = width / aspect;
            if (height > maxH) {
              height = maxH;
              width = height * aspect;
            }
          }
          return { width, height };
        };

        const baseFit = fit(MAX_W, MAX_H);
        // Side placements cap the height so the thumbnail's bottom stays near
        // the selection's bottom (the reference `g` helper).
        const sideMaxH = Math.min(MAX_H, Math.max(anchor.y + anchor.height - EDGE, MIN_W / aspect));
        const sideFit = fit(baseFit.width, sideMaxH);
        const bottomOf = (h: number) => Math.max(anchor.y + anchor.height - h, EDGE);

        let placed: { x: number; y: number; width: number; height: number };
        if (vw - (anchor.x + anchor.width) >= MAX_W + GAP) {
          placed = { ...sideFit, x: anchor.x + anchor.width + GAP, y: bottomOf(sideFit.height) };
        } else if (anchor.x >= MAX_W + GAP) {
          placed = { ...sideFit, x: anchor.x - sideFit.width - GAP, y: bottomOf(sideFit.height) };
        } else if (anchor.y >= MAX_H + GAP) {
          const h = Math.min(MAX_H, anchor.y - GAP);
          const size = fit(Math.min(MAX_W, anchor.width), h);
          placed = { ...size, x: anchor.x, y: Math.max(EDGE, anchor.y - size.height - GAP) };
        } else if (vh - (anchor.y + anchor.height) >= MAX_H + GAP) {
          const h = Math.min(MAX_H, vh - (anchor.y + anchor.height) - GAP);
          const size = fit(Math.min(MAX_W, anchor.width), h);
          placed = { ...size, x: anchor.x, y: anchor.y + anchor.height + GAP };
        } else {
          // Overlap fallback: inside the selection's own area.
          const maxH = Math.min(MAX_H, anchor.height * 0.65);
          const size = fit(Math.min(MAX_W, Math.max(MIN_W, anchor.width - 40)), maxH);
          placed = { ...size, x: anchor.x + GAP, y: anchor.y + GAP };
        }

        setScrollPreview({ url, ...placed });
      } catch {
        // A failed decode (mid atomic-replace) keeps the last preview.
      }
    },
    // Anchor identity: recompute only when the selection moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scrollMode?.anchor?.x, scrollMode?.anchor?.y, scrollMode?.anchor?.width, scrollMode?.anchor?.height],
  );

  /** Rust event wiring for the scroll session. */
  useEffect(() => {
    if (!scrollMode) return;
    const sessionId = scrollMode.sessionId;
    const unlisteners: Array<Promise<() => void>> = [];

    unlisteners.push(
      events.onScrollState((st) => {
        if (st.sessionId !== sessionId) return;
        setScrollMode((prev) => (prev ? { ...prev, phase: st.phase } : prev));
        if (st.phase === "finished" || st.phase === "failed") {
          setScrollTip({ kind: "bottom", text: st.note ?? "已完成" });
        }
      }),
    );

    unlisteners.push(
      events.onScrollPreview((p) => {
        if (p.sessionId !== sessionId) return;
        void placePreview(p);
      }),
    );

    unlisteners.push(
      events.onScrollTip((t) => {
        if (t.sessionId !== sessionId) return;
        setScrollTip(t);
        // Tips are transient in the reference; error tips persist longer.
        const ms = t.kind === "error" ? 6000 : 3000;
        window.setTimeout(() => setScrollTip((cur) => (cur === t ? null : cur)), ms);
      }),
    );

    unlisteners.push(
      events.onScrollDone((d) => {
        if (d.sessionId !== sessionId) return;
        if (d.message) setToast(d.message);
        exitScrollMode();
      }),
    );

    return () => {
      for (const pr of unlisteners) pr.then((u) => u()).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollMode?.sessionId, exitScrollMode, placePreview]);

  const reset = () => {
    setBox(null);
    setShapes([]);
    setDraft(null);
    setMenu(null);
    setSelectedId(null);
    setHoverWin(null);
  };

  /* ----------------------------------------------------------------- view */

  // The eyedropper gets its own pipette cursor. Every other tool leaves this
  // undefined so the per-move `document.body` cursor set from `onMouseMove`
  // (resize arrows, crosshair) is not overridden by an inline root value.
  const cursor = tool === "picker" ? PICKER_CURSOR : undefined;

  // Scroll-capture mode: all overlay chrome disappears so the live page shows
  // through the (Rust-side click-through) window; only the reference-style
  // hint, the live preview thumbnail and transient tips remain.
  const inScroll = scrollMode !== null;

  // Bounds of the grabbed annotation, for the dashed outline (null = none).
  const selectedShape =
    selectedId !== null ? shapes.find((s) => s.id === selectedId) ?? null : null;
  const selectedOutline = selectedShape ? shapeBounds(selectedShape) : null;

  return (
    <div className="overlay-root" style={{ cursor }} onContextMenu={(e) => e.preventDefault()}>
      {!inScroll && (
        <div
          className="overlay-stage-host"
          style={{
            width: stageSize.w,
            height: stageSize.h,
            backgroundImage: frameSrc ? `url(${frameSrc})` : undefined,
          }}
        />
      )}
      {!inScroll && (
      <Stage
        ref={stageRef}
        width={stageSize.w}
        height={stageSize.h}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onDblClick={onDblClick}
        onWheel={onWheel}
      >
        {/* Layer 0: annotations only. The frozen desktop is a DOM <img>
            underneath the stage, so `toDataURL` on this layer yields a
            transparent annotation PNG with no screenshot baked in.
            `annotationLayerRef` is what export uses — keep it on this layer if
            more layers are ever added. */}
        <Layer ref={annotationLayerRef}>
          {shapes.map((s) => (
            <ShapeNode key={s.id} shape={s} source={sourceRef.current} />
          ))}
          {draft && <ShapeNode shape={draft} source={sourceRef.current} />}
        </Layer>
      </Stage>
      )}

      {/* The desktop image, the dimmer and the selection chrome live in DOM so
          they never end up in the exported annotation layer. */}
      {!inScroll && frameSrc && (
        <img className="overlay-frame" src={frameSrc} alt="" draggable={false} />
      )}
      {!inScroll && (
      <div
        className="overlay-dim"
        style={
          box
            ? {
                clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0,
                  ${box.x}px ${box.y}px, ${box.x}px ${box.y + box.height}px,
                  ${box.x + box.width}px ${box.y + box.height}px,
                  ${box.x + box.width}px ${box.y}px, ${box.x}px ${box.y}px)`,
              }
            : undefined
        }
      />
      )}
      {!inScroll && !box && tool === "select" && !drag.current && hoverWin && (
        <div
          className="overlay-win-hint"
          style={{
            left: hoverWin.x,
            top: hoverWin.y,
            width: hoverWin.width,
            height: hoverWin.height,
          }}
        >
          <span className="overlay-win-label">
            {hoverWin.owner || "窗口"}
            {hoverWin.title ? ` · ${hoverWin.title}` : ""}
          </span>
        </div>
      )}

      {/* Selection outline around the grabbed annotation: drag moves it,
          Delete removes it, double-click re-edits text. */}
      {!inScroll && selectedOutline && (
        <div
          className="overlay-shape-sel"
          style={{
            left: selectedOutline.x,
            top: selectedOutline.y,
            width: selectedOutline.width,
            height: selectedOutline.height,
          }}
        />
      )}

      {!inScroll && box && (
        <>
          <div
            className="overlay-box"
            style={{
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
            }}
          />
          {tool === "select" &&
            HANDPOS.map(({ handle, dx, dy }) => (
              <div
                key={handle}
                className={`overlay-handle h-${handle}`}
                style={{
                  left: box.x + box.width * dx,
                  top: box.y + box.height * dy,
                }}
              />
            ))}
          <div
            className="overlay-size"
            style={{
              left: box.x,
              top: Math.max(0, box.y - 26),
            }}
          >
            {formatSize(box, monitor?.scaleFactor ?? 1)}
          </div>
        </>
      )}

      {monitor && !inScroll && (
        <Toolbar
          box={box}
          tool={tool}
          style={style}
          canUndo={shapes.length > 0}
          busy={busy}
          onTool={(t) => {
            setTool(t);
            setSelectedId(null);
          }}
          onStyle={patchStyle}
          onUndo={() => {
            setShapes((prev) => prev.slice(0, -1));
            setSelectedId(null);
          }}
          onAction={(a: ToolbarAction) => {
            if (a === "cancel") void cancel();
            else if (a === "scroll") void startScroll();
            else if (a === "extract" || a === "translate" || a === "explain" || a === "ask")
              void runAi(a);
            else void confirm(a);
          }}
        />
      )}

      {inScroll && scrollMode && (
        <div
          className="scroll-overlay"
          style={{
            left: scrollMode.anchor.x,
            top: scrollMode.anchor.y,
            width: scrollMode.anchor.width,
            height: scrollMode.anchor.height,
          }}
        >
          {scrollMode.phase === "recording" && !scrollTip && (
            <div className="scroll-hint">截图过程中请不要手动滚动</div>
          )}
          {scrollTip && (
            <div className={"scroll-tip " + scrollTip.kind}>{scrollTip.text}</div>
          )}
        </div>
      )}

      {scrollPreview && (
        <img
          className="scroll-preview"
          src={scrollPreview.url}
          alt=""
          draggable={false}
          style={{
            left: scrollPreview.x,
            top: scrollPreview.y,
            width: scrollPreview.width,
            height: scrollPreview.height,
          }}
        />
      )}

      {picker !== null && (tool === "picker" || (tool === "select" && !box)) && (
        <div
          className="picker-hud"
          style={{
            left: Math.min(picker.x + 20, stageSize.w - 170),
            top:
              picker.y + 20 + 200 > stageSize.h
                ? Math.max(8, picker.y - 200)
                : picker.y + 20,
          }}
        >
          <canvas
            ref={pickerCanvasRef}
            className="picker-zoom"
            width={135}
            height={135}
          />
          <div className="picker-meta">
            <span className="picker-swatch" style={{ background: toHex(picker) }} />
            <div className="picker-values">
              <code className="picker-hex">{fmtColor(picker, pickerFmt)}</code>
              <span className="picker-rgb">
                {fmtColor(picker, pickerFmt === "hex" ? "rgb" : "hex")}
              </span>
            </div>
          </div>
          <div className="picker-hint">
            {tool === "picker" ? "Shift 换格式 · 点击/Q 复制" : "拖拽框选 · 点击选中窗口"}
          </div>
        </div>
      )}

      {textEdit && (
        <textarea
          ref={textInputRef}
          className="overlay-text-input"
          style={{
            left: textEdit.at.x,
            top: textEdit.at.y,
            // A re-edited shape keeps its own colour/size; a new one follows
            // the current toolbar parameters.
            color: textEdit.style?.color ?? style.color,
            fontSize: textSizeOf(textEdit.style ?? style),
          }}
          value={textEdit.value}
          autoFocus
          rows={1}
          spellCheck={false}
          placeholder="输入文字"
          onChange={(e) => {
            setTextEdit({ ...textEdit, value: e.target.value });
            // Grow with the text; a fixed rows=1 would clip anything past
            // the first line.
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onBlur={() => commitText()}
          onKeyDown={(e) => {
            // The window-level shortcut handler must not see editor keys.
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitText();
            } else if (e.key === "Escape") {
              e.preventDefault();
              commitText(true);
            }
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}

      {menu && box && (
        <div className="overlay-menu" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => void confirm("copy")}>复制</button>
          <button onClick={() => void confirm("save")}>保存…</button>
          <button onClick={() => void confirm("pin")}>贴图</button>
          <span className="sep" />
          <button onClick={() => void runAi("extract")}>提取文字</button>
          <button onClick={() => void runAi("translate")}>翻译</button>
          <button onClick={() => void runAi("explain")}>解释</button>
          <span className="sep" />
          <button onClick={() => void cancel()}>取消</button>
        </div>
      )}

      {toast && (
        <div
          className="overlay-toast"
          // The element runs toast-in first; only its exit animation should
          // clear the text, or the toast would vanish the moment it appeared.
          onAnimationEnd={(e) => {
            if (e.animationName === "toast-out") setToast(null);
          }}
        >
          {toast}
        </div>
      )}

      {!monitor && !inScroll && <div className="overlay-loading">正在抓取屏幕…</div>}
    </div>
  );
}

const HANDPOS: Array<{ handle: string; dx: number; dy: number }> = [
  { handle: "nw", dx: 0, dy: 0 },
  { handle: "n", dx: 0.5, dy: 0 },
  { handle: "ne", dx: 1, dy: 0 },
  { handle: "e", dx: 1, dy: 0.5 },
  { handle: "se", dx: 1, dy: 1 },
  { handle: "s", dx: 0.5, dy: 1 },
  { handle: "sw", dx: 0, dy: 1 },
  { handle: "w", dx: 0, dy: 0.5 },
];

type Rgb = { r: number; g: number; b: number };

/** Notations the loupe can show; Shift cycles through them in this order. */
type PickerFmt = "hex" | "rgb" | "hsl";
const PICKER_FMTS: PickerFmt[] = ["hex", "rgb", "hsl"];

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Render the sample for display and the clipboard; hex is uppercased. */
function fmtColor(c: Rgb, fmt: PickerFmt): string {
  switch (fmt) {
    case "hex":
      return toHex(c).toUpperCase();
    case "rgb":
      return `rgb(${c.r} ${c.g} ${c.b})`;
    case "hsl": {
      const { h, s, l } = rgbToHsl(c);
      return `hsl(${h} ${s}% ${l}%)`;
    }
  }
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = Math.round(((max + min) / 2) * 100);
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = Math.round((l > 50 ? d / (2 - max - min) : d / (max + min)) * 100);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: Math.round(h * 360), s, l };
}

/** Eyedropper cursor used while the picker tool is active.
 *
 * The pipette glyph points down-left, so its tip is the hotspot at (2, 20)
 * inside the 22px cursor box: the sampled pixel sits exactly under the tip.
 *
 * Inlined as a base64 data URL because CSS `url()` cannot carry the quotes an
 * inline SVG needs, and the picker must work without fetching an asset.
 */
const PICKER_CURSOR =
  'url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMiIgaGVpZ2h0PSIyMiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48ZyBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iNC4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Im0yIDIyIDEtMWgzbDktOSIvPjxwYXRoIGQ9Ik0zIDIxdi0zbDktOSIvPjxwYXRoIGQ9Im0xNSA2IDMuNC0zLjRhMi4xIDIuMSAwIDEgMSAzIDNMMTggOWwuNC40YTIuMSAyLjEgMCAxIDEtMyAzbC0zLjgtMy44YTIuMSAyLjEgMCAxIDEgMy0zbC40LjRaIi8+PC9nPjxnIHN0cm9rZT0iIzE1MTYxYSIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Im0yIDIyIDEtMWgzbDktOSIvPjxwYXRoIGQ9Ik0zIDIxdi0zbDktOSIvPjxwYXRoIGQ9Im0xNSA2IDMuNC0zLjRhMi4xIDIuMSAwIDEgMSAzIDNMMTggOWwuNC40YTIuMSAyLjEgMCAxIDEtMyAzbC0zLjgtMy44YTIuMSAyLjEgMCAxIDEgMy0zbC40LjRaIi8+PC9nPjwvc3ZnPg==") 2 20, crosshair';

/** Send a diagnostic line to the Rust log (compiled out of release builds). */
function reportDebug(stage: string, detail: unknown) {
  void import("@tauri-apps/api/core")
    .then((m) =>
      m.invoke("debug_report", {
        stage,
        detail: typeof detail === "string" ? detail : JSON.stringify(detail),
      }),
    )
    .catch(() => undefined);
}

function setCursor(cursor: string) {
  document.body.style.cursor = cursor;
}

/** Shared 2D context for measuring text bounds on hit-testing. */
let measureCtx: CanvasRenderingContext2D | null = null;

function textFontSize(shape: Extract<Shape, { kind: "text" }>): number {
  return shape.fontSize;
}

/** Bounds of a committed shape, generous by a few px for grabbing. */
function shapeBounds(shape: Shape): Box {
  const pad = 4;
  switch (shape.kind) {
    case "rect":
    case "ellipse":
    case "highlight": {
      const x = Math.min(shape.from.x, shape.to.x) - pad;
      const y = Math.min(shape.from.y, shape.to.y) - pad;
      return {
        x,
        y,
        width: Math.abs(shape.to.x - shape.from.x) + pad * 2,
        height: Math.abs(shape.to.y - shape.from.y) + pad * 2,
      };
    }
    case "mosaic": {
      // A freehand smear has no drag rectangle; measure the painted path.
      if (!shape.rectSelect && shape.points.length > 0) {
        const xs = shape.points.map((q) => q.x);
        const ys = shape.points.map((q) => q.y);
        const half = shape.block / 2 + pad;
        return {
          x: Math.min(...xs) - half,
          y: Math.min(...ys) - half,
          width: Math.max(...xs) - Math.min(...xs) + half * 2,
          height: Math.max(...ys) - Math.min(...ys) + half * 2,
        };
      }
      const x = Math.min(shape.from.x, shape.to.x) - pad;
      const y = Math.min(shape.from.y, shape.to.y) - pad;
      return {
        x,
        y,
        width: Math.abs(shape.to.x - shape.from.x) + pad * 2,
        height: Math.abs(shape.to.y - shape.from.y) + pad * 2,
      };
    }
    case "arrow": {
      const x = Math.min(shape.from.x, shape.to.x) - pad;
      const y = Math.min(shape.from.y, shape.to.y) - pad;
      return {
        x,
        y,
        width: Math.abs(shape.to.x - shape.from.x) + pad * 2,
        height: Math.abs(shape.to.y - shape.from.y) + pad * 2,
      };
    }
    case "pen": {
      const xs = shape.points.map((q) => q.x);
      const ys = shape.points.map((q) => q.y);
      const w = shape.strokeWidth;
      return {
        x: Math.min(...xs) - w - pad,
        y: Math.min(...ys) - w - pad,
        width: Math.max(...xs) - Math.min(...xs) + (w + pad) * 2,
        height: Math.max(...ys) - Math.min(...ys) + (w + pad) * 2,
      };
    }
    case "text": {
      const size = textFontSize(shape);
      measureCtx ??= document.createElement("canvas").getContext("2d");
      let width = shape.text.length * size;
      if (measureCtx) {
        measureCtx.font = `600 ${size}px "Heiti SC", "PingFang SC", sans-serif`;
        width = Math.max(
          ...shape.text.split("\n").map((line) => measureCtx!.measureText(line).width),
          0,
        );
      }
      const lines = shape.text.split("\n").length;
      return {
        x: shape.at.x - pad,
        y: shape.at.y - pad,
        width: width + pad * 2,
        height: lines * size * 1.35 + pad * 2,
      };
    }
    case "step": {
      const r = shape.radius + pad;
      return { x: shape.at.x - r, y: shape.at.y - r, width: r * 2, height: r * 2 };
    }
  }
}

/** Topmost committed shape under the point, if any. */
function hitShape(shapes: Shape[], p: Point): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const b = shapeBounds(shapes[i]);
    if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) {
      return shapes[i];
    }
  }
  return null;
}

/** Topmost text shape under the point; double-click edits it. */
function textShapeAt(shapes: Shape[], p: Point): Extract<Shape, { kind: "text" }> | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.kind !== "text") continue;
    const b = shapeBounds(s);
    if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) {
      return s;
    }
  }
  return null;
}

/** Preset index for an arbitrary font size (shapes keep exact px, not an index). */
function sizeIndex(fontSize: number): number {
  let best = 0;
  for (let i = 0; i < TEXT_SIZES.length; i++) {
    if (Math.abs(TEXT_SIZES[i] - fontSize) < Math.abs(TEXT_SIZES[best] - fontSize)) best = i;
  }
  return best;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Resize an existing box by dragging one handle. */
function resizeBox(origin: Box, handle: Exclude<Handle, null | "move">, p: Point, w: number, h: number): Box {
  let { x, y, width, height } = origin;
  const right = x + width;
  const bottom = y + height;

  if (handle.includes("w")) {
    x = Math.min(p.x, right - MIN_SELECTION);
    width = right - x;
  }
  if (handle.includes("e")) {
    width = Math.max(MIN_SELECTION, p.x - x);
  }
  if (handle.includes("n")) {
    y = Math.min(p.y, bottom - MIN_SELECTION);
    height = bottom - y;
  }
  if (handle.includes("s")) {
    height = Math.max(MIN_SELECTION, p.y - y);
  }

  return clampBox({ x, y, width, height }, w, h, MIN_SELECTION);
}
