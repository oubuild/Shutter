import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type SyntheticEvent,
} from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { api, errorText } from "../lib/ipc";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.1;
const HINT_MS = 2200;

const centered: Readonly<Record<string, string | number>> = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 12,
  textAlign: "center",
  fontSize: 12,
  color: "#e6e9ef",
  background: "rgba(22, 24, 29, 0.9)",
  overflow: "hidden",
};

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 10) / 10));
}

/** Floating always-on-top pin window: show a captured crop, drag, zoom, copy, save. */
export function Pin({ pinId }: { pinId: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const baseRef = useRef<{ width: number; height: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hintTimer = useRef<number | null>(null);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), HINT_MS);
  }, []);

  const close = useCallback(async () => {
    try {
      await api.closePin(pinId);
    } catch (e: unknown) {
      showHint(`关闭失败：${errorText(e)}`);
    }
  }, [pinId, showHint]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    };
  }, [close]);

  useEffect(() => {
    if (pinId === "") {
      setError("缺少截图 ID");
      return;
    }
    let cancelled = false;
    api
      .cropDataUrl(pinId)
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [pinId]);

  const copy = useCallback(async () => {
    try {
      if (dataUrl === null) return;
      const Ctor = typeof ClipboardItem === "undefined" ? null : ClipboardItem;
      const clipboard = navigator.clipboard;
      if (Ctor === null || clipboard === undefined || typeof clipboard.write !== "function") {
        showHint("当前环境不支持写入图片剪贴板");
        return;
      }
      const blob = await (await fetch(dataUrl)).blob();
      await clipboard.write([new Ctor({ "image/png": blob })]);
      showHint("已复制到剪贴板");
    } catch (e: unknown) {
      showHint(`复制失败：${errorText(e)}`);
    }
  }, [dataUrl, showHint]);

  const save = useCallback(async () => {
    try {
      const path = await api.saveCrop(pinId);
      showHint(path === "" ? "已保存" : path);
    } catch (e: unknown) {
      showHint(`保存失败：${errorText(e)}`);
    }
  }, [pinId, showHint]);

  const onImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight)) return;
    if (naturalWidth <= 0 || naturalHeight <= 0) return;
    baseRef.current = { width: naturalWidth, height: naturalHeight };
  }, []);

  // React binds wheel listeners passively, so handle it natively to preventDefault.
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const dir = Math.sign(event.deltaY);
      const base = baseRef.current;
      if (dir === 0 || base === null) return;
      const next = clampZoom(zoom - dir * ZOOM_STEP);
      if (next === zoom) return;
      const width = Math.round(base.width * next);
      const height = Math.round(base.height * next);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      getCurrentWindow()
        .setSize(new LogicalSize(width, height))
        .catch((e: unknown) => showHint(`缩放失败：${errorText(e)}`));
      setZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, dataUrl, showHint]);

  const onMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest(".pin-toolbar") !== null) return;
      if (target !== event.currentTarget && !(target instanceof HTMLImageElement)) return;
      event.preventDefault();
      getCurrentWindow()
        .startDragging()
        .catch((e: unknown) => showHint(errorText(e)));
    },
    [showHint],
  );

  if (error !== null) {
    return <div className="pin-root"><div style={centered}>{error}</div></div>;
  }
  if (dataUrl === null) return null;

  return (
    <div className="pin-root" ref={rootRef} onMouseDown={onMouseDown}>
      <img src={dataUrl} alt="" draggable={false} onLoad={onImageLoad} onDoubleClick={() => void close()} />
      <div className="pin-toolbar" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={() => void copy()}>复制</button>
        <button type="button" onClick={() => void save()}>保存</button>
        <button type="button" onClick={() => void close()}>关闭</button>
      </div>
      {hint !== null && <div className="pin-hint">{hint}</div>}
    </div>
  );
}
