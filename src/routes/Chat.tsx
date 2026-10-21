/**
 * Shutter AI window — the screenshot-centric assistant.
 *
 * The overlay opens it with `?view=chat&crop=<id>`; the PNG stays in Rust
 * (only a preview data URL enters the webview) and answers stream in over
 * `ai://delta` / `ai://done`, matched by `requestId`. Extract results land in
 * the dedicated recognition card; every other action joins the conversation.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Confirm } from "../components/Confirm";
import {
  api,
  errorText,
  events,
  type AiAction,
  type AiRequest,
  type Settings,
} from "../lib/ipc";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Set on assistant placeholders so stream events can find their message. */
  requestId?: string;
  action?: AiAction;
  streaming?: boolean;
  error?: string;
};

type OcrState = {
  status: "idle" | "streaming" | "done" | "error";
  text: string;
  error?: string;
  /** Live request owning the card; cleared once the stream settles. */
  requestId?: string;
};

const IDLE_OCR: OcrState = { status: "idle", text: "" };

/** Secondary toolbar actions. "extract" is the primary button, "ask" lives in the input box. */
const ACTIONS: ReadonlyArray<{ action: AiAction; label: string }> = [
  { action: "translate", label: "翻译" },
  { action: "explain", label: "解释" },
  { action: "reply", label: "回复建议" },
];

const EMPTY_HINT = "请先截图，再从工具条打开 AI 助手";
const DEFAULT_LANG = "简体中文";
/** Stay pinned only while the user is this close to the bottom. */
const BOTTOM_SLACK = 80;
/** The ± buttons walk this ladder, so labels stay round (50%, 75%, 100%…). */
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** The input box grows with its content up to this height, then scrolls. */
const INPUT_MAX_HEIGHT = 160;

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CaptureIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="3.75" width="12.5" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5.75 3.75l.8-1.5h2.9l.8 1.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8.5" r="2.4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function Chat() {
  const initialCrop = new URLSearchParams(window.location.search).get("crop") ?? "";

  const [cropId, setCropId] = useState(initialCrop);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [ocr, setOcr] = useState<OcrState>(IDLE_OCR);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [conn, setConn] = useState<{ state: "checking" | "ok" | "fail"; detail: string }>({
    state: "checking",
    detail: "正在检查连接…",
  });
  const [models, setModels] = useState<string[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const modelRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const ocrBodyRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const startRef = useRef<((action: AiAction, cropOverride?: string) => void) | null>(null);

  const busy = activeId !== null || ocr.status === "streaming";
  const canAsk = cropId !== "" && !busy;

  const appendError = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `error-${crypto.randomUUID()}`, role: "assistant", text: "", error: text },
    ]);
  }, []);

  const checkConnection = useCallback((s: Settings) => {
    if (s.baseUrl.trim() === "") {
      setConn({ state: "fail", detail: "未配置服务地址，请前往设置" });
      return;
    }
    setConn({ state: "checking", detail: "正在检查连接…" });
    api
      .testConnection(s.baseUrl, s.model, null)
      .then((r) => setConn({ state: r.ok ? "ok" : "fail", detail: r.detail }))
      .catch((e: unknown) => setConn({ state: "fail", detail: errorText(e) }));
  }, []);

  /* Endpoint-advertised models first; presets fill in when /models is absent. */
  const refreshModels = useCallback((s: Settings) => {
    if (s.baseUrl.trim() === "") return;
    api
      .listModels(s.baseUrl, null)
      .then(async (list) => {
        if (list.length > 0) {
          setModels([...list].sort());
          return;
        }
        const presets = await api.modelPresets().catch(() => []);
        setModels([...new Set(presets.map((p) => p.model))].sort());
      })
      .catch(() => undefined);
  }, []);

  /* Thumbnail for this window's crop, plus model/connection state for the toolbar. */
  useEffect(() => {
    let cancelled = false;
    const fail = (e: unknown) => {
      if (!cancelled) appendError(errorText(e));
    };
    api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
        checkConnection(s);
        refreshModels(s);
      })
      .catch(fail);
    if (cropId) api.cropDataUrl(cropId).then((url) => { if (!cancelled) setPreview(url); }).catch(fail);
    return () => {
      cancelled = true;
    };
  }, [cropId, appendError, checkConnection, refreshModels]);

  /* Stream listeners, registered once for the life of the window. Extract
     requests route into the OCR card, everything else into the conversation. */
  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const on = (p: Promise<() => void>) =>
      p
        .then((off) => (disposed ? off() : unlisten.push(off)))
        .catch((e: unknown) => appendError(errorText(e)));

    // Append into the stored buffers via functional updates, never stale state.
    const delta = events.onAiDelta(({ requestId, text }) => {
      setOcr((prev) =>
        prev.requestId === requestId && prev.status === "streaming"
          ? { ...prev, text: prev.text + text }
          : prev,
      );
      setMessages((prev) => {
        const index = prev.findIndex((m) => m.requestId === requestId && m.streaming);
        if (index < 0) return prev;
        const next = prev.slice();
        next[index] = { ...next[index], text: next[index].text + text };
        return next;
      });
    });
    const done = events.onAiDone(({ requestId, ok, error }) => {
      setOcr((prev) =>
        prev.requestId === requestId && prev.status === "streaming"
          ? ok
            ? { ...prev, status: "done", requestId: undefined }
            : { ...prev, status: "error", error: error ?? "识别失败", requestId: undefined }
          : prev,
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.requestId === requestId
            ? { ...m, streaming: false, error: ok ? undefined : (error ?? "生成失败") }
            : m,
        ),
      );
      setActiveId((prev) => (prev === requestId ? null : prev));
    });
    on(delta);
    on(done);

    return () => {
      disposed = true;
      unlisten.forEach((off) => off());
    };
  }, [appendError]);

  /* A new screenshot handed to this window re-binds it without losing the
     conversation; the recognition card resets since it belongs to the crop.
     Rust replays the bind ~700ms later so a window that was still loading
     catches it, and that replay must be a no-op: resetting on it would wipe a
     recognition stream the first bind had just started. */
  const boundCropRef = useRef(initialCrop);
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    events
      .onAiBind(({ cropId: next, action }) => {
        if (disposed) return;
        const rebind = boundCropRef.current !== next;
        boundCropRef.current = next;
        setCropId(next);
        if (!rebind) return;
        // Clear the preview immediately so an old crop is never shown as current.
        setPreview(null);
        setNatural(null);
        setOcr(IDLE_OCR);
        setEditing(false);
        setZoom("fit");
        api.cropDataUrl(next).then((url) => { if (!disposed) setPreview(url); }).catch(() => undefined);
        if (action) {
          // The toolbar already told us what the user wants; run it right away.
          window.setTimeout(() => {
            if (!disposed) startRef.current?.(action, next);
          }, 60);
        }
      })
      .then((fn) => (disposed ? fn() : (off = fn)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  /* Auto-scroll only when the user was already near the bottom. */
  useEffect(() => {
    const el = logRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* The box also has to re-measure when the window narrows: the placeholder
     wraps to two lines and a fixed 36px box would clip it. */
  const syncInputHeight = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
  }, []);

  useEffect(() => {
    syncInputHeight();
  }, [input, syncInputHeight]);

  useEffect(() => {
    window.addEventListener("resize", syncInputHeight);
    return () => window.removeEventListener("resize", syncInputHeight);
  }, [syncInputHeight]);

  /* Follow the stream inside the recognition card: without this the newest
     tokens land below the fold and the card looks frozen mid-answer. On wide
     layouts the card grows with its content instead of scrolling, so the outer
     column has to follow too — but only if the user was already at the bottom. */
  useEffect(() => {
    if (ocr.status !== "streaming") return;
    const body = ocrBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
    const log = logRef.current;
    if (log && stickToBottom.current) log.scrollTop = log.scrollHeight;
  }, [ocr.status, ocr.text]);

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /* Dismiss the dropdowns on any click outside them. */
  useEffect(() => {
    if (!modelOpen && !moreOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (modelOpen && modelRef.current && !modelRef.current.contains(target)) setModelOpen(false);
      if (moreOpen && moreRef.current && !moreRef.current.contains(target)) setMoreOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [modelOpen, moreOpen]);

  function handleScroll() {
    const el = logRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
  }

  function start(action: AiAction, cropOverride?: string) {
    const targetCrop = cropOverride ?? cropId;
    if (!targetCrop || busy) return;
    const question = input.trim();
    if (action === "ask" && question === "") return;

    const requestId = crypto.randomUUID();
    const request: AiRequest = { cropId: targetCrop, action };
    if (action === "translate") request.lang = settings?.translateLang || DEFAULT_LANG;
    if (action === "ask") request.question = question;

    setActiveId(requestId);
    setToast(null);
    if (action === "extract") {
      setOcr({ status: "streaming", text: "", requestId });
    } else {
      const assistant: Message = {
        id: requestId,
        role: "assistant",
        text: "",
        requestId,
        action,
        streaming: true,
      };
      setMessages((prev) =>
        action === "ask"
          ? [...prev, { id: `user-${requestId}`, role: "user", text: question }, assistant]
          : [...prev, assistant],
      );
      if (action === "ask") setInput("");
    }

    api.aiAsk(request, requestId).catch((e: unknown) => {
      const text = errorText(e);
      if (action === "extract") {
        setOcr({ status: "error", text: "", error: text });
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.requestId === requestId ? { ...m, streaming: false, error: m.error ?? text } : m,
          ),
        );
      }
      setActiveId((prev) => (prev === requestId ? null : prev));
    });
  }

  useEffect(() => {
    startRef.current = start;
  });

  function copy(text: string) {
    api.copyText(text).catch((e: unknown) => appendError(errorText(e)));
  }

  async function copyImage() {
    if (preview === null) return;
    try {
      const blob = await (await fetch(preview)).blob();
      const Ctor = typeof ClipboardItem === "undefined" ? null : ClipboardItem;
      if (Ctor === null || typeof navigator.clipboard?.write !== "function") {
        setToast("当前环境不支持写入图片剪贴板");
        return;
      }
      await navigator.clipboard.write([new Ctor({ "image/png": blob })]);
      setToast("图片已复制到剪贴板");
    } catch (e: unknown) {
      setToast(`复制失败：${errorText(e)}`);
    }
  }

  function saveImage() {
    api
      .saveCrop(cropId)
      .then((path) => setToast(`已保存：${path}`))
      .catch((e: unknown) => appendError(errorText(e)));
  }

  function newCapture() {
    api.captureScreens().catch((e: unknown) => setToast(`截图失败：${errorText(e)}`));
  }

  function openSettings() {
    setModelOpen(false);
    setMoreOpen(false);
    api.openSettings().catch((e: unknown) => appendError(errorText(e)));
  }

  function pickModel(model: string) {
    setModelOpen(false);
    if (!settings || model === settings.model) return;
    const next = { ...settings, model };
    setSettings(next);
    api
      .saveSettings(next)
      .then(() => checkConnection(next))
      .catch((e: unknown) => setToast(`保存模型失败：${errorText(e)}`));
  }

  /** Scale the preview is actually drawn at, so ± steps from 适应 by one notch. */
  function fitScale(): number {
    const box = previewBoxRef.current;
    if (!box || natural === null) return 1;
    return Math.min(box.clientWidth / natural.w, box.clientHeight / natural.h);
  }

  function zoomBy(direction: 1 | -1) {
    const base = zoom === "fit" ? fitScale() : zoom;
    // Snap to the ladder: pick the next rung past the current scale, so 适应
    // followed by ＋ lands on a round label instead of 57%.
    const next =
      direction > 0
        ? ZOOM_STEPS.find((step) => step > base + 0.001)
        : [...ZOOM_STEPS].reverse().find((step) => step < base - 0.001);
    if (next !== undefined) setZoom(next);
  }

  function beginEdit() {
    setEditDraft(ocr.text);
    setEditing(true);
  }

  function saveEdit() {
    const draft = editDraft.trim();
    if (draft !== "") setOcr((prev) => ({ ...prev, text: editDraft }));
    setEditing(false);
  }

  function clearLog() {
    setMessages([]);
    setToast(null);
    stickToBottom.current = true;
  }

  const zoomLabel = zoom === "fit" ? "适应" : `${Math.round(zoom * 100)}%`;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface text-[13px] color-ink">
      {/* AI toolbar: primary extract + secondary actions, model, connection, capture ops */}
      <header className="flex flex-none items-center gap-2 border-b border-line px-4 py-3">
        <button
          className="ai-btn-primary"
          disabled={!canAsk}
          onClick={() => start("extract")}
        >
          提取文字
        </button>
        {ACTIONS.map(({ action, label }) => (
          <button
            key={action}
            className="ai-btn max-[639px]:hidden"
            disabled={!canAsk}
            onClick={() => start(action)}
          >
            {label}
          </button>
        ))}
        {/* Narrow windows fold the secondary actions (and 清空) into this menu. */}
        <div ref={moreRef} className="relative min-[640px]:hidden">
          <button
            className="ai-btn w-9 justify-center px-0"
            disabled={!canAsk && messages.length === 0}
            aria-label="更多操作"
            onClick={() => setMoreOpen((v) => !v)}
          >
            ⋯
          </button>
          {moreOpen && (
            <div className="absolute left-0 top-full z-dropdown mt-1.5 w-36 rounded-lg border border-line bg-surface py-1 shadow-lg">
              {ACTIONS.map(({ action, label }) => (
                <button
                  key={action}
                  className="block w-full px-3 py-1.5 text-left transition hover:bg-surface-alt disabled:op-40"
                  disabled={!canAsk}
                  onClick={() => {
                    setMoreOpen(false);
                    start(action);
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                className="block w-full border-t border-line px-3 py-1.5 text-left transition hover:bg-surface-alt disabled:op-40"
                disabled={messages.length === 0}
                onClick={() => {
                  setMoreOpen(false);
                  setConfirmClear(true);
                }}
              >
                清空对话
              </button>
            </div>
          )}
        </div>

        <span className="flex-1" />

        {/* Model selector; without a base URL it just opens settings. */}
        <div ref={modelRef} className="relative min-w-0">
          <button
            className="ai-btn min-w-0 max-w-[180px] max-[559px]:max-w-[110px]"
            disabled={settings === null}
            title={
              settings !== null && settings.baseUrl.trim() === ""
                ? "未配置服务地址，点击前往设置"
                : "选择模型"
            }
            onClick={() =>
              settings !== null && settings.baseUrl.trim() === ""
                ? openSettings()
                : setModelOpen((v) => !v)
            }
          >
            <span className="truncate">{settings?.model ?? "…"}</span>
            <ChevronDownIcon />
          </button>
          {modelOpen && (
            <div className="absolute right-0 top-full z-dropdown mt-1.5 max-h-64 w-60 overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-lg">
              {models.length === 0 ? (
                <div className="px-3 py-2 color-ink-dim">未获取到模型列表</div>
              ) : (
                models.map((m) => (
                  <button
                    key={m}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-surface-alt"
                    onClick={() => pickModel(m)}
                  >
                    <span className="w-3.5 flex-none text-primary-500">
                      {settings?.model === m ? "✓" : ""}
                    </span>
                    <span className="truncate">{m}</span>
                  </button>
                ))
              )}
              <button
                className="mt-0.5 w-full border-t border-line px-3 py-1.5 text-left text-mini color-ink-dim transition hover:bg-surface-alt hover:color-ink"
                onClick={() => settings !== null && refreshModels(settings)}
              >
                刷新模型列表
              </button>
            </div>
          )}
        </div>

        {/* Connection status: click to re-probe. */}
        <button
          className="flex h-9 flex-none items-center gap-1.5 rounded-lg px-1.5 transition hover:bg-surface-alt"
          title={`${conn.detail}（点击重新检查）`}
          onClick={() => settings !== null && checkConnection(settings)}
        >
          <span
            className={`inline-block h-2 w-2 flex-none rounded-full ${
              conn.state === "ok"
                ? "bg-success-500"
                : conn.state === "fail"
                  ? "bg-error-500"
                  : "bg-neutral-400 motion-safe:animate-pulse"
            }`}
          />
          <span className="text-mini color-ink-dim max-[699px]:hidden">
            {conn.state === "ok" ? "已连接" : conn.state === "fail" ? "未连接" : "检查中"}
          </span>
        </button>

        <button className="ai-iconbtn" title="新建截图" disabled={busy} onClick={newCapture}>
          <CaptureIcon />
        </button>
        <button
          className="h-9 flex-none rounded-lg px-2.5 transition hover:bg-surface-alt hover:color-ink disabled:pointer-events-none disabled:op-40 max-[639px]:hidden"
          disabled={messages.length === 0}
          onClick={() => setConfirmClear(true)}
        >
          清空
        </button>
      </header>

      {/* Scrollable content; the input dock below never gets covered. */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
        ref={logRef}
        onScroll={handleScroll}
      >
        {cropId === "" ? (
          <div className="m-auto flex flex-col items-center gap-3 text-center">
            <div className="leading-7 color-faint">{EMPTY_HINT}</div>
            <button className="ai-btn-primary" onClick={newCapture}>
              新建截图
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-4 min-[900px]:flex-row min-[900px]:items-stretch">
              {/* Current screenshot: preview, zoom, copy, save */}
              <section className="ai-card min-[900px]:flex-1">
                <header className="ai-card-head">
                  <span className="ai-card-title">截图</span>
                  {natural !== null && (
                    <span className="text-mini tabular-nums color-ink-dim">
                      {natural.w} × {natural.h}
                    </span>
                  )}
                  <span className="flex-1" />
                  <button className="ai-headbtn" disabled={preview === null} onClick={copyImage}>
                    复制
                  </button>
                  <button className="ai-headbtn" onClick={saveImage}>
                    保存
                  </button>
                </header>
                {/* `flex-1` from 900px up: the two cards are stretched to the
                    same height there, and a fixed 320px preview would leave a
                    bare grey band under a taller recognition card. */}
                <div className="relative h-[240px] flex-1 min-h-[240px] bg-surface-alt min-[900px]:min-h-[320px]">
                  {/* Scroller is its own layer so the zoom pill can stay pinned
                      to the card instead of scrolling away with the image.
                      `safe center` keeps the image centred while it fits and
                      pins it to the start edge once it overflows — plain
                      centring would push both edges out of scroll range. */}
                  <div
                    ref={previewBoxRef}
                    className="flex h-full overflow-auto"
                    style={{ justifyContent: "safe center", alignItems: "safe center" }}
                  >
                    {preview !== null ? (
                      <img
                        src={preview}
                        alt="当前截图"
                        draggable={false}
                        className={
                          zoom === "fit"
                            ? "max-h-full max-w-full object-contain"
                            : "max-w-none shrink-0"
                        }
                        style={
                          zoom === "fit" || natural === null
                            ? undefined
                            : { width: natural.w * zoom }
                        }
                        onLoad={(e) =>
                          setNatural({
                            w: e.currentTarget.naturalWidth,
                            h: e.currentTarget.naturalHeight,
                          })
                        }
                      />
                    ) : (
                      <span className="color-ink-dim">加载中…</span>
                    )}
                  </div>
                  <div className="absolute bottom-2 right-2 flex items-center gap-0.5 rounded-full border border-line bg-surface/92 p-0.5 shadow-sm backdrop-blur-2">
                    <button className="ai-headbtn" title="缩小" onClick={() => zoomBy(-1)}>
                      −
                    </button>
                    <button
                      className="ai-headbtn min-w-11 justify-center tabular-nums"
                      title={zoom === "fit" ? "适应窗口，点击切换为 100%" : "点击适应窗口"}
                      onClick={() => setZoom((z) => (z === "fit" ? 1 : "fit"))}
                    >
                      {zoomLabel}
                    </button>
                    <button className="ai-headbtn" title="放大" onClick={() => zoomBy(1)}>
                      ＋
                    </button>
                  </div>
                </div>
              </section>

              {/* Recognition result: extract lands here, not in the conversation */}
              <section className="ai-card min-[900px]:flex-1">
                <header className="ai-card-head">
                  <span className="ai-card-title">识别结果</span>
                  {ocr.status === "streaming" && (
                    <span className="text-mini color-ink-dim">识别中…</span>
                  )}
                  <span className="flex-1" />
                  <button
                    className="ai-headbtn"
                    disabled={busy || editing}
                    onClick={() => start("extract")}
                  >
                    重新识别
                  </button>
                  {ocr.status === "done" && ocr.text !== "" && (
                    editing ? (
                      <button className="ai-headbtn color-ink" onClick={saveEdit}>
                        完成
                      </button>
                    ) : (
                      <button className="ai-headbtn" onClick={beginEdit}>
                        编辑
                      </button>
                    )
                  )}
                  <button
                    className="ai-headbtn"
                    disabled={ocr.status !== "done" || ocr.text === "" || editing}
                    onClick={() => copy(ocr.text)}
                  >
                    复制
                  </button>
                </header>
                <div
                  ref={ocrBodyRef}
                  className="min-h-[140px] flex-1 overflow-y-auto px-3.5 py-3 max-[899px]:max-h-[300px]"
                >
                  {ocr.status === "idle" && (
                    <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 text-center">
                      <div className="color-ink-dim">尚未识别文字</div>
                      <div className="text-mini color-faint">提取截图中的全部文字，结果可编辑</div>
                      <button
                        className="ai-btn-primary mt-1.5"
                        disabled={busy}
                        onClick={() => start("extract")}
                      >
                        提取文字
                      </button>
                    </div>
                  )}
                  {ocr.status === "streaming" && (
                    <div className="whitespace-pre-wrap break-words leading-6 select-text">
                      {ocr.text === "" ? (
                        <span className="inline-flex items-center gap-2 color-ink-dim">
                          <span className="inline-block h-2 w-2 rounded-full bg-primary-500 motion-safe:animate-pulse" />
                          正在识别…
                        </span>
                      ) : (
                        <>
                          {ocr.text}
                          <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-primary-500 motion-safe:animate-pulse" />
                        </>
                      )}
                    </div>
                  )}
                  {ocr.status === "done" && !editing && (
                    ocr.text === "" ? (
                      <div className="color-faint">未识别到文字</div>
                    ) : (
                      <div className="whitespace-pre-wrap break-words leading-6 select-text">
                        {ocr.text}
                      </div>
                    )
                  )}
                  {editing && (
                    <textarea
                      autoFocus
                      className="min-h-[140px] h-full w-full resize-none rounded-lg border border-line bg-surface p-2.5 leading-6 outline-none select-text transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20"
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          saveEdit();
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditing(false);
                        }
                      }}
                    />
                  )}
                  {ocr.status === "error" && (
                    <div className="flex flex-col items-start gap-2">
                      <div className="break-all text-error-600">{ocr.error ?? "识别失败"}</div>
                      <div className="flex gap-2">
                        <button
                          className="ai-btn h-8"
                          disabled={busy}
                          onClick={() => start("extract")}
                        >
                          重试
                        </button>
                        <button className="ai-btn h-8" onClick={openSettings}>
                          去设置
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>

            {/* Conversation: translate / explain / reply / ask */}
            {messages.length > 0 && (
              <section className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-mini color-ink-dim">对话</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
                {messages.map((message) => {
                  const label = ACTIONS.find((a) => a.action === message.action)?.label;
                  const canAct =
                    message.role === "assistant" &&
                    !message.streaming &&
                    message.error === undefined &&
                    message.text !== "";
                  return (
                    <div
                      key={message.id}
                      className={`max-w-[88%] whitespace-pre-wrap break-words leading-6 select-text ${
                        message.role === "user"
                          ? "self-end rounded-xl border border-primary-500/25 bg-primary-500/8 px-3 py-2"
                          : "self-start"
                      }`}
                    >
                      {label !== undefined && (
                        <div className="mb-1 text-mini color-faint">{label}</div>
                      )}
                      {message.text === "" && message.streaming ? (
                        <span className="color-faint">…</span>
                      ) : (
                        <div>{message.text}</div>
                      )}
                      {message.error !== undefined && (
                        <>
                          <div className="text-error-600">{message.error}</div>
                          <div className="mt-1.5 flex gap-2">
                            <button className="ai-headbtn border border-line" onClick={openSettings}>
                              去设置
                            </button>
                          </div>
                        </>
                      )}
                      {canAct && (
                        <div className="mt-1.5 flex gap-1">
                          <button
                            className="ai-headbtn border border-line"
                            onClick={() => copy(message.text)}
                          >
                            复制
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            )}
            {messages.length === 0 && (
              <div className="m-auto text-center leading-7 color-faint">
                选择上方动作，或直接在下方提问。
              </div>
            )}
          </>
        )}
      </div>

      {toast !== null && (
        <div className="break-all px-4 pb-1.5 text-mini color-ink-dim">{toast}</div>
      )}

      {/* Input dock: fixed at the bottom, grows with content */}
      <div className="flex flex-none items-end gap-2 border-t border-line px-4 py-3">
        <textarea
          ref={inputRef}
          rows={1}
          className="min-h-9 max-h-40 flex-1 resize-none overflow-y-auto rounded-xl border border-line bg-surface px-3 py-2 leading-6 outline-none select-text transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 placeholder:color-faint"
          value={input}
          disabled={cropId === ""}
          placeholder={cropId === "" ? EMPTY_HINT : "向 AI 提问，Enter 发送，Shift+Enter 换行"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              start("ask");
            }
          }}
        />
        <button
          className="ai-btn-primary"
          disabled={!canAsk || input.trim() === ""}
          onClick={() => start("ask")}
        >
          发送
        </button>
      </div>

      {confirmClear && (
        <Confirm
          title="清空对话"
          message="将删除当前窗口中的全部对话记录，识别结果保留。此操作无法撤销。"
          confirmLabel="清空"
          danger
          onConfirm={() => {
            setConfirmClear(false);
            clearLog();
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}
