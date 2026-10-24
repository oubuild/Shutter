/**
 * Shutter AI window — the screenshot-centric assistant.
 *
 * The overlay opens it with `?view=chat&crop=<id>`; the PNG stays in Rust
 * (only a preview data URL enters the webview) and answers stream in over
 * `ai://delta` / `ai://done`, matched by `requestId`.
 *
 * The four AI actions are tabs, not a conversation log: each keeps its own
 * result for the current crop and clicking a tab switches the result card.
 * 结果跟着截图走 — a new crop resets every tab. Free questions live in the
 * 对话 tab. Copy is a hover-revealed icon, never a bordered button.
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

/** The AI actions, each shown as a tab with its own per-crop result. */
type ActionTab = "extract" | "translate" | "explain" | "reply";
/** Tabs of the result card: the four actions plus free conversation. */
type Tab = ActionTab | "chat";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Set on assistant placeholders so stream events can find their message. */
  requestId?: string;
  streaming?: boolean;
  error?: string;
};

type ActState = {
  status: "idle" | "streaming" | "done" | "error";
  text: string;
  error?: string;
  /** Live request owning this tab; cleared once the stream settles. */
  requestId?: string;
};

const IDLE_ACT: ActState = { status: "idle", text: "" };

const ACTION_TABS: ReadonlyArray<{ id: ActionTab; label: string }> = [
  { id: "extract", label: "提取文字" },
  { id: "translate", label: "翻译" },
  { id: "explain", label: "解释" },
  { id: "reply", label: "回复建议" },
];

const TAB_LABEL: Record<Tab, string> = {
  extract: "提取文字",
  translate: "翻译",
  explain: "解释",
  reply: "回复建议",
  chat: "对话",
};

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

/** 14px hover-revealed action glyphs; the era of bordered 复制 buttons is over. */
function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.75" y="5.75" width="8" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10.25 3.75v-.2a1.8 1.8 0 0 0-1.8-1.8H4.05a1.8 1.8 0 0 0-1.8 1.8v4.4a1.8 1.8 0 0 0 1.8 1.8h.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RerunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.6h-2.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M11.3 2.6a1.65 1.65 0 0 1 2.34 2.34L5.4 13.2l-3 .66.66-3z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const IDLE_ACTS: Record<ActionTab, ActState> = {
  extract: IDLE_ACT,
  translate: IDLE_ACT,
  explain: IDLE_ACT,
  reply: IDLE_ACT,
};

export function Chat() {
  const initialCrop = new URLSearchParams(window.location.search).get("crop") ?? "";

  const [cropId, setCropId] = useState(initialCrop);
  const [tab, setTab] = useState<Tab>("extract");
  /** Per-action results for the current crop; clicking a tab switches to it. */
  const [acts, setActs] = useState<Record<ActionTab, ActState>>(IDLE_ACTS);
  /** 对话 tab only: the free-form question thread. */
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [conn, setConn] = useState<{ state: "checking" | "ok" | "fail"; detail: string }>({
    state: "checking",
    detail: "正在检查连接…",
  });
  const [models, setModels] = useState<string[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const modelRef = useRef<HTMLDivElement | null>(null);
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const ocrBodyRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const startRef = useRef<((action: AiAction, cropOverride?: string) => void) | null>(null);

  const busy =
    activeId !== null || Object.values(acts).some((a) => a.status === "streaming");
  const canAsk = cropId !== "" && !busy;
  const act = acts[tab as ActionTab] ?? null;

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

  /* Stream listeners. Every stream carries its requestId; it either belongs to
     one of the per-action tabs or to a 对话 message. */
  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const on = (p: Promise<() => void>) =>
      p
        .then((off) => (disposed ? off() : unlisten.push(off)))
        .catch((e: unknown) => appendError(errorText(e)));

    const patchAct = (requestId: string, patch: (prev: ActState) => ActState) => {
      setActs((prev) => {
        let touched = false;
        const next = { ...prev };
        for (const key of Object.keys(next) as ActionTab[]) {
          if (next[key].requestId === requestId) {
            next[key] = patch(next[key]);
            touched = true;
          }
        }
        return touched ? next : prev;
      });
    };

    // Append into the stored buffers via functional updates, never stale state.
    const delta = events.onAiDelta(({ requestId, text }) => {
      patchAct(requestId, (prev) =>
        prev.status === "streaming" ? { ...prev, text: prev.text + text } : prev,
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
      patchAct(requestId, (prev) =>
        prev.status === "streaming"
          ? ok
            ? { ...prev, status: "done", requestId: undefined }
            : { ...prev, status: "error", error: error ?? "生成失败", requestId: undefined }
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

  /* A new screenshot handed to this window re-binds it: every result belongs
     to the crop, so all tabs reset. Rust replays the bind ~700ms later so a
     window that was still loading catches it, and that replay must be a no-op:
     resetting on it would wipe a stream the first bind had just started. */
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
        setActs(IDLE_ACTS);
        setMessages([]);
        setEditing(false);
        setZoom("fit");
        api.cropDataUrl(next).then((url) => { if (!disposed) setPreview(url); }).catch(() => undefined);
        // "ask" has no preset prompt — it lands on the 对话 tab and waits for
        // the user's question; the four actions run immediately.
        if (action === "ask") {
          setTab("chat");
        } else {
          const initial = (action ?? "extract") as ActionTab;
          setTab(initial);
          if (action) {
            // The toolbar already told us what the user wants; run it right away.
            window.setTimeout(() => {
              if (!disposed) startRef.current?.(action, next);
            }, 60);
          }
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

  /* Follow the stream inside the active card: without this the newest tokens
     land below the fold and the card looks frozen mid-answer. */
  useEffect(() => {
    const body = ocrBodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
    const log = logRef.current;
    if (log && stickToBottom.current) log.scrollTop = log.scrollHeight;
  }, [tab, acts, messages]);

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /* Dismiss the dropdown on any click outside it. */
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [modelOpen]);

  function handleScroll() {
    const el = logRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
  }

  /** Switching to an action tab that never ran starts it — the tab bar is the
      trigger, and a second click just shows the cached result again. */
  function selectTab(next: Tab) {
    setTab(next);
    if (next !== "chat" && acts[next].status === "idle" && cropId !== "" && !busy) {
      start(next);
    }
  }

  function start(action: AiAction, cropOverride?: string) {
    const targetCrop = cropOverride ?? cropId;
    if (!targetCrop || busy) return;
    const question = input.trim();
    if (action === "ask") {
      if (question === "") return;
      setTab("chat");
    }

    const requestId = crypto.randomUUID();
    const request: AiRequest = { cropId: targetCrop, action };
    if (action === "translate") request.lang = settings?.translateLang || DEFAULT_LANG;
    if (action === "ask") request.question = question;

    setToast(null);
    if (action === "ask") {
      setActiveId(requestId);
      const assistant: Message = {
        id: requestId,
        role: "assistant",
        text: "",
        requestId,
        streaming: true,
      };
      setMessages((prev) => [
        ...prev,
        { id: `user-${requestId}`, role: "user", text: question },
        assistant,
      ]);
      setInput("");
    } else {
      const key = action as ActionTab;
      setActs((prev) => ({
        ...prev,
        [key]: { status: "streaming", text: "", requestId },
      }));
    }

    api.aiAsk(request, requestId).catch((e: unknown) => {
      const text = errorText(e);
      if (action === "ask") {
        setMessages((prev) =>
          prev.map((m) =>
            m.requestId === requestId ? { ...m, streaming: false, error: m.error ?? text } : m,
          ),
        );
        setActiveId((prev) => (prev === requestId ? null : prev));
      } else {
        const key = action as ActionTab;
        setActs((prev) => ({
          ...prev,
          [key]: { status: "error", text: "", error: text },
        }));
      }
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
    setEditDraft(acts.extract.text);
    setEditing(true);
  }

  function saveEdit() {
    const draft = editDraft.trim();
    if (draft !== "") setActs((prev) => ({ ...prev, extract: { ...prev.extract, text: editDraft } }));
    setEditing(false);
  }

  function clearAll() {
    setMessages([]);
    setActs(IDLE_ACTS);
    setEditing(false);
    setToast(null);
    stickToBottom.current = true;
  }

  const zoomLabel = zoom === "fit" ? "适应" : `${Math.round(zoom * 100)}%`;
  const actDone = act !== null && act.status === "done" && act.text !== "";
  const hasContent = messages.length > 0 || Object.values(acts).some((a) => a.text !== "");

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface text-[13px] color-ink">
      {/* Row 1: action tabs (switch results, first click runs), then model/status ops */}
      <header className="flex flex-none items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {ACTION_TABS.map(({ id, label }) => (
            <button
              key={id}
              className={
                tab === id
                  ? "inline-flex h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-lg bg-primary-500 px-3 text-[13px] font-500 text-white transition outline-none focus-visible:ring-2 focus-visible:ring-primary-500/35 hover:bg-primary-600 disabled:pointer-events-none disabled:op-45"
                  : "inline-flex h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-500 color-ink-dim transition hover:bg-surface-alt hover:color-ink outline-none focus-visible:ring-2 focus-visible:ring-primary-500/35 disabled:pointer-events-none disabled:op-45"
              }
              disabled={cropId === ""}
              onClick={() => selectTab(id)}
            >
              {label}
              {acts[id].status === "streaming" && (
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full motion-safe:animate-pulse ${
                    tab === id ? "bg-white" : "bg-primary-500"
                  }`}
                />
              )}
            </button>
          ))}
          <button
            className={
              tab === "chat"
                ? "inline-flex h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-lg bg-primary-500/10 px-3 text-[13px] font-500 color-primary-600 transition outline-none focus-visible:ring-2 focus-visible:ring-primary-500/35"
                : "inline-flex h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-500 color-ink-dim transition hover:bg-surface-alt hover:color-ink outline-none focus-visible:ring-2 focus-visible:ring-primary-500/35"
            }
            onClick={() => setTab("chat")}
          >
            对话
            {activeId !== null && (
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full motion-safe:animate-pulse ${
                  tab === "chat" ? "bg-white" : "bg-primary-500"
                }`}
              />
            )}
          </button>
        </div>

        {/* Model selector; without a base URL it just opens settings. */}
        <div ref={modelRef} className="relative min-w-0 flex-none">
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
          className="flex h-8 flex-none items-center gap-1.5 rounded-lg px-1.5 transition hover:bg-surface-alt"
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
          className="ai-iconbtn"
          title="清空识别结果与对话"
          disabled={!hasContent}
          onClick={() => setConfirmClear(true)}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2.5 4.5h11M6.5 2.5h3M5 4.5l.6 8a1.5 1.5 0 0 0 1.5 1.4h1.8a1.5 1.5 0 0 0 1.5-1.4l.6-8"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
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
                  bare grey band under a taller result card. */}
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

            {/* Result card: content follows the active tab */}
            <section className="ai-card min-[900px]:flex-1">
              <header className="ai-card-head">
                <span className="ai-card-title">{TAB_LABEL[tab]}</span>
                {tab !== "chat" && act?.status === "streaming" && (
                  <span className="text-mini color-ink-dim">生成中…</span>
                )}
                <span className="flex-1" />
                {tab !== "chat" && act && (
                  <>
                    {actDone && (
                      <button
                        className="ai-iconbtn h-7 w-7"
                        title="复制结果"
                        onClick={() => copy(act.text)}
                      >
                        <CopyIcon />
                      </button>
                    )}
                    {tab === "extract" && actDone && (
                      editing ? (
                        <button className="ai-headbtn color-ink" onClick={saveEdit}>
                          完成
                        </button>
                      ) : (
                        <button className="ai-iconbtn h-7 w-7" title="编辑结果" onClick={beginEdit}>
                          <EditIcon />
                        </button>
                      )
                    )}
                    <button
                      className="ai-iconbtn h-7 w-7"
                      title={tab === "extract" ? "重新识别" : `重新${TAB_LABEL[tab]}`}
                      disabled={busy || editing}
                      onClick={() => start(tab)}
                    >
                      <RerunIcon />
                    </button>
                  </>
                )}
              </header>

              {tab === "chat" ? (
                <div className="min-h-[140px] flex-1 px-3.5 py-3">
                  {messages.length === 0 ? (
                    <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 text-center">
                      <div className="color-ink-dim">向 AI 提问</div>
                      <div className="text-mini color-faint">
                        针对当前截图自由提问，Enter 发送
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2.5">
                      {messages.map((message) => {
                        const canCopy =
                          message.role === "assistant" &&
                          !message.streaming &&
                          message.error === undefined &&
                          message.text !== "";
                        return (
                          <div
                            key={message.id}
                            className={`group relative max-w-[88%] whitespace-pre-wrap break-words leading-6 select-text ${
                              message.role === "user"
                                ? "self-end rounded-xl border border-primary-500/25 bg-primary-500/8 px-3 py-2"
                                : "self-start pr-6"
                            }`}
                          >
                            {message.text === "" && message.streaming ? (
                              <span className="inline-flex items-center gap-2 color-faint">
                                <span className="inline-block h-2 w-2 rounded-full bg-primary-500 motion-safe:animate-pulse" />
                                思考中…
                              </span>
                            ) : (
                              <div>{message.text}</div>
                            )}
                            {message.error !== undefined && (
                              <div className="text-error-600">{message.error}</div>
                            )}
                            {canCopy && (
                              <button
                                className="ai-iconbtn h-6 w-6 absolute right-0 top-0 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
                                title="复制"
                                onClick={() => copy(message.text)}
                              >
                                <CopyIcon />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div
                  ref={ocrBodyRef}
                  className="min-h-[140px] flex-1 overflow-y-auto px-3.5 py-3 max-[899px]:max-h-[300px]"
                >
                  {act?.status === "idle" && (
                    <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 text-center">
                      <div className="color-ink-dim">
                        {tab === "extract" ? "尚未识别文字" : `点击上方「${TAB_LABEL[tab]}」开始`}
                      </div>
                      <div className="text-mini color-faint">
                        {tab === "extract"
                          ? "提取截图中的全部文字，结果可编辑"
                          : "结果会保留在这里，可随时切换查看"}
                      </div>
                      <button
                        className="ai-btn-primary mt-1.5"
                        disabled={busy}
                        onClick={() => start(tab)}
                      >
                        {TAB_LABEL[tab]}
                      </button>
                    </div>
                  )}
                  {act?.status === "streaming" && (
                    <div className="whitespace-pre-wrap break-words leading-6 select-text">
                      {act.text === "" ? (
                        <span className="inline-flex items-center gap-2 color-ink-dim">
                          <span className="inline-block h-2 w-2 rounded-full bg-primary-500 motion-safe:animate-pulse" />
                          正在生成…
                        </span>
                      ) : (
                        <>
                          {act.text}
                          <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 bg-primary-500 motion-safe:animate-pulse" />
                        </>
                      )}
                    </div>
                  )}
                  {act?.status === "done" && !editing && (
                    act.text === "" ? (
                      <div className="color-faint">没有生成内容</div>
                    ) : (
                      <div className="whitespace-pre-wrap break-words leading-6 select-text">
                        {act.text}
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
                  {act?.status === "error" && (
                    <div className="flex flex-col items-start gap-2">
                      <div className="break-all text-error-600">{act.error ?? "生成失败"}</div>
                      <div className="flex gap-2">
                        <button
                          className="ai-btn h-8"
                          disabled={busy}
                          onClick={() => start(tab)}
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
              )}
            </section>
          </div>
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
          title="清空结果与对话"
          message="将删除当前窗口中全部动作结果与对话记录。此操作无法撤销。"
          confirmLabel="清空"
          onConfirm={() => {
            setConfirmClear(false);
            clearAll();
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}
