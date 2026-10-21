/** Renders one annotation shape onto the Konva layer. */

import { useEffect, useMemo, useState } from "react";
import {
  Circle,
  Ellipse,
  Group,
  Image as KImage,
  Line,
  Rect,
  Text,
} from "react-konva";
import type {
  ArrowHeadStyle as ShapeArrowHead,
  MosaicMode,
  Point,
  Shape,
} from "./model";

type Props = {
  shape: Shape;
  /** Source image used by the mosaic tool. */
  source?: HTMLImageElement | null;
};

/** Head length for a stroke width; the reference scales heads with the line. */
function headLength(strokeWidth: number) {
  return Math.max(12, strokeWidth * 4);
}

/**
 * Shaft + head geometry for an arrow.
 *
 * The reference ships five head styles (`vS`); they differ only in whether a
 * head is drawn at the start, the end, or both, and whether it is filled.
 * `KArrow` draws one head at the end, so the start head is a second element.
 */
function arrowGeometry(
  from: Point,
  to: Point,
  strokeWidth: number,
  head: ShapeArrowHead,
) {
  const size = headLength(strokeWidth);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // A double-headed arrow needs both ends pulled back so neither head
  // overshoots the shaft.
  const both = head === "doubleTriangle" || head === "doubleAngle";
  const trim = both ? size * 0.8 : 0;
  // `angle` styles are plain open chevrons; `arrow` is the same head with a
  // shorter, wider fork; `doubleMark` adds a second, offset chevron.
  const open = head !== "triangle" && head !== "doubleTriangle";
  const fork = head === "arrow" ? 0.55 : 0.42;
  return {
    shaft: [
      from.x + ux * trim,
      from.y + uy * trim,
      to.x - ux * size * 0.8,
      to.y - uy * size * 0.8,
    ],
    head: size,
    // "arrow"/"angle"/"doubleAngle"/"doubleMark" are open heads; the two
    // triangles are filled.
    open,
    fork,
    doubleMark: head === "doubleMark",
    startHead: both,
    start: from,
    angle: Math.atan2(dy, dx),
  };
}

/**
 * One arrow head, drawn at an arbitrary angle.
 *
 * Konva's `Arrow` only paints a filled head at the end of a line, which cannot
 * express the reference's open chevrons or a head at the start of the shaft.
 * This draws either shape directly so all five styles share one geometry.
 */
function ArrowHead({
  at,
  angle,
  size,
  color,
  width,
  open,
  fork = 0.42,
  doubleMark = false,
}: {
  at: Point;
  angle: number;
  size: number;
  color: string;
  width: number;
  open: boolean;
  /** Half-width of the fork as a fraction of its length. */
  fork?: number;
  /** Draw a second, smaller chevron behind the first. */
  doubleMark?: boolean;
}) {
  // Local head geometry pointing along +x, then rotated into place.
  const half = size * fork;
  const tip = { x: 0, y: 0 };
  const left = { x: -size, y: -half };
  const right = { x: -size, y: half };
  const rotate = (p: Point): Point => ({
    x: at.x + p.x * Math.cos(angle) - p.y * Math.sin(angle),
    y: at.y + p.x * Math.sin(angle) + p.y * Math.cos(angle),
  });
  const t = rotate(tip);
  const l = rotate(left);
  const r = rotate(right);
  if (open) {
    const chevron = (pts: number[]) => (
      <Line
        points={pts}
        stroke={color}
        strokeWidth={width}
        lineCap="round"
        lineJoin="round"
        listening={false}
      />
    );
    const main = [l.x, l.y, t.x, t.y, r.x, r.y];
    if (!doubleMark) return chevron(main);
    // The trailing chevron is the same shape pulled back along the shaft.
    const back = (p: Point, d: number): Point => ({
      x: p.x - Math.cos(angle) * d,
      y: p.y - Math.sin(angle) * d,
    });
    const l2 = back(l, size * 0.55);
    const t2 = back(t, size * 0.55);
    const r2 = back(r, size * 0.55);
    return (
      <>
        {chevron(main)}
        {chevron([l2.x, l2.y, t2.x, t2.y, r2.x, r2.y])}
      </>
    );
  }
  return (
    <Line
      points={[t.x, t.y, l.x, l.y, r.x, r.y]}
      closed
      fill={color}
      stroke={color}
      strokeWidth={width}
      lineJoin="round"
      listening={false}
    />
  );
}

/**
 * Build a pixelated copy of the source at a given block size.
 *
 * Downscale to a tiny canvas, then upscale with smoothing disabled while
 * drawing — that yields crisp blocks in the exported PNG, which a render-time
 * smoothing setting could not guarantee.
 *
 * The source is in physical pixels while the stage is in CSS pixels; on a 2x
 * monitor the canvas used to be placed at its physical size and showed only
 * its top-left quadrant, double-sized. The overlay window spans exactly one
 * monitor, so `innerWidth` gives the CSS width to convert with.
 */
function useMosaicCanvas(
  source: HTMLImageElement | null | undefined,
  block: number,
  mode: MosaicMode,
): { canvas: HTMLCanvasElement; scale: number } | null {
  const [mosaic, setMosaic] = useState<{ canvas: HTMLCanvasElement; scale: number } | null>(null);

  useEffect(() => {
    if (!source || !source.naturalWidth) {
      setMosaic(null);
      return;
    }
    const w = source.naturalWidth;
    const h = source.naturalHeight;
    const scale = w / window.innerWidth;
    const size = Math.max(3, Math.round(block));

    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.floor(w / scale / size));
    small.height = Math.max(1, Math.floor(h / scale / size));
    const smallCtx = small.getContext("2d");
    if (!smallCtx) return;
    smallCtx.imageSmoothingEnabled = true;
    smallCtx.drawImage(source, 0, 0, small.width, small.height);

    const big = document.createElement("canvas");
    big.width = w;
    big.height = h;
    const bigCtx = big.getContext("2d");
    if (!bigCtx) return;
    if (mode === "glassmorphism") {
      // The reference's second mode is a Gaussian blur, not pixel blocks:
      // same downscale, but smoothing stays on for the upscale.
      bigCtx.imageSmoothingEnabled = true;
      bigCtx.filter = `blur(${Math.max(1, size / 3)}px)`;
    } else {
      bigCtx.imageSmoothingEnabled = false;
    }
    bigCtx.drawImage(small, 0, 0, small.width, small.height, 0, 0, w, h);

    setMosaic({ canvas: big, scale });
  }, [source, block, mode]);

  return mosaic;
}

function MosaicShape({
  shape,
  source,
}: {
  shape: Extract<Shape, { kind: "mosaic" }>;
  source?: HTMLImageElement | null;
}) {
  const mosaic = useMosaicCanvas(source, shape.block, shape.mode);
  // Freehand smears are masked into their own canvas: a canvas clip path only
  // honours fills, so a stroked path has to be composited with
  // `destination-in` instead. Building it here also means the export path
  // (which serialises this layer) contains the same pixels as the screen.
  const masked = useMaskedSmear(mosaic, shape);

  if (!mosaic) return null;
  const { canvas, scale } = mosaic;

  if (shape.rectSelect) {
    const x = Math.min(shape.from.x, shape.to.x);
    const y = Math.min(shape.from.y, shape.to.y);
    const w = Math.abs(shape.to.x - shape.from.x);
    const h = Math.abs(shape.to.y - shape.from.y);
    if (w < 2 || h < 2) return null;
    return (
      <Group listening={false} clipX={x} clipY={y} clipWidth={w} clipHeight={h}>
        {/* Backing at physical px (crisp on export), shown at CSS size. */}
        <KImage
          image={canvas}
          x={0}
          y={0}
          width={canvas.width / scale}
          height={canvas.height / scale}
        />
      </Group>
    );
  }

  if (!masked) return null;
  return (
    <KImage
      image={masked.canvas}
      x={0}
      y={0}
      width={masked.canvas.width / masked.scale}
      height={masked.canvas.height / masked.scale}
      listening={false}
    />
  );
}

/** Mask the filtered frame down to a freehand smear's stroked path. */
function useMaskedSmear(
  mosaic: { canvas: HTMLCanvasElement; scale: number } | null,
  shape: Extract<Shape, { kind: "mosaic" }>,
): { canvas: HTMLCanvasElement; scale: number } | null {
  const [masked, setMasked] = useState<{ canvas: HTMLCanvasElement; scale: number } | null>(null);

  useEffect(() => {
    if (!mosaic || shape.rectSelect || shape.points.length < 2) {
      setMasked(null);
      return;
    }
    const { canvas: filtered, scale } = mosaic;
    const out = document.createElement("canvas");
    out.width = filtered.width;
    out.height = filtered.height;
    const ctx = out.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(filtered, 0, 0);
    // Keep only what the smear covers: stroke the path with the brush width,
    // then punch everything else out of the layer.
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    // Points are CSS px; the canvas is physical px.
    for (let i = 0; i < shape.points.length; i++) {
      const p = shape.points[i];
      if (i === 0) ctx.moveTo(p.x * scale, p.y * scale);
      else ctx.lineTo(p.x * scale, p.y * scale);
    }
    ctx.lineWidth = shape.block * scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";

    setMasked({ canvas: out, scale });
  }, [mosaic, shape.rectSelect, shape.block, shape.points]);

  return masked;
}

export function ShapeNode({ shape, source }: Props) {
  const box = useMemo(() => {
    if (!("from" in shape) || !("to" in shape)) return null;
    return {
      x: Math.min(shape.from.x, shape.to.x),
      y: Math.min(shape.from.y, shape.to.y),
      width: Math.abs(shape.to.x - shape.from.x),
      height: Math.abs(shape.to.y - shape.from.y),
    };
  }, [shape]);

  switch (shape.kind) {
    case "rect":
      return (
        <Rect
          x={box!.x}
          y={box!.y}
          width={box!.width}
          height={box!.height}
          cornerRadius={shape.radius}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          fill={shape.filled ? shape.color : undefined}
          listening={false}
        />
      );

    case "ellipse":
      return (
        <Ellipse
          x={box!.x + box!.width / 2}
          y={box!.y + box!.height / 2}
          radiusX={box!.width / 2}
          radiusY={box!.height / 2}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          fill={shape.filled ? shape.color : undefined}
          listening={false}
        />
      );

    case "arrow": {
      const g = arrowGeometry(shape.from, shape.to, shape.strokeWidth, shape.head);
      const dash = shape.dash.length ? shape.dash : undefined;
      return (
        <Group listening={false}>
          <Line
            points={g.shaft}
            stroke={shape.color}
            strokeWidth={shape.strokeWidth}
            lineCap="round"
            dash={dash}
          />
          <ArrowHead
            at={shape.to}
            angle={g.angle}
            size={g.head}
            color={shape.color}
            width={shape.strokeWidth}
            open={g.open}
            fork={g.fork}
            doubleMark={g.doubleMark}
          />
          {g.startHead && (
            <ArrowHead
              at={shape.from}
              angle={g.angle + Math.PI}
              size={g.head}
              color={shape.color}
              width={shape.strokeWidth}
              open={g.open}
              fork={g.fork}
              doubleMark={g.doubleMark}
            />
          )}
        </Group>
      );
    }

    case "pen":
      return (
        <Line
          points={shape.points.flatMap((p) => [p.x, p.y])}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          lineCap="round"
          lineJoin="round"
          tension={0.35}
          listening={false}
        />
      );

    case "highlight": {
      // Reference highlight is a frosted-glass wash, not a colour block: the
      // shape only decides the silhouette, and `blur` softens its edge.
      const common = {
        x: box!.x,
        y: box!.y,
        width: box!.width,
        height: box!.height,
        fill: shape.color,
        opacity: shape.opacity,
        shadowColor: shape.color,
        shadowBlur: shape.blur * 2,
        shadowOpacity: shape.opacity * 0.6,
        listening: false,
      };
      if (shape.shape === "ellipse") {
        return (
          <Ellipse
            x={box!.x + box!.width / 2}
            y={box!.y + box!.height / 2}
            radiusX={box!.width / 2}
            radiusY={box!.height / 2}
            fill={shape.color}
            opacity={shape.opacity}
            shadowColor={shape.color}
            shadowBlur={shape.blur * 2}
            shadowOpacity={shape.opacity * 0.6}
            listening={false}
          />
        );
      }
      return (
        <Rect
          {...common}
          cornerRadius={shape.shape === "roundRect" ? 10 : 0}
        />
      );
    }

    case "mosaic":
      return <MosaicShape shape={shape} source={source} />;

    case "text":
      return (
        <Text
          x={shape.at.x}
          y={shape.at.y}
          text={shape.text}
          fontSize={shape.fontSize}
          fill={shape.color}
          fontFamily='"Heiti SC", "PingFang SC", -apple-system, sans-serif'
          fontStyle="600"
          lineHeight={1.35}
          listening={false}
          shadowColor="rgba(0,0,0,0.45)"
          shadowBlur={3}
          shadowOffsetY={1}
        />
      );

    case "step":
      return (
        <Group x={shape.at.x} y={shape.at.y} listening={false}>
          <Circle radius={shape.radius} fill={shape.color} shadowColor="rgba(0,0,0,0.4)" shadowBlur={4} />
          <Text
            text={String(shape.index)}
            fontSize={shape.radius * 1.15}
            fontStyle="700"
            fill="#fff"
            width={shape.radius * 2}
            height={shape.radius * 2}
            x={-shape.radius}
            y={-shape.radius}
            align="center"
            verticalAlign="middle"
          />
        </Group>
      );

    default:
      return null;
  }
}
