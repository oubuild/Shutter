/**
 * AI assistant window. The overlay opens it with `?view=chat&crop=<id>`; the PNG
 * stays in Rust (only the thumbnail enters the webview) and answers stream in
 * over `ai://delta` / `ai://done`, matched by `requestId`.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
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

const ACTIONS: ReadonlyArray<{ action: AiAction; label: string }> = [
  { action: "extract", label: "提取文字" },
  { action: "translate", label: "翻译" },
  { action: "explain", label: "解释" },
  { action: "ask", label: "提问" },
];

const EMPTY_HINT = "请先截图，再从工具条打开 AI 助手";
const DEFAULT_LANG = "简体中文";
/** Stay pinned only while the user is this close to the bottom. */
const BOTTOM_SLACK = 80;

const previewStyle: CSSProperties = {
  display: "block", margin: "0 auto", maxWidth: "100%", maxHeight: 140,
  objectFit: "contain", borderRadius: 8, border: "1px solid var(--border)",
};
const errorStyle: CSSProperties = { color: "var(--danger)" };
const toastStyle: CSSProperties = { padding: "0 18px 8px", wordBreak: "break-all" };
const barStyle: CSSProperties = {
  padding: "10px 18px", borderBottom: "1px solid var(--border)",
};
const metaRowStyle: CSSProperties = { marginTop: 6 };
const previewBoxStyle: CSSProperties = { flex: "0 0 auto", textAlign: "center" };

export function Chat() {
  const initialCrop = new URLSearchParams(window.location.search).get("crop") ?? "";

  const [cropId, setCropId] = useState(initialCrop);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const startRef = useRef<((action: AiAction, cropOverride?: string) => void) | null>(null);

  const busy = activeId !== null;
  const canAsk = cropId !== "" && !busy;

  const appendError = useCallback((text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: `error-${crypto.randomUUID()}`, role: "assistant", text: "", error: text },
    ]);
  }, []);

  /* Thumbnail for this window's crop, plus the model name for the header. */
  useEffect(() => {
    let cancelled = false;
    const fail = (e: unknown) => {
      if (!cancelled) appendError(errorText(e));
    };
    api.getSettings().then((s) => { if (!cancelled) setSettings(s); }).catch(fail);
    if (cropId) api.cropDataUrl(cropId).then((url) => { if (!cancelled) setPreview(url); }).catch(fail);
    return () => {
      cancelled = true;
    };
  }, [cropId, appendError]);

  /* Stream listeners, registered once for the life of the window. */
  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const on = (p: Promise<() => void>) =>
      p
        .then((off) => (disposed ? off() : unlisten.push(off)))
        .catch((e: unknown) => appendError(errorText(e)));

    // Append into the stored buffer via a functional update, never stale state.
    const delta = events.onAiDelta(({ requestId, text }) => {
      setMessages((prev) => {
        const index = prev.findIndex((m) => m.requestId === requestId && m.streaming);
        if (index < 0) return prev;
        const next = prev.slice();
        next[index] = { ...next[index], text: next[index].text + text };
        return next;
      });
    });
    const done = events.onAiDone(({ requestId, ok, error }) => {
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

  /* A new screenshot handed to this window re-binds it without losing history. */
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    events
      .onAiBind(({ cropId: next, action }) => {
        if (disposed) return;
        setCropId(next);
        // Clear the preview immediately so an old crop is never shown as current.
        setPreview(null);
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

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

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
    setToast(null);
    setActiveId(requestId);

    api.aiAsk(request, requestId).catch((e: unknown) => {
      const text = errorText(e);
      setMessages((prev) =>
        prev.map((m) =>
          m.requestId === requestId ? { ...m, streaming: false, error: m.error ?? text } : m,
        ),
      );
      setActiveId((prev) => (prev === requestId ? null : prev));
    });
  }

  useEffect(() => {
    startRef.current = start;
  });

  function copy(text: string) {
    api.copyText(text).catch((e: unknown) => appendError(errorText(e)));
  }

  function saveImage() {
    api
      .saveCrop(cropId)
      .then((path) => setToast(`已保存：${path}`))
      .catch((e: unknown) => appendError(errorText(e)));
  }

  function openSettings() {
    api.openSettings().catch((e: unknown) => appendError(errorText(e)));
  }

  function clearLog() {
    setMessages([]);
    setToast(null);
    stickToBottom.current = true;
  }

  return (
    <div className="panel">
      <header className="panel-header">
        <div className="row">
          <span className="panel-title">AI 助手</span>
          <span className="status" title="当前模型">
            {settings?.model ?? "…"}
          </span>
        </div>
        <span className={busy ? "status" : "status ok"}>{busy ? "生成中…" : "就绪"}</span>
      </header>

      <div className="row" style={barStyle}>
        {ACTIONS.map(({ action, label }) => (
          <button
            key={action}
            disabled={!canAsk || (action === "ask" && input.trim() === "")}
            onClick={() => start(action)}
          >
            {label}
          </button>
        ))}
        <span style={{ flex: "1 1 auto" }} />
        <button className="ghost" disabled={busy || messages.length === 0} onClick={clearLog}>
          清空
        </button>
      </div>

      <div className="chat-log" ref={logRef} onScroll={handleScroll}>
        {preview !== null && (
          <div style={previewBoxStyle}>
            <img src={preview} alt="截图预览" style={previewStyle} />
          </div>
        )}
        {cropId === "" ? (
          <div className="chat-empty">{EMPTY_HINT}</div>
        ) : messages.length === 0 ? (
          <div className="chat-empty">选择上方动作，或直接在下方提问。</div>
        ) : (
          messages.map((message) => {
            const label = ACTIONS.find((a) => a.action === message.action)?.label;
            const canAct =
              message.role === "assistant" &&
              !message.streaming &&
              message.error === undefined &&
              message.text !== "";
            return (
              <div key={message.id} className={`chat-msg ${message.role}`}>
                {label !== undefined && <div className="chat-meta">{label}</div>}
                {message.text === "" && message.streaming ? (
                  <span style={{ color: "var(--text-faint)" }}>…</span>
                ) : (
                  <div>{message.text}</div>
                )}
                {message.error !== undefined && (
                  <>
                    <div style={errorStyle}>{message.error}</div>
                    <div className="row" style={metaRowStyle}>
                      <button className="ghost" onClick={openSettings}>去设置</button>
                    </div>
                  </>
                )}
                {canAct && (
                  <div className="row" style={metaRowStyle}>
                    <button className="ghost" onClick={() => copy(message.text)}>复制</button>
                    <button className="ghost" onClick={saveImage}>保存图片</button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {toast !== null && <div className="toast" style={toastStyle}>{toast}</div>}

      <div className="composer">
        <textarea
          value={input}
          disabled={cropId === ""}
          placeholder={cropId === "" ? EMPTY_HINT : "提问，Enter 发送，Shift+Enter 换行"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              start("ask");
            }
          }}
        />
        <button className="primary" disabled={!canAsk || input.trim() === ""} onClick={() => start("ask")}>
          发送
        </button>
      </div>
    </div>
  );
}
