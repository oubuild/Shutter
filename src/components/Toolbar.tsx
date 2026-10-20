/** Floating toolbar docked to the selection.
 *
 * Icon-only, matching the reference chrome: a 44px bar with 36x36 hit targets,
 * 8px radius, 8px gaps, dividers between groups, and `#1b77ff` for the active
 * tool. Every control carries a `title` so name and shortcut stay discoverable
 * on hover.
 */

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PALETTE, TOOL_LABELS, type ToolId } from "../canvas/model";

export type ToolbarAction =
  | "copy"
  | "save"
  | "pin"
  | "extract"
  | "translate"
  | "explain"
  | "ask"
  | "cancel";

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
  onAction: (action: ToolbarAction) => void;
};

const TOOLS: ToolId[] = [
  "select",
  "rect",
  "ellipse",
  "arrow",
  "pen",
  "mosaic",
  "text",
  "highlight",
  "step",
  "picker",
];

/** AI actions: the "cloud" half of the bar, separated from local tools. */
const AI_ACTIONS: Array<{ id: ToolbarAction; label: string; key?: string }> = [
  { id: "extract", label: "提取文字", key: "T" },
  { id: "translate", label: "翻译", key: "F" },
  { id: "explain", label: "解释", key: "J" },
  { id: "ask", label: "提问" },
];

/** Output actions; copy is the primary one, so it is the only filled button. */
const OUT_ACTIONS: Array<{ id: ToolbarAction; label: string; key?: string }> = [
  { id: "pin", label: "贴图", key: "R" },
  { id: "save", label: "保存", key: "⌘S" },
  { id: "copy", label: "复制", key: "⏎" },
];

const TOOLBAR_H = 44;
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
    const width = ref.current?.offsetWidth ?? 620;
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

  // Report computed colours once so contrast can be verified from the terminal
  // (screencapture cannot see this window without Screen Recording permission).
  const reported = useRef(false);
  useEffect(() => {
    if (!pos || reported.current) return;
    const el = ref.current;
    if (!el) return;
    reported.current = true;
    const icon = el.querySelector(".cap-icon") as HTMLElement | null;
    const primary = el.querySelector(".cap-icon.primary") as HTMLElement | null;
    if (!icon) return;
    invoke("debug_report", {
      stage: "toolbar-style",
      detail: JSON.stringify({
        iconColor: getComputedStyle(icon).color,
        primaryBg: primary ? getComputedStyle(primary).backgroundColor : null,
        barColor: getComputedStyle(el).color,
        size: [el.offsetWidth, el.offsetHeight],
        buttons: el.querySelectorAll("button").length,
        // Icon-only means no button should have text content.
        textButtons: Array.from(el.querySelectorAll("button")).filter((b) =>
          (b.textContent ?? "").trim(),
        ).length,
      }),
    }).catch(() => undefined);
  }, [pos?.left, pos?.top]);

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
          <IconButton
            key={id}
            title={TOOL_LABELS[id]}
            active={tool === id}
            svg={ICONS[id]}
            onClick={() => props.onTool(id)}
          />
        ))}
      </div>

      <span className="cap-sep" />

      <div className="cap-swatches">
        <button
          className="cap-color"
          style={{ background: color }}
          title={`颜色 ${color}`}
          aria-label={`颜色 ${color}`}
          onClick={() => setPaletteOpen((v) => !v)}
        />
        {paletteOpen && (
          <div className="cap-palette" onMouseLeave={() => setPaletteOpen(false)}>
            {PALETTE.map((c) => (
              <button
                key={c}
                className={`cap-dot ${c === color ? "active" : ""}`}
                style={{ background: c }}
                title={c}
                aria-label={c}
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
        aria-label="粗细"
        onChange={(e) => props.onStrokeWidth(Number(e.target.value))}
      />

      {(tool === "rect" || tool === "ellipse") && (
        <IconButton
          title="填充"
          active={filled}
          svg={ICONS.fill}
          onClick={() => props.onFilled(!filled)}
        />
      )}

      <span className="cap-sep" />

      <IconButton
        title="撤销 ⌘Z"
        svg={ICONS.undo}
        disabled={!props.canUndo}
        onClick={props.onUndo}
      />

      <span className="cap-sep" />

      {AI_ACTIONS.map((a) => (
        <IconButton
          key={a.id}
          title={a.key ? `${a.label} ${a.key}` : a.label}
          svg={ICONS[a.id]}
          disabled={props.busy}
          onClick={() => props.onAction(a.id)}
        />
      ))}

      <span className="cap-sep" />

      {OUT_ACTIONS.map((a) => (
        <IconButton
          key={a.id}
          title={a.key ? `${a.label} ${a.key}` : a.label}
          svg={ICONS[a.id]}
          primary={a.id === "copy"}
          disabled={props.busy}
          onClick={() => props.onAction(a.id)}
        />
      ))}

      <span className="cap-sep" />

      <IconButton
        title="取消 esc"
        svg={ICONS.cancel}
        onClick={() => props.onAction("cancel")}
      />
    </div>
  );
}

function IconButton({
  title,
  svg,
  active,
  primary,
  disabled,
  onClick,
}: {
  title: string;
  svg: string;
  active?: boolean;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const cls = ["cap-icon", active ? "active" : "", primary ? "primary" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      className={cls}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      // Icons are static in-repo SVG strings; no user input reaches this.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

const S = (body: string) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** 20px stroke icons on a 24px grid. */
const ICONS: Record<string, string> = {
  // ---- tools ----
  select: S('<path d="M4 4h6M4 4v6M20 4h-6M20 4v6M4 20h6M4 20v-6M20 20h-6M20 20v-6"/>'),
  rect: S('<rect x="4" y="6" width="16" height="12" rx="1.5"/>'),
  ellipse: S('<ellipse cx="12" cy="12" rx="8" ry="6"/>'),
  arrow: S('<path d="M5 19 19 5M11 5h8v8"/>'),
  pen: S('<path d="M4 20c3-1 5-3 7-6l5-8 2 2-5 8c-1.5 2.5-3 4.5-6 5z"/><path d="M4 20l1-4"/>'),
  mosaic: S(
    '<rect x="4" y="4" width="5" height="5"/><rect x="10" y="4" width="5" height="5"/><rect x="16" y="4" width="4" height="5"/><rect x="4" y="10" width="5" height="5"/><rect x="10" y="10" width="5" height="5"/><rect x="16" y="10" width="4" height="5"/><rect x="4" y="16" width="5" height="4"/><rect x="10" y="16" width="5" height="4"/><rect x="16" y="16" width="4" height="4"/>',
  ),
  text: S('<path d="M5 6h14M12 6v13M9 19h6"/>'),
  highlight: S('<path d="M4 20h16"/><path d="M7 16 15 5l4 3-8 11H7z"/><path d="M7 16h4"/>'),
  step: S('<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10.5 12 8"/>'),
  picker: S('<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="4.5"/>'),
  fill: S(
    '<rect x="4" y="6" width="16" height="12" rx="1.5" fill="currentColor" fill-opacity=".35"/>',
  ),
  undo: S('<path d="M9 7H5V3"/><path d="M5 7a8 8 0 1 1 1.5 9"/>'),

  // ---- AI ----
  extract: S(
    '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 9h8M8 12h8M8 15h5"/>',
  ),
  translate: S(
    '<path d="M4 6h9M8.5 6c0 4-2 7-4.5 8"/><path d="M6 10c1 2.5 3 4.5 5.5 5.5"/><path d="M13 19l4-9 4 9M14.5 16h5"/>',
  ),
  explain: S(
    '<path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 16l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
  ),
  ask: S(
    '<path d="M20 12a7 7 0 0 1-7 7H8l-4 3v-5.5A7 7 0 0 1 9 4h4a7 7 0 0 1 7 8z"/><path d="M10 11h.01M13.5 11h.01"/>',
  ),

  // ---- output ----
  pin: S('<path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/>'),
  save: S('<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M4 18h16"/>'),
  copy: S(
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  ),
  cancel: S('<path d="M6 6l12 12M18 6 6 18"/>'),
};
