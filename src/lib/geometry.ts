/** Geometry helpers for the overlay. All values are CSS px unless stated. */

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

/** Normalise a drag (any direction) into a positive-size box. */
export function boxFromPoints(a: Point, b: Point): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Keep a box inside the given bounds without shrinking it below `min`. */
export function clampBox(box: Box, w: number, h: number, min = 1): Box {
  const width = clamp(box.width, min, w);
  const height = clamp(box.height, min, h);
  return {
    x: clamp(box.x, 0, w - width),
    y: clamp(box.y, 0, h - height),
    width,
    height,
  };
}

/** A box smaller than this (either axis) is treated as a stray click. */
export const MIN_SELECTION = 3;

export function isUsableSelection(box: Box): boolean {
  return box.width >= MIN_SELECTION && box.height >= MIN_SELECTION;
}

/** Round for display in the size badge. */
export function formatSize(box: Box, scale: number): string {
  const w = Math.round(box.width * scale);
  const h = Math.round(box.height * scale);
  return `${w} × ${h}`;
}

/**
 * Which grab handle (if any) the pointer is over.
 * Handles are anchored 4px outside the box, matching the CSS layout.
 */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move" | null;

export function hitHandle(box: Box, p: Point, radius = 8): Handle {
  const { x, y, width, height } = box;
  const near = (a: number, b: number) => Math.abs(a - b) <= radius;
  const inX = p.x >= x - radius && p.x <= x + width + radius;
  const inY = p.y >= y - radius && p.y <= y + height + radius;
  if (!inX || !inY) return null;

  const corners: Array<[Handle, number, number]> = [
    ["nw", x, y],
    ["ne", x + width, y],
    ["se", x + width, y + height],
    ["sw", x, y + height],
  ];
  for (const [name, cx, cy] of corners) {
    if (near(p.x, cx) && near(p.y, cy)) return name;
  }

  const edges: Array<[Handle, number, number]> = [
    ["n", x + width / 2, y],
    ["s", x + width / 2, y + height],
    ["w", x, y + height / 2],
    ["e", x + width, y + height / 2],
  ];
  for (const [name, cx, cy] of edges) {
    if (near(p.x, cx) && near(p.y, cy)) return name;
  }

  if (p.x > x && p.x < x + width && p.y > y && p.y < y + height) return "move";
  return null;
}

export function cursorFor(handle: Handle): string {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "move":
      return "move";
    default:
      return "crosshair";
  }
}
