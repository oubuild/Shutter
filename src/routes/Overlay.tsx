/** The screenshot overlay: frozen desktop + selection + annotation canvas. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Layer, Stage } from "react-konva";
import Konva from "konva";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Toolbar, type ToolbarAction } from "../components/Toolbar";
import { ShapeNode } from "../canvas/ShapeNode";
import {
  TOOL_KEYS,
  nextId,
  nextStepIndex,
  type Point,
  type Shape,
  type ToolId,
} from "../canvas/model";
import {
  api,
  errorText,
  type AiAction,
  type CaptureAction,
  type MonitorInfo,
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
  | { mode: "draw"; start: Point };

/** Reference default: the same red the original tool draws with. */
const DEFAULT_COLOR = "#F22B24";

export function Overlay({ monitorId }: Props) {
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null);
  const [, setSessionId] = useState<string | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);

  const [box, setBox] = useState<Box | null>(null);
  const [tool, setTool] = useState<ToolId>("select");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [filled, setFilled] = useState(false);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [menu, setMenu] = useState<Point | null>(null);
  /** Inline text editor: open at the click point while the text tool is used. */
  const [textEdit, setTextEdit] = useState<{ at: Point; value: string } | null>(null);

  const drag = useRef<Drag | null>(null);
  const stageRef = useRef<Konva.Stage>(null);
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
      if (box && tool === "select") {
        const handle = hitHandle(box, p);
        if (handle === "move") {
          drag.current = { mode: "move", grab: p, origin: box };
          return;
        }
        if (handle) {
          drag.current = { mode: "resize", handle, origin: box };
          return;
        }
      }

      if (tool === "select") {
        drag.current = { mode: "select", start: p };
        setBox({ x: p.x, y: p.y, width: 0, height: 0 });
        setShapes([]);
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
        setTextEdit({ at: p, value: "" });
        return;
      }
      if (!box) return;
      drag.current = { mode: "draw", start: p };
      setDraft(makeShape(tool, p, p));
    },
    // makeShape reads color/strokeWidth/filled/shapes — they must be listed or
    // the callback keeps the values from the render it was last rebuilt on and
    // new shapes get stale styles (and a frozen step counter).
    [box, busy, color, filled, pickerFmt, pos, shapes, strokeWidth, tool],
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
      (d.mode === "select" || d.mode === "move" || d.mode === "resize"
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
      if (box && tool === "select") {
        const cursor = cursorFor(hitHandle(box, p));
        setCursor(cursor);
      } else {
        setCursor("crosshair");
      }
      return;
    }

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
    }
  }, [box, draft, pos, stageSize.h, stageSize.w, tool]);

  // Diagnostic: the eyedropper UI vanished right after being selected, so record
  // every tool transition together with the selection state that gates the
  // toolbar. Compiled out of release builds (debug_report is a no-op there).
  useEffect(() => {
    void reportDebug("tool-change", { tool, box: box ? `${box.width}x${box.height}` : null });
  }, [tool, box]);

  // The loupe only exists while the eyedropper is active.
  useEffect(() => {
    if (tool !== "picker") setPicker(null);
  }, [tool]);

  // Paint the magnifier: a 15x15 pixel window from the frozen frame, drawn
  // nearest-neighbour so every source pixel is a crisp square, with the picked
  // pixel ringed in the middle. Backing store and CSS size equal the HUD's
  // inner width (15*9=135): a non-integer upscale left edge rows unpainted,
  // and a canvas narrower than the panel left a dead strip beside it.
  useEffect(() => {
    if (!picker || tool !== "picker") return;
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
  }, [picker, tool, monitor]);

  const onMouseUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;

    if (d.mode === "select") {
      if (box && !isUsableSelection(box)) setBox(null);
      return;
    }
    if (d.mode === "draw" && draft) {
      if (isShapeUsable(draft)) setShapes((prev) => [...prev, draft]);
      setDraft(null);
    }
  }, [box, draft]);

  const onDblClick = useCallback(() => {
    if (box) confirm("copy");
  }, [box]);

  /* ------------------------------------------------------------ shortcuts */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys typed into the inline text editor belong to the editor, not to
      // the global shortcuts (digits would switch tools mid-sentence).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Leave the eyedropper first; a second Esc cancels the capture.
        // Without this, exiting the picker also threw away the selection.
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
      if (e.key === "Enter" && box && !busy) {
        e.preventDefault();
        void confirm("copy");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setShapes((prev) => prev.slice(0, -1));
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
      }
      const mapped = TOOL_KEYS[e.key];
      if (mapped && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setTool(mapped);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, busy, monitor, picker, pickerFmt, shapes, tool]);

  /* --------------------------------------------------------------- shapes */

  const makeShape = (id: ToolId, from: Point, to: Point): Shape | null => {
    const base = { id: nextId(), color };
    switch (id) {
      case "rect":
        return { ...base, kind: "rect", from, to, strokeWidth, filled, radius: 0 };
      case "ellipse":
        return { ...base, kind: "ellipse", from, to, strokeWidth, filled };
      case "arrow":
        return { ...base, kind: "arrow", from, to, strokeWidth };
      case "pen":
        return { ...base, kind: "pen", points: [from], strokeWidth };
      case "mosaic":
        return { ...base, kind: "mosaic", from, to, block: 12 };
      case "highlight":
        return { ...base, kind: "highlight", from, to };
      case "step":
        return {
          ...base,
          kind: "step",
          at: from,
          index: nextStepIndex(shapes),
          radius: 12,
        };
      default:
        return null;
    }
  };

  const updateShape = (shape: Shape, to: Point): Shape => {
    switch (shape.kind) {
      case "rect":
      case "ellipse":
      case "arrow":
      case "mosaic":
      case "highlight":
        return { ...shape, to };
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
      case "mosaic":
      case "highlight": {
        const w = Math.abs(shape.to.x - shape.from.x);
        const h = Math.abs(shape.to.y - shape.from.y);
        return w >= 3 || h >= 3;
      }
      case "pen":
        return shape.points.length > 1;
      default:
        return true;
    }
  };

  /** Close the inline editor; a non-empty value becomes a text shape. */
  const commitText = (cancelled = false) => {
    const edit = textEdit;
    if (!edit) return;
    setTextEdit(null);
    const value = edit.value.trim();
    if (cancelled || !value) return;
    setShapes((prev) => [
      ...prev,
      { id: nextId(), color, kind: "text", at: edit.at, text: value, fontSize: 18 },
    ]);
  };

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
    setColor(toHex(seen));
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

      if (action === "pin") {
        await api.pinCrop(result.cropId);
        await getCurrentWindow().hide();
      } else {
        await getCurrentWindow().hide();
      }
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
      // "ask" crops for the chat window only: no clipboard write, no gallery
      // auto-save, exactly like the reference's AI path.
      const result = await api.confirmCapture(monitor.id, box, "ask", overlay);
      // The chat window owns the streaming UI; hand it the crop and the action
      // so it can start the request without another click.
      await api.openChat(result.cropId, action);
      await getCurrentWindow().hide();
      reset();
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

  const reset = () => {
    setBox(null);
    setShapes([]);
    setDraft(null);
    setMenu(null);
  };

  /* ----------------------------------------------------------------- view */

  // The eyedropper gets its own pipette cursor. Every other tool leaves this
  // undefined so the per-move `document.body` cursor set from `onMouseMove`
  // (resize arrows, crosshair) is not overridden by an inline root value.
  const cursor = tool === "picker" ? PICKER_CURSOR : undefined;

  return (
    <div className="overlay-root" style={{ cursor }} onContextMenu={(e) => e.preventDefault()}>
      <div
        className="overlay-stage-host"
        style={{
          width: stageSize.w,
          height: stageSize.h,
          backgroundImage: frameSrc ? `url(${frameSrc})` : undefined,
        }}
      />
      <Stage
        ref={stageRef}
        width={stageSize.w}
        height={stageSize.h}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onDblClick={onDblClick}
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

      {/* The desktop image, the dimmer and the selection chrome live in DOM so
          they never end up in the exported annotation layer. */}
      {frameSrc && (
        <img className="overlay-frame" src={frameSrc} alt="" draggable={false} />
      )}
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
      {box && (
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

      {monitor && (
        <Toolbar
          box={box}
          tool={tool}
          color={color}
          strokeWidth={strokeWidth}
          filled={filled}
          canUndo={shapes.length > 0}
          busy={busy}
          onTool={setTool}
          onColor={setColor}
          onStrokeWidth={setStrokeWidth}
          onFilled={setFilled}
          onUndo={() => setShapes((prev) => prev.slice(0, -1))}
          onAction={(a: ToolbarAction) => {
            if (a === "cancel") void cancel();
            else if (a === "extract" || a === "translate" || a === "explain" || a === "ask")
              void runAi(a);
            else void confirm(a);
          }}
        />
      )}

      {tool === "picker" && picker && (
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
          <div className="picker-hint">Shift 换格式 · 点击/Q 复制</div>
        </div>
      )}

      {textEdit && (
        <textarea
          className="overlay-text-input"
          style={{ left: textEdit.at.x, top: textEdit.at.y, color }}
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

      {!monitor && <div className="overlay-loading">正在抓取屏幕…</div>}
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
