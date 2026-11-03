/**
 * Full-size screenshot preview over the gallery — a dark, Quick Look-style
 * layer drawn for the fixed 400×740 window: filename + zoom + close bar on
 * top, a dot-grid viewport with wheel-zoom and drag-pan in the middle, and a
 * bottom panel with metadata pills, a quiet delete and the two main actions
 * (在文件夹显示 / 复制图像). The two-column footer is what makes the narrow
 * window work — the old single row of four text buttons could not fit.
 *
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

  // Drag-to-pan on the viewport; the zoom pill inside must still work.
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
      className="fixed inset-0 z-modal-backdrop flex select-none flex-col bg-[#101113] font-sans text-zinc-100"
      role="presentation"
    >
      {/* Title bar: filename + zoom chip + close. macOS draws its traffic
          lights over this row, hence the wide gutter. */}
      <header
        className={`flex h-12 flex-none items-center justify-between gap-2 border-b border-white/[0.08] bg-white/[0.02] pr-4 ${
          IS_MAC ? "pl-[92px]" : "pl-4"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <IconImage size={15} className="flex-none text-zinc-400" />
          <span className="min-w-0 truncate text-xs font-500 text-zinc-200" title={item.name}>
            {item.name}
          </span>
        </div>
        <div className="flex flex-none items-center gap-2">
          <button
            type="button"
            title="重置缩放"
            className="flex h-7 items-center rounded-md border border-white/[0.06] bg-white/[0.05] px-2 font-mono text-[11px] tabular-nums text-zinc-400 transition hover:bg-white/[0.1] hover:text-zinc-200"
            onClick={resetView}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            title="关闭（Esc）"
            aria-label="关闭预览"
            className="flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.08] text-zinc-300 transition hover:bg-white/[0.16] hover:text-white active:scale-90"
            onClick={onClose}
          >
            <IconX size={14} />
          </button>
        </div>
      </header>

      {/* Viewport: dot-grid dark stage, image centred; wheel zooms, drag pans. */}
      <div
        ref={viewportRef}
        className={`relative flex flex-1 touch-none items-center justify-center overflow-hidden p-3 ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        style={{
          backgroundColor: "#121316",
          backgroundImage: "radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="presentation"
      >
        <div
          className={`relative overflow-hidden rounded-xl border border-white/[0.12] bg-[#1a1b20] shadow-2xl ${
            dragging ? "" : "transition-transform duration-150"
          }`}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <img
            className="block select-none object-contain"
            /* Sized against the window, not the shrink-wrapping wrapper, so a
               wide screenshot still letterboxes inside the 400px viewport. */
            style={{ maxHeight: "min(60vh, 480px)", maxWidth: "calc(100vw - 48px)" }}
            src={full ?? src ?? ""}
            alt={item.name}
            draggable={false}
          />
        </div>
        {error && <div className="absolute inset-x-0 bottom-3 text-center text-mini text-error-300">{error}</div>}

        {/* Floating zoom pill */}
        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-900/85 p-1 shadow-lg backdrop-blur-md">
          <button
            type="button"
            title="缩小"
            aria-label="缩小"
            className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100 active:scale-95"
            onClick={() => setZoom((z) => clampZoom(z - 0.25))}
          >
            <IconMinus size={13} />
          </button>
          <div className="h-3 w-px bg-white/10" />
          <button
            type="button"
            title="放大"
            aria-label="放大"
            className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100 active:scale-95"
            onClick={() => setZoom((z) => clampZoom(z + 0.25))}
          >
            <IconPlus size={13} />
          </button>
        </div>
      </div>

      {/* Bottom panel: metadata + quiet delete on top, two main actions below. */}
      <footer className="flex flex-none flex-col gap-2.5 border-t border-white/[0.08] bg-[#141519] p-3.5">
        <div className="flex items-center justify-between px-1">
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] tabular-nums text-zinc-400">
            <span className="flex-none rounded border border-white/[0.06] bg-white/[0.06] px-2 py-0.5 font-500 text-zinc-200">
              {item.width} × {item.height}
            </span>
            <span className="text-zinc-600">•</span>
            <span className="flex-none">{extOf(item.name)}</span>
            <span className="text-zinc-600">•</span>
            <span className="flex-none">{sizeLabel(item.bytes)}</span>
          </div>
          <button
            type="button"
            className="flex flex-none items-center gap-1 rounded px-2 py-1 text-xs font-500 text-zinc-400 transition hover:bg-rose-500/10 hover:text-rose-400 active:scale-95"
            onClick={onDelete}
          >
            <IconTrash size={13} />
            删除
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.06] text-xs font-500 text-zinc-200 transition hover:bg-white/[0.1] active:scale-[0.98]"
            onClick={onReveal}
          >
            <IconFolder size={14} className="text-zinc-400" />
            在文件夹显示
          </button>
          <button
            type="button"
            className={`flex h-10 items-center justify-center gap-1.5 rounded-xl border border-transparent text-xs font-500 text-white shadow-lg transition active:scale-[0.98] ${
              copied
                ? "bg-emerald-600 hover:bg-emerald-500"
                : "bg-primary-500 hover:bg-primary-600"
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
