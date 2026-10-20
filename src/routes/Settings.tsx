import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  errorText,
  events,
  type ConnectionReport,
  type Preset,
  type Settings,
} from "../lib/ipc";
import { IS_MAC, formatAccelerator, defaultCaptureShortcut } from "../lib/shortcut";
import { Confirm } from "../components/Confirm";
import {
  IconAlert,
  IconCheck,
  IconEye,
  IconEyeOff,
  IconImage,
  IconKey,
  IconKeyboard,
  IconRefresh,
  IconSparkles,
} from "../components/Icons";
import { ShortcutRecorder } from "../components/ShortcutRecorder";

/**
 * Settings section of the main window.
 *
 * Three rules shape this file:
 *
 * 1. The stored API key is write-only. Rust never returns it, so the password
 *    field starts empty and its value means "replace the stored key"; leaving it
 *    empty on save skips the keychain entirely.
 * 2. A configuration only takes effect once it is known to work. "测试连接"
 *    proves the endpoint/model/key triple; saving without a green test asks for
 *    confirmation first, because a typo'd base URL otherwise fails silently at
 *    the next screenshot.
 * 3. The presentation is a macOS preferences pane: grouped white cards, rows
 *    with the label on the left and the control on the right, hairline
 *    dividers. There is no page-level "save" in a real preferences pane, so the
 *    footer carries the dirty state instead of hiding it in a toast.
 */

/** A form field is verified only while the values it was tested with still match. */
type Verification = {
  baseUrl: string;
  model: string;
  /** `null` when the tested key was the stored one. */
  key: string | null;
  report: ConnectionReport;
};

/** `https://api.deepseek.com` → `api.deepseek.com`; unparsable input as-is. */
function hostOf(baseUrl: string): string {
  const raw = baseUrl.trim();
  if (raw === "") return "未配置端点";
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

/** How the probe answered, in the vocabulary the footer readout uses. */
function viaLabel(via: ConnectionReport["via"]): string | null {
  if (via === "models") return "via /models";
  if (via === "probe") return "via chat";
  return null;
}

type Props = {
  /** True while this pane is the visible one; gates window-level shortcuts. */
  active?: boolean;
};

export function SettingsView({ active = true }: Props) {
  const [form, setForm] = useState<Settings | null>(null);
  /** The persisted values, for the dirty check in the footer. */
  const [initial, setInitial] = useState<Settings | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [keyStatus, setKeyStatus] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [models, setModels] = useState<string[]>([]);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const [highlightShortcuts, setHighlightShortcuts] = useState(false);

  const keyRef = useRef<HTMLInputElement | null>(null);
  const shortcutCardRef = useRef<HTMLElement | null>(null);
  const recordingRef = useRef(false);
  recordingRef.current = recordingShortcut;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [loaded, hasKey, list] = await Promise.all([
          api.getSettings(),
          api.apiKeyStatus(),
          api.modelPresets(),
        ]);
        if (!alive) return;
        setForm(loaded);
        setInitial(loaded);
        setKeyStatus(hasKey);
        setPresets(list);
      } catch (e) {
        if (alive) setError(errorText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Hide the success notice about two seconds after a save.
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2200);
    return () => window.clearTimeout(timer);
  }, [saved]);

  /**
   * A verification only holds for the exact values it was run against. Editing
   * the URL, the model or the key invalidates it, so the save button knows to
   * ask again instead of trusting a stale green badge.
   */
  const testedValues = useMemo(() => {
    if (!form || !verification) return false;
    return (
      verification.baseUrl === form.baseUrl.trim() &&
      verification.model === form.model.trim() &&
      (verification.key ?? "") === keyInput.trim()
    );
  }, [form, verification, keyInput]);

  const verified = testedValues && verification?.report.ok === true;

  /**
   * Whether the AI connection settings differ from what is stored. Only these
   * three fields are worth testing, so only they trigger the confirm dialog.
   */
  const aiDirty = useMemo(() => {
    if (!form || !initial) return false;
    if (keyInput.trim() !== "") return true;
    return (
      form.baseUrl.trim() !== initial.baseUrl.trim() ||
      form.model.trim() !== initial.model.trim()
    );
  }, [form, initial, keyInput]);

  /** Any field differs from the persisted snapshot, key included. */
  const dirty = useMemo(() => {
    if (!form || !initial) return false;
    if (keyInput.trim() !== "") return true;
    return (
      form.baseUrl.trim() !== initial.baseUrl.trim() ||
      form.model.trim() !== initial.model.trim() ||
      form.translateLang.trim() !== initial.translateLang.trim() ||
      (form.saveDir ?? "") !== (initial.saveDir ?? "") ||
      form.autoSave !== initial.autoSave ||
      form.copyAfterCapture !== initial.copyAfterCapture ||
      form.captureShortcut.trim() !== initial.captureShortcut.trim()
    );
  }, [form, initial, keyInput]);

  /** The preset whose endpoint + model the form currently sits on, if any. */
  const activePreset = useMemo(() => {
    if (!form) return null;
    return (
      presets.find(
        (p) => p.baseUrl === form.baseUrl.trim() && p.model === form.model.trim(),
      ) ?? null
    );
  }, [form, presets]);

  /** Apply a preset's endpoint + model in one click; the key is unchanged. */
  function applyPreset(preset: Preset) {
    setForm((prev) =>
      prev ? { ...prev, baseUrl: preset.baseUrl, model: preset.model } : prev,
    );
    setSaved(false);
    setVerification(null);
  }

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setSaved(false);
  }

  /**
   * Write the key (if the user typed one) and then the settings.
   *
   * The keychain goes first: if it fails, the config must not be updated to
   * point at a key that was never stored.
   */
  const persist = useCallback(
    async (values: Settings, key: string) => {
      setError(null);
      setSaved(false);
      setSaving(true);
      const normalised: Settings = {
        ...values,
        baseUrl: values.baseUrl.trim(),
        model: values.model.trim(),
        translateLang: values.translateLang.trim(),
        captureShortcut: values.captureShortcut.trim(),
        // Empty means "use the default"; the backend models that as null.
        saveDir: values.saveDir?.trim() ? values.saveDir.trim() : null,
      };
      try {
        if (key.trim() !== "") {
          setKeyBusy(true);
          await api.setApiKey(key.trim());
          setKeyInput("");
          setKeyStatus(true);
          setKeyBusy(false);
        }
        await api.saveSettings(normalised);
        setInitial(normalised);
        setSaved(true);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setKeyBusy(false);
        setSaving(false);
      }
    },
    [],
  );

  /** The footer button: gate on verification, then persist. */
  function requestSave() {
    if (!form || saving) return;
    // Untouched AI fields need no proof: there is nothing new to break.
    if (verified || !aiDirty) {
      void persist(form, keyInput);
      return;
    }
    setConfirmSave(true);
  }

  async function clearKey() {
    setError(null);
    setKeyBusy(true);
    try {
      await api.clearApiKey();
      setKeyStatus(await api.apiKeyStatus());
      setVerification(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setKeyBusy(false);
    }
  }

  /** Ask the backend to validate the current form values, unsaved. */
  async function testConnection() {
    if (!form) return;
    setError(null);
    setTesting(true);
    setVerification(null);
    try {
      const report = await api.testConnection(
        form.baseUrl.trim(),
        form.model.trim(),
        keyInput.trim() === "" ? null : keyInput.trim(),
      );
      setVerification({
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        key: keyInput.trim() === "" ? null : keyInput.trim(),
        report,
      });
      if (report.models.length > 0) setModels(report.models);
    } catch (e) {
      setVerification({
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        key: keyInput.trim() === "" ? null : keyInput.trim(),
        report: {
          ok: false,
          detail: errorText(e),
          latencyMs: null,
          via: null,
          models: [],
        },
      });
    } finally {
      setTesting(false);
    }
  }

  /** Pull the model list from the endpoint, using the typed key if there is one. */
  async function refreshModels() {
    if (!form) return;
    setModelError(null);
    setModelBusy(true);
    try {
      const list = await api.listModels(
        form.baseUrl.trim(),
        keyInput.trim() === "" ? null : keyInput.trim(),
      );
      setModels(list);
      if (list.length === 0) setModelError("该端点没有返回模型列表，请手动填写");
    } catch (e) {
      setModelError(errorText(e));
    } finally {
      setModelBusy(false);
    }
  }

  const disabled = form === null || saving;

  async function pickDirectory() {
    setError(null);
    try {
      const picked = await api.chooseDirectory();
      if (picked) update("saveDir", picked);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function openSaveDirectory() {
    try {
      const dir = await api.saveDirectory();
      await api.openDirectory(dir);
    } catch (e) {
      setError(errorText(e));
    }
  }

  // ⌘S / Ctrl+S saves while this section is on screen. Deliberately a window
  // listener rather than an OS-global shortcut: ⌘S already means "save the
  // screenshot" in the overlay window, and a global binding would steal it.
  //
  // The handler is reached through a ref so the listener is registered once;
  // depending on `requestSave` would re-subscribe on every keystroke.
  const saveRef = useRef<() => void>(() => undefined);
  saveRef.current = requestSave;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active || recordingRef.current) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      saveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    events
      .onUiFocus((target) => {
        if (target !== "shortcuts") return;
        const card = shortcutCardRef.current;
        if (!card) return;
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightShortcuts(true);
        window.setTimeout(() => setHighlightShortcuts(false), 1400);
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const report = verification?.report ?? null;
  // A result for values that have since been edited is worse than no result:
  // it would look like the current form had been checked.
  const showReport = report !== null && testedValues;
  const latency = report?.ok && report.latencyMs !== null ? report.latencyMs : null;

  // Footer reads as one status line, most recent event first.
  const footerState = error
    ? { tone: "error" as const, text: error }
    : saved
      ? { tone: "saved" as const, text: "设置已保存" }
      : dirty
        ? { tone: "dirty" as const, text: "有未保存的改动" }
        : { tone: "idle" as const, text: "已是最新" };

  const toneClass =
    footerState.tone === "error"
      ? "text-error-600"
      : footerState.tone === "saved"
        ? "text-success-600"
        : footerState.tone === "dirty"
          ? "color-muted"
          : "color-faint";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="settings-pane">
      <header className="flex-none px-5 pt-5 pb-4">
        <h1 className="m-0 text-xl font-600 tracking-tight color-base">设置</h1>
        <p className="mt-1 mb-0 text-compact color-faint">
          改动在点击「保存」后生效
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex max-w-[820px] flex-col gap-4">
          {form === null ? (
            <div className="app-card" data-testid="pref-card">
              <div className="px-4 py-6 text-compact color-faint">
                {error ?? "加载中…"}
              </div>
            </div>
          ) : (
            <>
              <section className="app-card" data-testid="pref-card" aria-labelledby="pref-ai-title">
                <div className="app-card-head">
                  <span className="grid h-7 w-7 flex-none place-items-center rounded-md bg-primary-500/10 color-primary-600">
                    <IconSparkles size={15} />
                  </span>
                  <div className="min-w-0">
                    <h2 id="pref-ai-title" className="m-0 text-compact font-600 color-base">
                      AI 服务
                    </h2>
                    <p className="m-0 mt-0.5 text-mini color-faint">
                      端点、模型与连接测试
                    </p>
                  </div>
                  <div className="ml-auto flex min-w-0 max-w-[52%] items-center justify-end gap-2">
                    {verified && (
                      <span className="badge badge-color-green" title="当前配置已通过连接测试">
                        <span className="h-1.5 w-1.5 flex-none rounded-full bg-current" />
                        已验证
                      </span>
                    )}
                    <span className="app-meta" title={form.baseUrl}>
                      {hostOf(form.baseUrl)}
                    </span>
                  </div>
                </div>

                <div className="app-row">
                  <label className="app-label" htmlFor="preset">
                    快速选择
                  </label>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="relative">
                      <select
                        id="preset"
                        className="app-field cursor-pointer appearance-none pr-8"
                        value={activePreset?.label ?? ""}
                        onChange={(e) => {
                          const next = presets.find((p) => p.label === e.target.value);
                          if (next) applyPreset(next);
                        }}
                      >
                        <option value="">自定义端点</option>
                        {presets.map((p) => (
                          <option key={p.label} value={p.label}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 color-faint">
                        ▾
                      </span>
                    </div>
                    <p className="app-hint">
                      {activePreset
                        ? `${activePreset.model} · ${activePreset.note}`
                        : "选择预设自动填入地址与模型，也可在下方手填任意兼容端点。"}
                    </p>
                  </div>
                </div>

                <div className="app-row">
                  <label className="app-label" htmlFor="base-url">
                    服务地址
                  </label>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <input
                      id="base-url"
                      className="app-field"
                      type="text"
                      value={form.baseUrl}
                      placeholder="https://api.deepseek.com"
                      spellCheck={false}
                      onChange={(e) => update("baseUrl", e.target.value)}
                    />
                    <p className="app-hint">
                      兼容 OpenAI 接口的服务均可使用；请求时会自动拼接
                      /chat/completions。
                    </p>
                  </div>
                </div>

                <div className="app-row">
                  <label className="app-label" htmlFor="model">
                    模型
                  </label>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <input
                        id="model"
                        className="app-field flex-1"
                        type="text"
                        list="model-options"
                        value={form.model}
                        placeholder="deepseek-flash"
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => update("model", e.target.value)}
                      />
                      <datalist id="model-options">
                        {models.map((id) => (
                          <option key={id} value={id} />
                        ))}
                      </datalist>
                      <button
                        type="button"
                        className="grid h-8 w-8 flex-none place-items-center rounded-md border border-neutral-300 color-muted transition hover:bg-hover disabled:op30"
                        title="从服务端获取模型列表"
                        aria-label="从服务端获取模型列表"
                        disabled={modelBusy}
                        onClick={() => void refreshModels()}
                      >
                        <IconRefresh
                          size={15}
                          className={modelBusy ? "animate-spin" : undefined}
                        />
                      </button>
                    </div>
                    <p className={modelError ? "app-hint text-error-600" : "app-hint"}>
                      {modelError ??
                        "该端点必须支持图片输入；右侧按钮可拉取服务端模型列表。"}
                    </p>
                  </div>
                </div>

                <div className="app-row">
                  <label className="app-label" htmlFor="translate-lang">
                    翻译目标语言
                  </label>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <input
                      id="translate-lang"
                      className="app-field"
                      type="text"
                      value={form.translateLang}
                      placeholder="简体中文"
                      onChange={(e) => update("translateLang", e.target.value)}
                    />
                  </div>
                </div>

                <div className="app-row">
                  <span className="app-label">连接测试</span>
                  <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      className="btn-action"
                      disabled={testing || saving}
                      onClick={() => void testConnection()}
                    >
                      {testing ? "测试中…" : "测试连接"}
                    </button>

                    {showReport && (
                      <span
                        className={`inline-flex items-center gap-1.5 text-mini ${
                          report.ok ? "text-success-600" : "text-error-600"
                        }`}
                        role="status"
                      >
                        {report.ok ? <IconCheck size={13} /> : <IconAlert size={13} />}
                        {report.detail}
                      </span>
                    )}

                    {latency !== null && (
                      <>
                        <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-mini tabular-nums color-muted">
                          {latency} ms
                        </span>
                        <span
                          className="h-1 w-20 flex-none overflow-hidden rounded-full bg-sunken"
                          aria-hidden="true"
                        >
                          <i
                            className="block h-full rounded-full bg-success-500 transition-all"
                            style={{
                              width: `${Math.min(100, Math.max(6, (latency / 1500) * 100))}%`,
                            }}
                          />
                        </span>
                      </>
                    )}

                    {showReport && viaLabel(report.via) && (
                      <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-mini color-faint">
                        {viaLabel(report.via)}
                      </span>
                    )}
                  </div>
                </div>
              </section>

              <section className="app-card" data-testid="pref-card" aria-labelledby="pref-key-title">
                <div className="app-card-head">
                  <span className="grid h-7 w-7 flex-none place-items-center rounded-md bg-primary-500/10 color-primary-600">
                    <IconKey size={15} />
                  </span>
                  <div className="min-w-0">
                    <h2 id="pref-key-title" className="m-0 text-compact font-600 color-base">
                      访问凭据
                    </h2>
                    <p className="m-0 mt-0.5 text-mini color-faint">
                      存储在系统钥匙串，不写入配置文件
                    </p>
                  </div>
                  <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
                    <button
                      type="button"
                      className={`badge border-0 ${
                        keyStatus ? "badge-color-green" : "badge-color-red"
                      }`}
                      title={keyStatus ? "已保存在系统钥匙串" : "点击填写 API Key"}
                      onClick={() => keyRef.current?.focus()}
                    >
                      <span className="h-1.5 w-1.5 flex-none rounded-full bg-current" />
                      {keyStatus ? "已保存" : "未设置"}
                    </button>
                  </div>
                </div>

                <div className="app-row">
                  <label className="app-label" htmlFor="api-key">
                    API Key
                  </label>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="relative">
                      <input
                        id="api-key"
                        ref={keyRef}
                        className="app-field pr-9"
                        type={keyVisible ? "text" : "password"}
                        value={keyInput}
                        placeholder={keyStatus ? "已保存，留空则不修改" : "sk-..."}
                        autoComplete="new-password"
                        spellCheck={false}
                        onChange={(e) => setKeyInput(e.target.value)}
                      />
                      <button
                        type="button"
                        className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center border-0 bg-transparent p-0 rounded color-faint transition hover:bg-hover hover:color-base"
                        title={keyVisible ? "隐藏明文" : "显示明文"}
                        aria-label={keyVisible ? "隐藏明文" : "显示明文"}
                        aria-pressed={keyVisible}
                        onClick={() => setKeyVisible((v) => !v)}
                      >
                        {keyVisible ? <IconEyeOff size={15} /> : <IconEye size={15} />}
                      </button>
                    </div>
                    <p className="app-hint">
                      点「保存」时才会写入钥匙串；留空表示沿用已保存的密钥。
                      {keyStatus && (
                        <>
                          {" "}
                          <button
                            type="button"
                            className="border-0 bg-transparent p-0 text-mini color-primary-600 underline underline-offset-2 disabled:op30"
                            disabled={keyBusy}
                            onClick={() => void clearKey()}
                          >
                            清除已保存的密钥
                          </button>
                        </>
                      )}
                    </p>
                  </div>
                </div>
              </section>

              <section className="app-card" data-testid="pref-card" aria-labelledby="pref-capture-title">
                <div className="app-card-head">
                  <span className="grid h-7 w-7 flex-none place-items-center rounded-md bg-primary-500/10 color-primary-600">
                    <IconImage size={15} />
                  </span>
                  <div className="min-w-0">
                    <h2 id="pref-capture-title" className="m-0 text-compact font-600 color-base">
                      截图与保存
                    </h2>
                    <p className="m-0 mt-0.5 text-mini color-faint">
                      截图完成后的去向
                    </p>
                  </div>
                  <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
                    <span className="app-meta" title={form.saveDir ?? ""}>
                      {form.saveDir?.trim() ? form.saveDir : "~/Pictures/Shutter"}
                    </span>
                  </div>
                </div>

                <div className="app-row">
                  <label className="app-label" htmlFor="save-dir">
                    保存目录
                  </label>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
                      <input
                        id="save-dir"
                        className="app-field"
                        type="text"
                        value={form.saveDir ?? ""}
                        placeholder="留空使用默认目录"
                        spellCheck={false}
                        onChange={(e) => update("saveDir", e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn-action h-8"
                        onClick={() => void pickDirectory()}
                      >
                        选择…
                      </button>
                      <button
                        type="button"
                        className="btn-action h-8"
                        onClick={() => void openSaveDirectory()}
                      >
                        打开
                      </button>
                    </div>
                    <p className="app-hint">留空则使用默认目录 ~/Pictures/Shutter。</p>
                  </div>
                </div>

                <div className="app-row-toggle">
                  <label className="block color-base" htmlFor="auto-save">
                    <b className="text-compact font-500">自动保存到图库</b>
                    <em className="mt-0.5 block text-mini not-italic color-faint">
                      关闭后只有按 ⌘S 保存的截图才会出现在图库
                    </em>
                  </label>
                  <label className="relative inline-flex h-5 w-9 flex-none cursor-pointer items-center">
                    <input
                      id="auto-save"
                      type="checkbox"
                      className="peer sr-only"
                      checked={form.autoSave}
                      onChange={(e) => update("autoSave", e.target.checked)}
                    />
                    <span className="absolute inset-0 rounded-full bg-#99999940 transition peer-checked:bg-primary-500 peer-focus-visible:ring-3 peer-focus-visible:ring-primary-500/30" />
                    <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
                  </label>
                </div>

                <div className="app-row-toggle">
                  <label className="block color-base" htmlFor="copy-after">
                    <b className="text-compact font-500">自动复制到剪贴板</b>
                    <em className="mt-0.5 block text-mini not-italic color-faint">
                      截图确认后立即复制，可直接粘贴
                    </em>
                  </label>
                  <label className="relative inline-flex h-5 w-9 flex-none cursor-pointer items-center">
                    <input
                      id="copy-after"
                      type="checkbox"
                      className="peer sr-only"
                      checked={form.copyAfterCapture}
                      onChange={(e) => update("copyAfterCapture", e.target.checked)}
                    />
                    <span className="absolute inset-0 rounded-full bg-#99999940 transition peer-checked:bg-primary-500 peer-focus-visible:ring-3 peer-focus-visible:ring-primary-500/30" />
                    <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
                  </label>
                </div>
              </section>

              <section
                className={`app-card ${highlightShortcuts ? "ring-3 ring-primary-500/25" : ""}`}
                data-testid="pref-card"
                aria-labelledby="pref-keys-title"
                ref={shortcutCardRef}
              >
                <div className="app-card-head">
                  <span className="grid h-7 w-7 flex-none place-items-center rounded-md bg-primary-500/10 color-primary-600">
                    <IconKeyboard size={15} />
                  </span>
                  <div className="min-w-0">
                    <h2 id="pref-keys-title" className="m-0 text-compact font-600 color-base">
                      快捷键
                    </h2>
                    <p className="m-0 mt-0.5 text-mini color-faint">
                      全局热键与窗口内操作
                    </p>
                  </div>
                </div>

                <div className="app-row">
                  <span className="app-label">开始截图</span>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <ShortcutRecorder
                      value={form.captureShortcut}
                      disabled={saving}
                      onChange={(accel) => update("captureShortcut", accel)}
                      onRecordingChange={setRecordingShortcut}
                    />
                    <p className="app-hint">
                      全局生效；点按后按下新组合，保存时向系统重新注册。
                      <button
                        type="button"
                        className="ml-1 border-0 bg-transparent p-0 text-mini color-primary-600 underline underline-offset-2"
                        onClick={() =>
                          update("captureShortcut", defaultCaptureShortcut)
                        }
                      >
                        恢复默认 {formatAccelerator(defaultCaptureShortcut)}
                      </button>
                    </p>
                  </div>
                </div>

                <div className="app-row">
                  <span className="app-label">截图浮层</span>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(164px,1fr))] gap-x-4 gap-y-2">
                    {[
                      ["Enter", "确认并复制"],
                      [IS_MAC ? "⌘S" : "Ctrl+S", "确认并保存"],
                      ["Esc", "取消截图"],
                      [IS_MAC ? "⌘Z" : "Ctrl+Z", "撤销标注"],
                      ["1 – 9", "切换工具"],
                    ].map(([k, label]) => (
                      <span key={k} className="flex items-center gap-2 text-compact color-muted">
                        <kbd className="app-kbd">{k}</kbd>
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      <footer className="flex flex-none items-center gap-3 border-t border-base bg-base px-5 py-3">
        <span
          className={`min-w-0 flex-1 truncate text-compact ${toneClass}`}
          data-testid="save-state"
        >
          {footerState.tone === "dirty" && (
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary-500 align-middle" />
          )}
          {footerState.text}
        </span>
        <button
          type="button"
          className="btn-primary flex-none"
          disabled={disabled}
          title="保存设置（⌘S）"
          onClick={requestSave}
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </footer>

      {confirmSave && form && (
        <Confirm
          title="尚未验证连接"
          message={
            verification?.report.ok === false
              ? `最近一次测试未通过：${verification.report.detail}。仍要保存这份配置吗？`
              : "还没有测试过这份配置的连通性。保存后如果地址、模型或密钥有误，AI 功能会失败。仍要保存吗？"
          }
          confirmLabel="仍然保存"
          cancelLabel="先去测试"
          danger
          onCancel={() => setConfirmSave(false)}
          onConfirm={() => {
            setConfirmSave(false);
            void persist(form, keyInput);
          }}
        />
      )}
    </div>
  );
}
