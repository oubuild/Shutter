/**
 * AI assistant window. The overlay opens it with `?view=chat&crop=<id>`; the PNG
 * stays in Rust (only the thumbnail enters the webview) and answers stream in
 * over `ai://delta` / `ai://done`, matched by `requestId`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
  // The reference AI dialog's fourth preset: draft a socially adept reply
  // to the conversation shown in the screenshot.
  { action: "reply", label: "高情商回复" },
  { action: "ask", label: "提问" },
];

const EMPTY_HINT = "请先截图，再从工具条打开 AI 助手";
const DEFAULT_LANG = "简体中文";
/** Stay pinned only while the user is this close to the bottom. */
const BOTTOM_SLACK = 80;


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
    <div className="flex h-full w-full flex-col bg-base text-compact color-base">
      <header className="flex flex-none items-center justify-between gap-3 border-b border-base px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-compact font-600">AI 助手</span>
          <span
            className="rounded-full border border-base px-2 py-0.5 text-mini color-muted"
            title="当前模型"
          >
            {settings?.model ?? "…"}
          </span>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-mini ${
            busy
              ? "border-base color-muted"
              : "border-success-500/40 bg-success-500/12 text-success-700"
          }`}
        >
          {busy ? "生成中…" : "就绪"}
        </span>
      </header>

      <div className="flex items-center gap-2 border-b border-base px-4 py-2.5">
        {ACTIONS.map(({ action, label }) => (
          <button
            key={action}
            className="btn-action"
            disabled={!canAsk || (action === "ask" && input.trim() === "")}
            onClick={() => start(action)}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <button
          className="btn-text"
          disabled={busy || messages.length === 0}
          onClick={clearLog}
        >
          清空
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-4" ref={logRef} onScroll={handleScroll}>
        {preview !== null && (
          <div className="flex-none text-center">
            <img
              className="mx-auto block max-h-[140px] max-w-full rounded-md border border-base object-contain"
              src={preview}
              alt="截图预览"
            />
          </div>
        )}
        {cropId === "" ? (
          <div className="m-auto text-center text-compact leading-7 color-faint">
            {EMPTY_HINT}
          </div>
        ) : messages.length === 0 ? (
          <div className="m-auto text-center text-compact leading-7 color-faint">
            选择上方动作，或直接在下方提问。
          </div>
        ) : (
          messages.map((message) => {
            const label = ACTIONS.find((a) => a.action === message.action)?.label;
            const canAct =
              message.role === "assistant" &&
              !message.streaming &&
              message.error === undefined &&
              message.text !== "";
            return (
              <div
                key={message.id}
                className={`max-w-[92%] whitespace-pre-wrap break-words text-compact leading-7 ${
                  message.role === "user"
                    ? "self-end rounded-lg border border-primary-500/25 bg-primary-500/8 px-3 py-2"
                    : "self-start color-base"
                }`}
              >
                {label !== undefined && (
                  <div className="mb-1 text-micro color-faint">{label}</div>
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
                      <button className="btn-text" onClick={openSettings}>
                        去设置
                      </button>
                    </div>
                  </>
                )}
                {canAct && (
                  <div className="mt-1.5 flex gap-2">
                    <button className="btn-text" onClick={() => copy(message.text)}>
                      复制
                    </button>
                    <button className="btn-text" onClick={saveImage}>
                      保存图片
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {toast !== null && (
        <div className="break-all px-4 pb-2 text-mini color-faint">{toast}</div>
      )}

      <div className="flex flex-none items-end gap-2 border-t border-base px-3.5 py-3">
        <textarea
          className="min-h-10 max-h-35 flex-1 resize-y rounded-md border border-base bg-base px-2.5 py-2 text-compact outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20"
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
        <button
          className="btn-primary"
          disabled={!canAsk || input.trim() === ""}
          onClick={() => start("ask")}
        >
          发送
        </button>
      </div>
    </div>
  );
}
