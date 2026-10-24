/**
 * Full-size screenshot preview shown over the gallery.
 *
 * Loads the original PNG (not the thumbnail) so zoomed inspection and "copy
 * image" both use full resolution. Escape closes; so does a click outside the
 * image.
 */

import { useEffect, useState } from "react";
import { api, errorText, type GalleryItem } from "../lib/ipc";

type Props = {
  item: GalleryItem;
  /** Thumbnail, shown immediately while the full image decodes. */
  src: string | null;
  onClose: () => void;
  onCopy: () => void;
  onReveal: () => void;
  onDelete: () => void;
};

/* Footer buttons share one 32px/6px tier; hierarchy comes from fill — the
   highest-frequency action is the solid primary, the rest outline, and 删除
   inverts to black on hover instead of carrying red. */
const btnBase =
  "inline-flex h-8 flex-none items-center justify-center gap-1.5 rounded-md border px-3.5 text-[13px] font-500 transition outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40";
const btnPrimary = `${btnBase} border-transparent bg-primary-500 text-white hover:bg-primary-600`;
const btnSecondary = `${btnBase} border-neutral-300 bg-base color-base hover:bg-hover hover:border-neutral-400`;
const btnDanger = `${btnBase} border-neutral-300 bg-base font-600 color-base hover:bg-primary-500 hover:border-primary-500 hover:text-white`;

export function Preview({ item, src, onClose, onCopy, onReveal, onDelete }: Props) {
  const [full, setFull] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setFull(null);
    setError(null);
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

  return (
    <div
      className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-black/60 p-6 backdrop-blur-2"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-full max-w-full flex-col overflow-hidden rounded-xl border border-base bg-base shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        <div className="flex min-h-0 flex-1 items-center justify-center bg-#0d0f13 p-3">
          <img
            className="block max-h-[calc(100vh-200px)] max-w-full object-contain"
            src={full ?? src ?? ""}
            alt={item.name}
            draggable={false}
          />
          {error && <div className="p-3 text-mini text-error-300">{error}</div>}
        </div>
        <footer className="flex h-16 flex-none items-center justify-between gap-4 border-t border-base px-6">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[13px] font-500 color-base">{item.name}</span>
            <span className="font-mono text-micro tabular-nums color-faint">
              {item.width}×{item.height}
            </span>
          </div>
          <div className="flex flex-none items-center gap-3">
            <button type="button" className={btnPrimary} onClick={onCopy}>
              复制
            </button>
            <button type="button" className={btnSecondary} onClick={onReveal}>
              在文件夹中显示
            </button>
            <button type="button" className={btnDanger} onClick={onDelete}>
              删除
            </button>
            <button type="button" className={btnSecondary} onClick={onClose}>
              关闭
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
