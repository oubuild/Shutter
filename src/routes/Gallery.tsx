/**
 * Screenshot gallery: every capture in the save directory, grouped by day.
 *
 * The listing comes from Rust, which is the only place that knows the save
 * directory and the file-name contract. Thumbnails are fetched lazily per item
 * as a data URL; the backend caches them on disk, so a refresh is cheap.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type GalleryItem } from "../lib/ipc";
import { Preview } from "../components/Preview";
import { Confirm } from "../components/Confirm";

type Props = {
  /** Bumped by the shell when a capture finishes, to force a reload. */
  reloadKey?: number;
};

/** `2026-10-19` → `今天` / `昨天` / `10-19`. */
function dayLabel(epochSecs: number): string {
  const date = new Date(epochSecs * 1000);
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(date)) / 86_400_000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  if (date.getFullYear() === today.getFullYear()) return `${mm}-${dd}`;
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function timeLabel(epochSecs: number): string {
  const date = new Date(epochSecs * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Stable grouping key: the local calendar day. */
function dayKey(epochSecs: number): string {
  const date = new Date(epochSecs * 1000);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function Gallery({ reloadKey = 0 }: Props) {
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dir, setDir] = useState<string | null>(null);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GalleryItem | null>(null);
  const [menu, setMenu] = useState<{ item: GalleryItem; x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Thumbnails are fetched one by one; this ref prevents a second request for
  // an item that is already in flight during a re-render.
  const inFlight = useRef(new Set<string>());

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.listGallery();
      setItems(list);
      // Kick off thumbnail loads for items we do not have yet. Failures are
      // per-item and non-fatal: the card falls back to a placeholder.
      setThumbs((prev) => {
        for (const item of list) {
          if (prev[item.path] || inFlight.current.has(item.path)) continue;
          inFlight.current.add(item.path);
          api
            .galleryThumbnail(item.path)
            .then((url) => setThumbs((now) => ({ ...now, [item.path]: url })))
            .catch(() => undefined)
            .finally(() => inFlight.current.delete(item.path));
        }
        return prev;
      });
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  useEffect(() => {
    api
      .saveDirectory()
      .then(setDir)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Dismiss the context menu on any outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const groups = useMemo(() => {
    if (!items) return [];
    const byDay = new Map<string, GalleryItem[]>();
    for (const item of items) {
      const key = dayKey(item.createdAt);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(item);
      else byDay.set(key, [item]);
    }
    return Array.from(byDay.values());
  }, [items]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      // Drop cached thumbnails so a file changed on disk re-renders.
      setThumbs({});
      inFlight.current.clear();
      await load();
      setToast("已刷新");
    } finally {
      setBusy(false);
    }
  }, [load]);

  const openFolder = useCallback(async () => {
    if (!dir) return;
    try {
      await api.openDirectory(dir);
    } catch (e) {
      setToast(`打开失败：${errorText(e)}`);
    }
  }, [dir]);

  const confirmDelete = useCallback(async () => {
    const item = pendingDelete;
    if (!item) return;
    setPendingDelete(null);
    try {
      await api.deleteGalleryItem(item.path);
      setItems((prev) => (prev ? prev.filter((i) => i.path !== item.path) : prev));
      setThumbs((prev) => {
        const next = { ...prev };
        delete next[item.path];
        return next;
      });
      if (preview?.path === item.path) setPreview(null);
      setToast("已删除");
    } catch (e) {
      setToast(`删除失败：${errorText(e)}`);
    }
  }, [pendingDelete, preview]);

  const copyItem = useCallback(async (item: GalleryItem) => {
    try {
      // Read the original file, not the thumbnail: pasting a 480px preview
      // would silently downgrade the user's screenshot.
      const url = await api.galleryFullImage(item.path);
      const blob = await (await fetch(url)).blob();
      const Ctor = typeof ClipboardItem === "undefined" ? null : ClipboardItem;
      if (Ctor === null || typeof navigator.clipboard?.write !== "function") {
        setToast("当前环境不支持写入图片剪贴板");
        return;
      }
      await navigator.clipboard.write([new Ctor({ "image/png": blob })]);
      setToast("已复制到剪贴板");
    } catch (e) {
      setToast(`复制失败：${errorText(e)}`);
    }
  }, []);

  const reveal = useCallback(async (item: GalleryItem) => {
    try {
      await api.revealPath(item.path);
    } catch (e) {
      setToast(`打开失败：${errorText(e)}`);
    }
  }, []);

  const openMenu = useCallback((event: React.MouseEvent, item: GalleryItem) => {
    event.preventDefault();
    event.stopPropagation();
    // Clamp so a right-click near the edge still shows a fully visible menu.
    const width = 168;
    const height = 132;
    setMenu({
      item,
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8),
    });
  }, []);

  return (
    <div className="gallery">
      <header className="gallery-header">
        <div className="gallery-heading">
          <h1>图库</h1>
          <span className="gallery-count">
            {items === null ? "加载中…" : items.length === 0 ? "还没有截图" : `${items.length} 张截图`}
          </span>
        </div>
        <div className="gallery-actions">
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            {busy ? "刷新中…" : "刷新"}
          </button>
          <button type="button" onClick={() => void openFolder()} disabled={!dir}>
            打开文件夹
          </button>
        </div>
      </header>

      {error && <div className="gallery-error">{error}</div>}

      <div className="gallery-scroll">
        {items !== null && items.length === 0 && !error && (
          <div className="gallery-empty">
            <div className="gallery-empty-title">还没有截图</div>
            <div className="gallery-empty-hint">
              按 ⌘⇧A 截图，完成后会自动出现在这里。
              {dir && <div className="gallery-empty-dir">{dir}</div>}
            </div>
          </div>
        )}

        {groups.map((group) => (
          <section key={dayKey(group[0].createdAt)} className="gallery-day">
            <div className="gallery-day-label">{dayLabel(group[0].createdAt)}</div>
            <div className="gallery-grid">
              {group.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className="thumb"
                  title={`${item.name}\n${item.width}×${item.height} · ${sizeLabel(item.bytes)}`}
                  onClick={() => setPreview(item)}
                  onContextMenu={(e) => openMenu(e, item)}
                >
                  {thumbs[item.path] ? (
                    <img src={thumbs[item.path]} alt="" draggable={false} />
                  ) : (
                    <div className="thumb-placeholder" />
                  )}
                  <span className="thumb-time">{timeLabel(item.createdAt)}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      {toast && <div className="gallery-toast">{toast}</div>}

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <button type="button" onClick={() => setPreview(menu.item)}>
            预览
          </button>
          <button type="button" onClick={() => void copyItem(menu.item)}>
            复制图片
          </button>
          <button type="button" onClick={() => void reveal(menu.item)}>
            在文件夹中显示
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => setPendingDelete(menu.item)}
          >
            删除…
          </button>
        </div>
      )}

      {preview && (
        <Preview
          item={preview}
          src={thumbs[preview.path] ?? null}
          onClose={() => setPreview(null)}
          onCopy={() => void copyItem(preview)}
          onReveal={() => void reveal(preview)}
          onDelete={() => setPendingDelete(preview)}
        />
      )}

      {pendingDelete && (
        <Confirm
          title="删除截图"
          message={`确定要删除 ${pendingDelete.name} 吗？此操作不可撤销。`}
          confirmLabel="删除"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}
