/** Toolbar floating next to the selection. */

import { useEffect, useRef, useState } from "react";
import { PALETTE, TOOL_LABELS, type ToolId } from "../canvas/model";

type Props = {
  /** Selection box in CSS px; the toolbar docks below/above it. */
  box: { x: number; y: number; width: number; height: number } | null;
  tool: ToolId;
  color: string;
  strokeWidth: number;
  filled: boolean;
  canUndo: boolean;
  busy: boolean;
  onTool: (tool: ToolId) => void;
  onColor: (color: string) => void;
  onStrokeWidth: (width: number) => void;
  onFilled: (filled: boolean) => void;
  onUndo: () => void;
  onAction: (action: "copy" | "save" | "pin" | "extract" | "translate" | "explain" | "ask" | "cancel") => void;
};

const TOOLS: ToolId[] = ["select", "rect", "ellipse", "arrow", "pen", "mosaic", "text", "highlight", "step", "picker"];

const ACTIONS: Array<{ id: Parameters<Props["onAction"]>[0]; label: string; hint: string }> = [
  { id: "copy", label: "复制", hint: "⏎" },
  { id: "save", label: "保存", hint: "⌘S" },
  { id: "pin", label: "贴图", hint: "⌘P" },
  { id: "extract", label: "提取文字", hint: "" },
  { id: "translate", label: "翻译", hint: "" },
  { id: "explain", label: "解释", hint: "" },
  { id: "ask", label: "提问", hint: "" },
  { id: "cancel", label: "取消", hint: "esc" },
];

const TOOLBAR_H = 40;
const GAP = 8;

export function Toolbar(props: Props) {
  const { box, tool, color, strokeWidth, filled } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Dock below the selection, flipping above when there is no room.
  useEffect(() => {
    if (!box) {
      setPos(null);
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = ref.current?.offsetWidth ?? 520;
    let left = box.x + box.width - width;
    left = Math.min(Math.max(GAP, left), vw - width - GAP);

    let top = box.y + box.height + GAP;
    if (top + TOOLBAR_H > vh - GAP) {
      top = box.y - TOOLBAR_H - GAP;
    }
    if (top < GAP) {
      top = Math.min(vh - TOOLBAR_H - GAP, box.y + box.height + GAP);
    }
    setPos({ left, top });
  }, [box]);

  if (!box || !pos) return null;

  return (
    <div
      ref={ref}
      className="cap-toolbar"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="cap-tools">
        {TOOLS.map((id) => (
          <button
            key={id}
            className={`cap-icon ${tool === id ? "active" : ""}`}
            title={TOOL_LABELS[id]}
            onClick={() => props.onTool(id)}
          >
            {label(id)}
          </button>
        ))}
      </div>

      <span className="cap-sep" />

      <div className="cap-swatches">
        <button
          className="cap-color"
          style={{ background: color }}
          title="颜色"
          onClick={() => setPaletteOpen((v) => !v)}
        />
        {paletteOpen && (
          <div className="cap-palette" onMouseLeave={() => setPaletteOpen(false)}>
            {PALETTE.map((c) => (
              <button
                key={c}
                className={`cap-dot ${c === color ? "active" : ""}`}
                style={{ background: c }}
                onClick={() => {
                  props.onColor(c);
                  setPaletteOpen(false);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <input
        className="cap-width"
        type="range"
        min={1}
        max={12}
        value={strokeWidth}
        title={`粗细 ${strokeWidth}px`}
        onChange={(e) => props.onStrokeWidth(Number(e.target.value))}
      />

      {(tool === "rect" || tool === "ellipse") && (
        <button
          className={`cap-icon ${filled ? "active" : ""}`}
          title="填充"
          onClick={() => props.onFilled(!filled)}
        >
          实
        </button>
      )}

      <span className="cap-sep" />

      <button className="cap-icon" title="撤销 ⌘Z" disabled={!props.canUndo} onClick={props.onUndo}>
        ↶
      </button>

      {ACTIONS.map((a) => (
        <button
          key={a.id}
          className={`cap-action ${a.id === "copy" ? "primary" : ""} ${a.id === "cancel" ? "quiet" : ""}`}
          disabled={props.busy && a.id !== "cancel"}
          title={a.hint ? `${a.label} ${a.hint}` : a.label}
          onClick={() => props.onAction(a.id)}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

function label(id: ToolId): string {
  switch (id) {
    case "select":
      return "▣";
    case "rect":
      return "▭";
    case "ellipse":
      return "◯";
    case "arrow":
      return "↗";
    case "pen":
      return "✎";
    case "mosaic":
      return "▦";
    case "text":
      return "T";
    case "highlight":
      return "▤";
    case "step":
      return "①";
    case "picker":
      return "⊙";
    default:
      return id;
  }
}
