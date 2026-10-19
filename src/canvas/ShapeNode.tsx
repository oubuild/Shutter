/** Renders one annotation shape onto the Konva layer. */

import { useEffect, useMemo, useState } from "react";
import {
  Arrow as KArrow,
  Circle,
  Ellipse,
  Group,
  Image as KImage,
  Line,
  Rect,
  Text,
} from "react-konva";
import type { Point, Shape } from "./model";

type Props = {
  shape: Shape;
  /** Source image used by the mosaic tool. */
  source?: HTMLImageElement | null;
};

function arrowGeometry(from: Point, to: Point, strokeWidth: number) {
  const head = Math.max(12, strokeWidth * 4);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    shaft: [from.x, from.y, to.x - ux * head * 0.8, to.y - uy * head * 0.8],
    head,
  };
}

/**
 * Build a pixelated copy of the source at a given block size.
 *
 * Downscale to a tiny canvas, then upscale with smoothing disabled while
 * drawing — that yields crisp blocks in the exported PNG, which a render-time
 * smoothing setting could not guarantee.
 */
function useMosaicCanvas(source: HTMLImageElement | null | undefined, block: number) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!source || !source.naturalWidth) {
      setCanvas(null);
      return;
    }
    const w = source.naturalWidth;
    const h = source.naturalHeight;
    const size = Math.max(3, Math.round(block));

    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.floor(w / size));
    small.height = Math.max(1, Math.floor(h / size));
    const smallCtx = small.getContext("2d");
    if (!smallCtx) return;
    smallCtx.imageSmoothingEnabled = true;
    smallCtx.drawImage(source, 0, 0, small.width, small.height);

    const big = document.createElement("canvas");
    big.width = w;
    big.height = h;
    const bigCtx = big.getContext("2d");
    if (!bigCtx) return;
    bigCtx.imageSmoothingEnabled = false;
    bigCtx.drawImage(small, 0, 0, small.width, small.height, 0, 0, w, h);

    setCanvas(big);
  }, [source, block]);

  return canvas;
}

function MosaicShape({
  shape,
  source,
}: {
  shape: Extract<Shape, { kind: "mosaic" }>;
  source?: HTMLImageElement | null;
}) {
  const canvas = useMosaicCanvas(source, shape.block);
  const x = Math.min(shape.from.x, shape.to.x);
  const y = Math.min(shape.from.y, shape.to.y);
  const w = Math.abs(shape.to.x - shape.from.x);
  const h = Math.abs(shape.to.y - shape.from.y);

  if (!canvas || w < 2 || h < 2) return null;

  return (
    <Group listening={false} clipX={x} clipY={y} clipWidth={w} clipHeight={h}>
      <KImage image={canvas} x={0} y={0} width={canvas.width} height={canvas.height} />
    </Group>
  );
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
      const { shaft, head } = arrowGeometry(shape.from, shape.to, shape.strokeWidth);
      return (
        <KArrow
          points={shaft}
          pointerLength={head}
          pointerWidth={head}
          stroke={shape.color}
          fill={shape.color}
          strokeWidth={shape.strokeWidth}
          lineCap="round"
          listening={false}
        />
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

    case "highlight":
      return (
        <Rect
          x={box!.x}
          y={box!.y}
          width={box!.width}
          height={box!.height}
          fill={shape.color}
          opacity={0.32}
          cornerRadius={2}
          listening={false}
        />
      );

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
          fontFamily="-apple-system, PingFang SC, sans-serif"
          fontStyle="600"
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
