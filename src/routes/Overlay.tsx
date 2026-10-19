/** The screenshot overlay: frozen desktop + selection + annotation canvas. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Layer, Stage } from "react-konva";
import Konva from "konva";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Toolbar } from "../components/Toolbar";
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

const DEFAULT_COLOR = "#ef4444";

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

  const drag = useRef<Drag | null>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const sourceRef = useRef<HTMLImageElement | null>(null);

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
        img.src = src;
        await img.decode().catch(() => undefined);
        sourceRef.current = img;
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

      if (box) {
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

      if (!box) return;
      if (tool === "picker") {
        pickColor(p);
        return;
      }
      drag.current = { mode: "draw", start: p };
      setDraft(makeShape(tool, p, p));
    },
    // pickColor / makeShape are stable enough through refs below
    [box, busy, pos, tool],
  );

  const onMouseMove = useCallback(() => {
    const p = pos();
    const d = drag.current;
    if (!d) {
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
      if (e.key === "Escape") {
        e.preventDefault();
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
      const mapped = TOOL_KEYS[e.key];
      if (mapped && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setTool(mapped);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, busy, shapes]);

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
      case "text": {
        const text = window.prompt("输入文字", "");
        if (!text) return null;
        return { ...base, kind: "text", at: from, text, fontSize: 18 };
      }
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

  const pickColor = (p: Point) => {
    const stage = stageRef.current;
    const img = sourceRef.current;
    if (!stage || !img || !monitor) return;
    const ratio = img.naturalWidth / monitor.width;
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    const px = Math.round(p.x * ratio);
    const py = Math.round(p.y * ratio);
    const data = ctx.getImageData(
      Math.min(Math.max(px, 0), canvas.width - 1),
      Math.min(Math.max(py, 0), canvas.height - 1),
      1,
      1,
    ).data;
    const hex = `#${[data[0], data[1], data[2]]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")}`;
    setColor(hex);
    setToast(`已取色 ${hex}`);
    void api.copyText(hex).catch(() => undefined);
  };

  /* --------------------------------------------------------------- output */

  /** Flatten annotations into a transparent PNG sized like the selection. */
  const renderOverlay = (): string | null => {
    const stage = stageRef.current;
    if (!stage || !box) return null;
    const layer = stage.getLayers()[1];
    if (!layer) return null;

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
      const overlay = renderOverlay();
      const result = await api.confirmCapture(monitor.id, box, action, overlay);
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

  const runAi = async (action: AiAction) => {
    if (!box || !monitor || busy) return;
    setBusy(true);
    try {
      const overlay = renderOverlay();
      const result = await api.confirmCapture(monitor.id, box, "copy", overlay);
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

  const cursor = tool === "select" ? "crosshair" : "crosshair";

  return (
    <div className="overlay-root" style={{ cursor }} onContextMenu={(e) => e.preventDefault()}>
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
            transparent annotation PNG with no screenshot baked in. */}
        <Layer>
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
          onAction={(a) => {
            if (a === "cancel") void cancel();
            else if (a === "extract" || a === "translate" || a === "explain" || a === "ask")
              void runAi(a);
            else void confirm(a);
          }}
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
        <div className="overlay-toast" onAnimationEnd={() => setToast(null)}>
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
