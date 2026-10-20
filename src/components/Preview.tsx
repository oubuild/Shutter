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
      className="preview-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div className="preview-card" onClick={(e) => e.stopPropagation()} role="presentation">
        <div className="preview-stage">
          <img src={full ?? src ?? ""} alt={item.name} draggable={false} />
          {error && <div className="preview-error">{error}</div>}
        </div>
        <footer className="preview-bar">
          <div className="preview-meta">
            <span className="preview-name">{item.name}</span>
            <span className="preview-dims">
              {item.width}×{item.height}
            </span>
          </div>
          <div className="preview-actions">
            <button type="button" onClick={onCopy}>
              复制
            </button>
            <button type="button" onClick={onReveal}>
              在文件夹中显示
            </button>
            <button type="button" className="danger" onClick={onDelete}>
              删除
            </button>
            <button type="button" className="primary" onClick={onClose}>
              关闭
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
