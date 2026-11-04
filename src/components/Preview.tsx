/**
 * Full-size screenshot preview over the gallery — a Quick Look-style layer
 * drawn for the fixed 400×740 window: filename + zoom + close bar on top, a
 * dot-grid stage with wheel-zoom and drag-pan in the middle, and a bottom
 * panel with metadata pills, a quiet delete and the two main actions
 * (在文件夹显示 / 复制图像). The two-column footer is what makes the narrow
 * window work — the old single row of four text buttons could not fit.
 *
 * Follows the system appearance: chrome on the surface/ink/line variables,
 * the stage on the .preview-stage pair (light dots on light, dark on dark).
 * Purely presentational: the gallery owns copy/reveal/delete and their
 * toasts. Escape and the ✕ button close; the zoom chip resets the view.
 */

import { useEffect, useRef, useState } from "react";
import { api, errorText, type GalleryItem } from "../lib/ipc";
import { IS_MAC } from "../lib/shortcut";
import {
  IconCopy,
  IconFolder,
  IconImage,
  IconMinus,
  IconPlus,
  IconTrash,
  IconX,
} from "./Icons";

type Props = {
  item: GalleryItem;
  /** Thumbnail, shown immediately while the full image decodes. */
  src: string | null;
  onClose: () => void;
  onCopy: () => void;
  onReveal: () => void;
  onDelete: () => void;
};

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.5;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toUpperCase();
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function Preview({ item, src, onClose, onCopy, onReveal, onDelete }: Props) {
  const [full, setFull] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  /** Optimistic "已复制" swap on the primary button. */
  const [copied, setCopied] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragStart = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // Full-resolution load (copy and zoom both need the original, not the
  // thumbnail); switching items also resets the view.
  useEffect(() => {
    let alive = true;
    setFull(null);
    setError(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    api
      .galleryFullImage(item.path)
      .then((url) => {
        if (alive) setFull(url);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [item.path]);

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Wheel zoom must be non-passive to stop the page scroll.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => clampZoom(z + (e.deltaY < 0 ? 0.15 : -0.15)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Drag-to-pan on the stage; the zoom pill inside must still work.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragStart.current = { px: e.clientX, py: e.clientY, x: pan.x, y: pan.y };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) return;
    setPan({ x: start.x + (e.clientX - start.px), y: start.y + (e.clientY - start.py) });
  };
  const endDrag = () => {
    dragStart.current = null;
    setDragging(false);
  };

  const handleCopy = () => {
    onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div
      className="fixed inset-0 z-modal-backdrop flex select-none flex-col bg-surface font-sans text-ink"
      role="presentation"
    >
      {/* Title bar: filename + zoom chip + close. macOS draws its traffic
          lights over this row, hence the wide gutter. */}
      <header
        className={`flex h-12 flex-none items-center justify-between gap-2 border-b border-line pr-4 ${
          IS_MAC ? "pl-[92px]" : "pl-4"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <IconImage size={15} className="flex-none color-ink-dim" />
          <span className="min-w-0 truncate text-xs font-500 color-ink" title={item.name}>
            {item.name}
          </span>
        </div>
        <div className="flex flex-none items-center gap-2">
          <button
            type="button"
            title="重置缩放"
            className="flex h-7 items-center rounded-md border border-line bg-surface-alt px-2 font-mono text-[11px] tabular-nums color-ink-dim transition hover:color-ink"
            onClick={resetView}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            title="关闭（Esc）"
            aria-label="关闭预览"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface-alt color-ink-dim transition hover:color-ink active:scale-90"
            onClick={onClose}
          >
            <IconX size={14} />
          </button>
        </div>
      </header>

      {/* Stage: dot-grid, image centred; wheel zooms, drag pans. */}
      <div
        ref={viewportRef}
        className={`preview-stage relative flex flex-1 touch-none items-center justify-center overflow-hidden p-3 ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="presentation"
      >
        <div
          className={`relative overflow-hidden rounded-xl border border-line bg-surface-alt shadow-2xl ${
            dragging ? "" : "transition-transform duration-150"
          }`}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <img
            className="block select-none object-contain"
            /* Sized against the window, not the shrink-wrapping wrapper, so a
               wide screenshot still letterboxes inside the 400px stage. */
            style={{ maxHeight: "min(60vh, 480px)", maxWidth: "calc(100vw - 48px)" }}
            src={full ?? src ?? ""}
            alt={item.name}
            draggable={false}
          />
        </div>
        {error && (
          <div className="absolute inset-x-0 bottom-3 text-center text-mini text-error-600 dark:text-error-400">
            {error}
          </div>
        )}

        {/* Floating zoom pill */}
        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-line bg-surface p-1 shadow-lg">
          <button
            type="button"
            title="缩小"
            aria-label="缩小"
            className="flex h-6 w-6 items-center justify-center rounded color-ink-dim transition hover:bg-surface-alt hover:color-ink active:scale-95"
            onClick={() => setZoom((z) => clampZoom(z - 0.25))}
          >
            <IconMinus size={13} />
          </button>
          <div className="h-3 w-px bg-line-strong" />
          <button
            type="button"
            title="放大"
            aria-label="放大"
            className="flex h-6 w-6 items-center justify-center rounded color-ink-dim transition hover:bg-surface-alt hover:color-ink active:scale-95"
            onClick={() => setZoom((z) => clampZoom(z + 0.25))}
          >
            <IconPlus size={13} />
          </button>
        </div>
      </div>

      {/* Bottom panel: metadata + quiet delete on top, two main actions below. */}
      <footer className="flex flex-none flex-col gap-2.5 border-t border-line bg-surface p-3.5">
        <div className="flex items-center justify-between px-1">
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] tabular-nums color-ink-dim">
            <span className="flex-none rounded border border-line bg-surface-alt px-2 py-0.5 font-500 color-ink">
              {item.width} × {item.height}
            </span>
            <span className="color-faint">•</span>
            <span className="flex-none">{extOf(item.name)}</span>
            <span className="color-faint">•</span>
            <span className="flex-none">{sizeLabel(item.bytes)}</span>
          </div>
          <button
            type="button"
            className="flex flex-none items-center gap-1 rounded px-2 py-1 text-xs font-500 color-ink-dim transition hover:bg-rose-500/10 hover:text-rose-500 active:scale-95"
            onClick={onDelete}
          >
            <IconTrash size={13} />
            删除
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-line bg-surface-alt text-xs font-500 color-ink transition hover:bg-hover active:scale-[0.98]"
            onClick={onReveal}
          >
            <IconFolder size={14} className="color-ink-dim" />
            在文件夹显示
          </button>
          <button
            type="button"
            className={`flex h-10 items-center justify-center gap-1.5 rounded-xl border border-transparent text-xs font-500 transition active:scale-[0.98] ${
              copied
                ? "bg-emerald-600 text-white hover:bg-emerald-500"
                : "bg-primary-500 text-white hover:bg-primary-600 dark:bg-neutral-200 dark:hover:bg-white dark:text-neutral-900"
            }`}
            onClick={handleCopy}
          >
            <IconCopy size={14} />
            {copied ? "已复制 ✓" : "复制图像"}
          </button>
        </div>
      </footer>
    </div>
  );
}
