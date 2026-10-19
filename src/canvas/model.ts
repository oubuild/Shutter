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
};

export type ShapePen = Base & {
  kind: "pen";
  points: Point[];
  strokeWidth: number;
};

/** Pixelated region; `block` is the mosaic cell size in CSS px. */
export type ShapeMosaic = Base & {
  kind: "mosaic";
  from: Point;
  to: Point;
  block: number;
};

export type ShapeHighlight = Base & {
  kind: "highlight";
  from: Point;
  to: Point;
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

export const PALETTE = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#ffffff",
  "#111827",
];

/** Next step number is derived from existing badges, not from a counter. */
export function nextStepIndex(shapes: Shape[]): number {
  return shapes.filter((s) => s.kind === "step").length + 1;
}
