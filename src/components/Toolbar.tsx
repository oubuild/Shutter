/** Floating toolbar docked to the selection.
 *
 * Icon-only, matching the reference chrome: a 44px bar with 36x36 hit targets,
 * 8px radius, 8px gaps, dividers between groups, and `#1b77ff` for the active
 * tool. Every control carries a `title` so name and shortcut stay discoverable
 * on hover.
 *
 * Parameters follow the reference model (`.tmp/analysis/toolbar-diff.md` §D2b):
 * the bar itself has **no** persistent colour chip, width slider or fill toggle.
 * Selecting a tool opens that tool's parameter bubble — a second 44px bar that
 * docks under (or, near the bottom edge, above) the toolbar. Bubble contents
 * differ per tool and come from `TOOL_PANELS` below.
 */

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ARROW_HEADS,
  DASH_PATTERNS,
  HIGHLIGHT_SHAPES,
  MOSAIC_MODES,
  MOSAIC_PIXEL_MAX,
  MOSAIC_PIXEL_MIN,
  PALETTE,
  STROKE_DOT_SIZES,
  STROKE_WIDTHS,
  TEXT_SIZES,
  TOOL_LABELS,
  type ToolId,
  type ToolStyle,
} from "../canvas/model";

export type ToolbarAction =
  | "copy"
  | "save"
  | "pin"
  | "scroll"
  | "extract"
  | "translate"
  | "explain"
  | "ask"
  | "cancel";

type Props = {
  /** Selection box in CSS px; the toolbar docks below/above it. */
  box: { x: number; y: number; width: number; height: number } | null;
  tool: ToolId;
  /** Every per-tool drawing parameter (shared with the canvas). */
  style: ToolStyle;
  canUndo: boolean;
  busy: boolean;
  onTool: (tool: ToolId) => void;
  /** Patch one or more drawing parameters. */
  onStyle: (patch: Partial<ToolStyle>) => void;
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

/** Output actions. Copy keeps the plain icon style like every other button,
 *  matching the reference bar (no filled primary control). 长截图 sits first
 *  in this group, as in the reference bar (长截图(C)/贴图(R)/保存/复制). */
const OUT_ACTIONS: Array<{ id: ToolbarAction; label: string; key?: string }> = [
  { id: "scroll", label: "长截图", key: "C" },
  { id: "pin", label: "贴图", key: "R" },
  { id: "save", label: "保存", key: "⌘S" },
  { id: "copy", label: "复制", key: "⏎" },
];

/** Tools that own a parameter bubble, and how it is composed (reference `pi()`). */
type PanelKind =
  | "stroke-color"
  | "stroke-color-round-filled"
  | "stroke-color-filled"
  | "text-size-color"
  | "arrow"
  | "mosaic"
  | "highlight"
  | "step";

const TOOL_PANELS: Partial<Record<ToolId, PanelKind>> = {
  rect: "stroke-color-round-filled",
  ellipse: "stroke-color-filled",
  arrow: "arrow",
  pen: "stroke-color",
  mosaic: "mosaic",
  text: "text-size-color",
  highlight: "highlight",
  step: "step",
};

const TOOLBAR_H = 44;
const BUBBLE_H = 44;
const GAP = 8;
/** Reference flips the bubble up when the bar's bottom is within 82px of the
 *  viewport bottom (bubble height + gap + slack). */
const FLIP_THRESHOLD = 82;

export function Toolbar(props: Props) {
  const { box, tool, style } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  // Dock below the selection, flipping above when there is no room. The bar
  // only enters the DOM once `pos` is set, so the first pass places with the
  // last known width (a placeholder on the very first box) and a second pass
  // corrects the offset once the real width is measurable — otherwise the
  // bar sat at wherever a stale width put it.
  const place = (width: number) => {
    if (!box) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // A bar wider than the viewport must stay on screen: the naive right
    // clamp goes negative there and pushed the whole bar off-screen.
    let left = box.x + box.width - width;
    left = Math.max(GAP, Math.min(left, Math.max(GAP, vw - width - GAP)));

    let top = box.y + box.height + GAP;
    if (top + TOOLBAR_H > vh - GAP) {
      top = box.y - TOOLBAR_H - GAP;
    }
    if (top < GAP) {
      top = Math.min(vh - TOOLBAR_H - GAP, box.y + box.height + GAP);
    }
    return { left, top, width };
  };

  useEffect(() => {
    if (!box) {
      setPos(null);
      return;
    }
    setPos(place(pos?.width ?? 620));
    // The window can resize after the first placement (a viewport settling
    // late, a monitor change); re-dock or the bar stays where the old
    // geometry put it — possibly off-screen.
    const onResize = () => setPos(place(pos?.width ?? 620));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !pos) return;
    const width = el.offsetWidth;
    if (width > 0 && Math.abs(width - pos.width) > 1) {
      setPos(place(width));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  // Report computed colours once so contrast can be verified from the terminal
  // (screencapture cannot see this window without Screen Recording permission).
  const reported = useRef(false);
  useEffect(() => {
    if (!pos || reported.current) return;
    const el = ref.current;
    if (!el) return;
    reported.current = true;
    const icon = el.querySelector(".cap-icon") as HTMLElement | null;
    const active = el.querySelector(".cap-icon.active") as HTMLElement | null;
    if (!icon) return;
    invoke("debug_report", {
      stage: "toolbar-style",
      detail: JSON.stringify({
        iconColor: getComputedStyle(icon).color,
        activeColor: active ? getComputedStyle(active).color : null,
        barColor: getComputedStyle(el).color,
        size: [el.offsetWidth, el.offsetHeight],
        rect: [Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().top)],
        buttons: el.querySelectorAll("button").length,
        // Icon-only means no button should have text content.
        textButtons: Array.from(el.querySelectorAll("button")).filter((b) =>
          (b.textContent ?? "").trim(),
        ).length,
      }),
    }).catch(() => undefined);
  }, [pos?.left, pos?.top]);

  if (!box || !pos) return null;

  const panel = TOOL_PANELS[tool];
  // Reference: `bottom + 82 > innerHeight` ⇒ bubble above the bar.
  const bubbleAbove = pos.top + TOOLBAR_H + FLIP_THRESHOLD > window.innerHeight;
  const bubbleTop = bubbleAbove ? -(BUBBLE_H + 4) : TOOLBAR_H + 3;

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

      {panel && (
        <div
          className="cap-bubble"
          data-cap="bubble"
          data-tool={tool}
          data-placement={bubbleAbove ? "top" : "bottom"}
          style={{ top: bubbleTop }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <ToolPanel kind={panel} style={style} onStyle={props.onStyle} />
        </div>
      )}
    </div>
  );
}

/** Contents of one tool's parameter bubble (reference `pi()` dispatch). */
function ToolPanel({
  kind,
  style,
  onStyle,
}: {
  kind: PanelKind;
  style: ToolStyle;
  onStyle: (patch: Partial<ToolStyle>) => void;
}) {
  const stroke = <StrokeDots style={style} onStyle={onStyle} />;
  const palette = (
    <>
      <span className="cap-sep" />
      <Palette style={style} onStyle={onStyle} />
    </>
  );

  switch (kind) {
    case "stroke-color":
      return (
        <>
          {stroke}
          {palette}
        </>
      );
    case "stroke-color-filled":
      return (
        <>
          {stroke}
          {palette}
          <span className="cap-sep" />
          <CheckToggle
            label="实心"
            checked={style.filled}
            onChange={(v) => onStyle({ filled: v })}
          />
        </>
      );
    case "stroke-color-round-filled":
      return (
        <>
          {stroke}
          {palette}
          <span className="cap-sep" />
          <CheckToggle
            label="圆角"
            checked={style.rounded}
            onChange={(v) => onStyle({ rounded: v })}
          />
          <CheckToggle
            label="实心"
            checked={style.filled}
            onChange={(v) => onStyle({ filled: v })}
          />
        </>
      );
    case "text-size-color":
      return (
        <>
          <TextSizes style={style} onStyle={onStyle} />
          {palette}
        </>
      );
    case "arrow":
      return (
        <>
          <Select
            label="箭头样式"
            value={style.arrowHead}
            options={ARROW_HEADS.map((h) => ({ value: h.id, label: h.label }))}
            onChange={(v) => onStyle({ arrowHead: v as ToolStyle["arrowHead"] })}
          />
          <Select
            label="虚线样式"
            value={dashIdOf(style.arrowDash)}
            options={DASH_PATTERNS.map((d) => ({ value: d.id, label: d.label }))}
            onChange={(v) =>
              onStyle({ arrowDash: DASH_PATTERNS.find((d) => d.id === v)?.value ?? [] })
            }
          />
          <span className="cap-sep" />
          {stroke}
          {palette}
        </>
      );
    case "mosaic":
      return (
        <>
          <Segmented
            label="模式"
            value={style.mosaicMode}
            options={MOSAIC_MODES.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(v) => onStyle({ mosaicMode: v as ToolStyle["mosaicMode"] })}
          />
          {/* Reference: changing the width preset also drops rectangle mode,
              and the dots are not lit while it is on. */}
          <StrokeDots
            style={style}
            dim={style.mosaicRect}
            onStyle={(patch) => onStyle({ ...patch, mosaicRect: false })}
          />
          <Segmented
            label="选区"
            value={style.mosaicRect ? "rect" : "free"}
            options={[
              { value: "free", label: "自由涂" },
              { value: "rect", label: "矩形" },
            ]}
            onChange={(v) => onStyle({ mosaicRect: v === "rect" })}
          />
          <span className="cap-sep" />
          <Slider
            label="像素"
            min={MOSAIC_PIXEL_MIN}
            max={MOSAIC_PIXEL_MAX}
            step={1}
            value={style.mosaicPixel}
            onChange={(v) => onStyle({ mosaicPixel: v })}
          />
        </>
      );
    case "highlight":
      return (
        <>
          <Segmented
            label="形状"
            value={style.highlightShape}
            options={HIGHLIGHT_SHAPES.map((h) => ({ value: h.id, label: h.label }))}
            onChange={(v) => onStyle({ highlightShape: v as ToolStyle["highlightShape"] })}
          />
          <span className="cap-sep" />
          <Slider
            label="不透明度"
            min={0}
            max={1}
            step={0.1}
            value={style.highlightOpacity}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => onStyle({ highlightOpacity: v })}
          />
          <Slider
            label="模糊"
            min={1}
            max={10}
            step={1}
            value={style.highlightBlur}
            onChange={(v) => onStyle({ highlightBlur: v })}
          />
        </>
      );
    case "step":
      return (
        <>
          {stroke}
          {palette}
          <span className="cap-sep" />
          <NumberField
            label="序号"
            min={1}
            max={99}
            value={style.stepNext}
            onChange={(v) => onStyle({ stepNext: v })}
          />
        </>
      );
  }
}

/** Three stroke-width presets drawn as dots, mirroring the reference `Ql`. */
function StrokeDots({
  style,
  dim,
  onStyle,
}: {
  style: ToolStyle;
  dim?: boolean;
  onStyle: (patch: Partial<ToolStyle>) => void;
}) {
  return (
    <div className="cap-dots" data-cap="stroke" data-dim={dim ? "1" : "0"}>
      {STROKE_WIDTHS.map((width, idx) => {
        const dot = STROKE_DOT_SIZES[idx];
        return (
          <button
            key={width}
            className={`cap-stroke ${idx === style.strokeIdx && !dim ? "active" : ""}`}
            title={`线宽 ${width}px`}
            aria-label={`线宽 ${width}px`}
            aria-pressed={idx === style.strokeIdx}
            onClick={() => onStyle({ strokeIdx: idx })}
          >
            <span style={{ width: dot, height: dot }} />
          </button>
        );
      })}
    </div>
  );
}

/** Three text-size presets (reference `tn`: 14/24/36). */
function TextSizes({
  style,
  onStyle,
}: {
  style: ToolStyle;
  onStyle: (patch: Partial<ToolStyle>) => void;
}) {
  return (
    <div className="cap-dots" data-cap="text-size">
      {TEXT_SIZES.map((size, idx) => (
        <button
          key={size}
          className={`cap-size-btn ${idx === style.textSizeIdx ? "active" : ""}`}
          title={`字号 ${size}`}
          aria-label={`字号 ${size}`}
          aria-pressed={idx === style.textSizeIdx}
          style={{ fontSize: 11 + idx * 5 }}
          onClick={() => onStyle({ textSizeIdx: idx })}
        >
          A
        </button>
      ))}
    </div>
  );
}

/** The 7 fixed reference colours; `#FFFFFF` gets a hairline so it stays visible. */
function Palette({
  style,
  onStyle,
}: {
  style: ToolStyle;
  onStyle: (patch: Partial<ToolStyle>) => void;
}) {
  return (
    <div className="cap-palette-row" data-cap="palette">
      {PALETTE.map((c) => (
        <button
          key={c}
          className={`cap-dot ${c === style.color ? "active" : ""}`}
          style={{
            background: c,
            borderColor: c === "#FFFFFF" ? "rgba(0,0,0,.1)" : undefined,
          }}
          title={c}
          aria-label={c}
          aria-pressed={c === style.color}
          onClick={() => onStyle({ color: c })}
        />
      ))}
    </div>
  );
}

function CheckToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      className={`cap-check ${checked ? "active" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="cap-check-box" aria-hidden="true">
        {checked && <CheckGlyph />}
      </span>
      {label}
    </button>
  );
}

function Segmented({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="cap-seg" role="group" aria-label={label} data-cap="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={`cap-seg-btn ${o.value === value ? "active" : ""}`}
          title={o.label}
          aria-label={o.label}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <select
      className="cap-select"
      title={label}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  format,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="cap-slider" title={label}>
      <span className="cap-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="cap-slider-value">{format ? format(value) : value}</span>
    </label>
  );
}

function NumberField({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="cap-num" title={label}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        aria-label={label}
        onChange={(e) => {
          // Reference clamps to 1..99 rather than rejecting the edit.
          const n = Number(e.target.value);
          if (Number.isNaN(n)) return;
          onChange(Math.max(min, Math.min(max, Math.round(n))));
        }}
      />
    </label>
  );
}

function CheckGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.2 5 8.6l4.5-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Dash id for a pattern; unknown patterns fall back to solid. */
function dashIdOf(dash: number[]): string {
  return DASH_PATTERNS.find((d) => d.value.join(",") === dash.join(","))?.id ?? "solid";
}

function IconButton({
  title,
  svg,
  active,
  disabled,
  onClick,
}: {
  title: string;
  svg: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const cls = ["cap-icon", active ? "active" : ""].filter(Boolean).join(" ");
  return (
    <button
      className={cls}
      title={title}
      aria-label={title}
      aria-pressed={active}
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
  // ---- output ----
  // Long screenshot: a page with a downward flow arrow (scroll-and-stitch).
  scroll: S(
    '<rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9 7h6M9 10.5h6"/><path d="M12 13v6"/><path d="m9.5 16.5 2.5 2.5 2.5-2.5"/>',
  ),
  pin: S('<path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/>'),
  save: S('<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M4 18h16"/>'),
  copy: S(
    '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  ),
  cancel: S('<path d="M6 6l12 12M18 6 6 18"/>'),
};
