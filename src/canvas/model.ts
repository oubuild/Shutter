/** Annotation layer model shared by the overlay canvas and the toolbar. */

export type ToolId =
  | "select"
  | "rect"
  | "ellipse"
  | "arrow"
  | "pen"
  | "mosaic"
  | "text"
  | "highlight"
  | "step"
  | "picker";

export type Point = { x: number; y: number };

/** Arrow head styles, mirroring the reference `vS` table (6 entries). */
export type ArrowHeadStyle =
  | "triangle"
  | "doubleTriangle"
  | "arrow"
  | "angle"
  | "doubleAngle"
  | "doubleMark";

/** Mosaic rendering: pixel blocks or a frosted-glass blur. */
export type MosaicMode = "mosaic" | "glassmorphism";

/** Highlight silhouettes, mirroring the reference `E2` table. */
export type HighlightShape = "rect" | "ellipse" | "roundRect";

type Base = { id: string; color: string };

/** Solid outline shapes. `strokeWidth` is in CSS px. */
export type ShapeRect = Base & {
  kind: "rect";
  from: Point;
  to: Point;
  strokeWidth: number;
  filled: boolean;
  radius: number;
};

export type ShapeEllipse = Base & {
  kind: "ellipse";
  from: Point;
  to: Point;
  strokeWidth: number;
  filled: boolean;
};

export type ShapeArrow = Base & {
  kind: "arrow";
  from: Point;
  to: Point;
  strokeWidth: number;
  head: ArrowHeadStyle;
  /** Dash pattern; `[]` is solid (the reference `Gs` table). */
  dash: number[];
};

export type ShapePen = Base & {
  kind: "pen";
  points: Point[];
  strokeWidth: number;
};

/** Pixelated / blurred region; `block` is the mosaic cell size in CSS px. */
export type ShapeMosaic = Base & {
  kind: "mosaic";
  from: Point;
  to: Point;
  /** Freehand path; empty when the region came from a rectangle drag. */
  points: Point[];
  /** `true` = rectangle selection, `false` = freehand smear. */
  rectSelect: boolean;
  block: number;
  mode: MosaicMode;
};

/** Frosted-glass wash; `opacity` is the wash strength and `blur` its radius. */
export type ShapeHighlight = Base & {
  kind: "highlight";
  from: Point;
  to: Point;
  opacity: number;
  blur: number;
  shape: HighlightShape;
};

export type ShapeText = Base & {
  kind: "text";
  at: Point;
  text: string;
  fontSize: number;
};

/** Auto-incrementing numbered badge. */
export type ShapeStep = Base & {
  kind: "step";
  at: Point;
  index: number;
  radius: number;
};

export type Shape =
  | ShapeRect
  | ShapeEllipse
  | ShapeArrow
  | ShapePen
  | ShapeMosaic
  | ShapeHighlight
  | ShapeText
  | ShapeStep;

export type UndoStack = { shapes: Shape[] };

let counter = 0;
export function nextId(): string {
  counter += 1;
  return `s${Date.now().toString(36)}-${counter}`;
}

export const TOOL_LABELS: Record<ToolId, string> = {
  select: "选择",
  rect: "矩形",
  ellipse: "椭圆",
  arrow: "箭头",
  pen: "画笔",
  mosaic: "马赛克",
  text: "文字",
  highlight: "高亮",
  step: "序号",
  picker: "取色",
};

/** Keyboard shortcuts, matching the digits a screenshot tool usually uses. */
export const TOOL_KEYS: Record<string, ToolId> = {
  "1": "rect",
  "2": "ellipse",
  "3": "arrow",
  "4": "pen",
  "5": "mosaic",
  "6": "text",
  "7": "highlight",
  "8": "step",
  "9": "picker",
};

/** Reference palette `SS`: 7 fixed colours, no custom picker. */
export const PALETTE = [
  "#F22B24",
  "#027FFF",
  "#05A532",
  "#FFBE00",
  "#000000",
  "#999999",
  "#FFFFFF",
];

/** Text size presets — icon size → font px, mirroring the reference `tn`. */
export const TEXT_SIZES = [14, 24, 36];

/** Stroke width presets — dot size → px, mirroring the reference `Ql`.
 * The reference default is index 0 (3px). */
export const STROKE_WIDTHS = [3, 6, 9];

/** Diameter of the stroke-preset dots, mirroring the reference `Ql` glyphs. */
export const STROKE_DOT_SIZES = [6, 10, 16];

/** Number badge diameters for the same 3-step index (reference `vd`). */
export const STEP_DIAMETERS = [24, 48, 60];

/** Arrow head options for the arrow panel (reference `vS` order). */
export const ARROW_HEADS: ReadonlyArray<{ id: ArrowHeadStyle; label: string }> = [
  { id: "triangle", label: "三角箭头" },
  { id: "doubleTriangle", label: "双向三角" },
  { id: "arrow", label: "线形箭头" },
  { id: "angle", label: "折角箭头" },
  { id: "doubleAngle", label: "双向折角" },
  { id: "doubleMark", label: "双线箭头" },
];

/** Dash presets, mirroring the reference `Gs` table. */
export const DASH_PATTERNS: ReadonlyArray<{ id: string; label: string; value: number[] }> = [
  { id: "solid", label: "实线", value: [] },
  { id: "long", label: "长虚线", value: [10, 5, 10, 5] },
  { id: "short", label: "短虚线", value: [5, 5] },
  { id: "dash-dot", label: "点划线", value: [10, 5, 5, 5] },
  { id: "dense", label: "密集虚线", value: [5, 5, 5, 5, 10, 5, 5, 5, 5, 5] },
];

/** Mosaic modes: pixel blocks vs frosted glass. */
export const MOSAIC_MODES: ReadonlyArray<{ id: MosaicMode; label: string }> = [
  { id: "mosaic", label: "像素块" },
  { id: "glassmorphism", label: "高斯模糊" },
];

/** Highlight silhouettes. */
export const HIGHLIGHT_SHAPES: ReadonlyArray<{ id: HighlightShape; label: string }> = [
  { id: "rect", label: "方形" },
  { id: "ellipse", label: "圆形" },
  { id: "roundRect", label: "圆角矩形" },
];

/** Mosaic strength bounds (reference: 1..10, block = pixel * 5). */
export const MOSAIC_PIXEL_MIN = 1;
export const MOSAIC_PIXEL_MAX = 10;
export const MOSAIC_PIXEL_STEP = 5;

/** Every per-tool drawing parameter, shared by the toolbar and the canvas.
 *
 * One object rather than a dozen props: the parameter bubbles read it and the
 * overlay writes patches, so a new parameter only has to be added here. */
export type ToolStyle = {
  color: string;
  /** Index into STROKE_WIDTHS. */
  strokeIdx: number;
  filled: boolean;
  rounded: boolean;
  /** Index into TEXT_SIZES. */
  textSizeIdx: number;
  mosaicPixel: number;
  mosaicMode: MosaicMode;
  /** Rectangle selection instead of freehand smear. */
  mosaicRect: boolean;
  highlightOpacity: number;
  highlightBlur: number;
  highlightShape: HighlightShape;
  arrowHead: ArrowHeadStyle;
  arrowDash: number[];
  /** Number the next badge will show (1..99). */
  stepNext: number;
};

/** Reference defaults (I@334942): red, 3px, 14px text, round rect, mosaic 5. */
export const DEFAULT_TOOL_STYLE: ToolStyle = {
  color: "#F22B24",
  strokeIdx: 0,
  filled: false,
  rounded: true,
  textSizeIdx: 0,
  mosaicPixel: 5,
  mosaicMode: "mosaic",
  mosaicRect: false,
  highlightOpacity: 0.5,
  highlightBlur: 5,
  highlightShape: "roundRect",
  arrowHead: "triangle",
  arrowDash: [],
  stepNext: 1,
};

/** Current stroke width from the preset index. */
export function strokeWidthOf(style: ToolStyle): number {
  return STROKE_WIDTHS[clampIndex(style.strokeIdx, STROKE_WIDTHS.length)];
}

/** Current text size from the preset index. */
export function textSizeOf(style: ToolStyle): number {
  return TEXT_SIZES[clampIndex(style.textSizeIdx, TEXT_SIZES.length)];
}

/** Number badge diameter for the shared 3-step size index. */
export function stepDiameterOf(style: ToolStyle): number {
  return STEP_DIAMETERS[clampIndex(style.strokeIdx, STEP_DIAMETERS.length)];
}

/** Mosaic block size in CSS px: the reference drives it from `mosaicPixel`. */
export function mosaicBlockOf(pixel: number): number {
  return pixel * MOSAIC_PIXEL_STEP;
}

/** Clamp a preset index into a table's range. */
export function clampIndex(idx: number, length: number): number {
  return Math.max(0, Math.min(length - 1, idx));
}


/** Translate a shape by (dx, dy). Every kind stores its geometry as points. */
export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  const move = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  switch (shape.kind) {
    case "rect":
    case "ellipse":
    case "arrow":
    case "highlight":
      return { ...shape, from: move(shape.from), to: move(shape.to) };
    case "mosaic":
      return {
        ...shape,
        from: move(shape.from),
        to: move(shape.to),
        points: shape.points.map(move),
      };
    case "pen":
      return { ...shape, points: shape.points.map(move) };
    case "text":
    case "step":
      return { ...shape, at: move(shape.at) };
  }
}
