import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  api,
  errorText,
  type ConnectionReport,
  type Preset,
  type Settings,
} from "../lib/ipc";
import { IS_MAC, formatAccelerator, defaultCaptureShortcut } from "../lib/shortcut";
import { Confirm } from "../components/Confirm";
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconEye,
  IconEyeOff,
  IconRefresh,
} from "../components/Icons";
import { ShortcutRecorder } from "../components/ShortcutRecorder";
import { Toggle } from "../components/Toggle";

/**
 * Settings area of the main window, split across three nav tabs — AI 服务,
 * 通用, 快捷键 — that share this one component instance and therefore one
 * form: separate instances would hold stale snapshots of the same Settings
 * object, and a save from one pane could silently overwrite edits made in
 * another. Switching tabs only re-renders the cards for the new `section`.
 *
 * Three rules shape this file:
 *
 * 1. The stored API key is write-only. Rust never returns it, so the password
 *    field starts empty and its value means "replace the stored key"; leaving it
 *    empty on save keeps the stored key as is.
 * 2. A configuration only takes effect once it is known to work. "测试连接"
 *    proves the endpoint/model/key triple; saving without a green test asks for
 *    confirmation first, because a typo'd base URL otherwise fails silently at
 *    the next screenshot.
 * 3. The presentation is a macOS preferences pane: grouped white cards, rows
 *    with the label on the left and the control on the right, hairline
 *    dividers. There is no page-level "save" in a real preferences pane, so the
 *    footer carries the dirty state instead of hiding it in a toast — scoped to
 *    the fields the visible section shows, while the button always persists
 *    the whole form.
 */

/** A form field is verified only while the values it was tested with still match. */
type Verification = {
  baseUrl: string;
  model: string;
  /** `null` when the tested key was the stored one. */
  key: string | null;
  report: ConnectionReport;
};

/** 翻译目标语言 preset list. The stored value is the string itself — the Rust
 *  side passes it verbatim into the prompt, so adding a language is a list
 *  edit, nothing else. */
const TRANSLATE_LANGUAGES: readonly string[] = [
  "简体中文",
  "繁體中文",
  "English",
  "日本語",
  "한국어",
  "Français",
  "Deutsch",
  "Español",
  "Русский",
  "Português",
  "Italiano",
];

/** Which nav tab is showing: decides the cards rendered and the dirty scope. */
export type SettingsSection = "ai" | "general" | "shortcuts";

const SECTION_TITLES: Record<SettingsSection, string> = {
  ai: "AI 服务",
  general: "通用",
  shortcuts: "快捷键",
};

type Props = {
  section: SettingsSection;
  /** True while this pane is the visible one; gates window-level shortcuts. */
  active?: boolean;
  /**
   * Skip the internal title header — the 更多设置 window provides its own tab
   * bar where a per-section title would be redundant.
   */
  headerless?: boolean;
};

/** Field-by-field equality for the focus-refresh below. */
function sameSettings(a: Settings, b: Settings): boolean {
  return (
    a.baseUrl === b.baseUrl &&
    a.model === b.model &&
    a.translateLang === b.translateLang &&
    (a.saveDir ?? "") === (b.saveDir ?? "") &&
    a.autoSave === b.autoSave &&
    a.copyAfterCapture === b.copyAfterCapture &&
    a.captureShortcut === b.captureShortcut &&
    (a.updateSource ?? "cnb") === (b.updateSource ?? "cnb") &&
    (a.ocrProvider ?? "system") === (b.ocrProvider ?? "system")
  );
}

export function SettingsView({ section, active = true, headerless = false }: Props) {
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

  const keyRef = useRef<HTMLInputElement | null>(null);
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

  // Settings now live in several small windows; another one may have saved
  // while this window sat in the background. On focus, silently refresh when
  // nothing is in edit, so a later save here cannot resurrect stale fields.
  // A form mid-edit is never touched.
  const cleanRef = useRef(true);
  cleanRef.current =
    form !== null && initial !== null && sameSettings(form, initial) && keyInput.trim() === "";

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused || !cleanRef.current) return;
        api
          .getSettings()
          .then((fresh) => {
            if (!alive || !cleanRef.current) return;
            setForm(fresh);
            setInitial(fresh);
          })
          .catch(() => undefined);
        api
          .apiKeyStatus()
          .then((has) => alive && setKeyStatus(has))
          .catch(() => undefined);
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
  }, [active]);

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

  /**
   * Any field of the visible section differs from the persisted snapshot, key
   * included. The footer only reports what the current tab can show; the save
   * button still persists the whole form.
   */
  const dirty = useMemo(() => {
    if (!form || !initial) return false;
    if (section === "shortcuts") {
      return form.captureShortcut.trim() !== initial.captureShortcut.trim();
    }
    if (section === "general") {
      return (
        (form.saveDir ?? "") !== (initial.saveDir ?? "") ||
        form.autoSave !== initial.autoSave ||
        form.copyAfterCapture !== initial.copyAfterCapture
      );
    }
    if (keyInput.trim() !== "") return true;
    return (
      form.baseUrl.trim() !== initial.baseUrl.trim() ||
      form.model.trim() !== initial.model.trim() ||
      form.translateLang.trim() !== initial.translateLang.trim()
    );
  }, [form, initial, keyInput, section]);

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
   * The key goes first: if it fails, the config must not be updated to
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
          ? "text-amber-600"
          : "color-faint";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="settings-pane">
      {!headerless && (
        <header className="flex-none px-6 pb-2 pt-5">
          <h1 className="m-0 text-[15px] font-600 tracking-tight color-base">
            {SECTION_TITLES[section]}
          </h1>
          <p className="mt-0.5 mb-0 text-mini color-faint">改动在点击「保存」后生效</p>
        </header>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="flex flex-col gap-6">
          {form === null ? (
            <div className="text-compact color-faint">{error ?? "加载中…"}</div>
          ) : (
            <>
              {section === "ai" && (
                <>
                  <section className="flex flex-col gap-4" data-testid="pref-card" aria-label="端点配置">
                    <div className="pref-group-title">端点配置</div>

                    <div className="pref-row-top">
                      <label className="pref-label-pt" htmlFor="preset">
                        服务商预设
                      </label>
                      <div className="pref-control flex flex-col gap-1.5">
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
                            <IconChevronDown size={13} />
                          </span>
                        </div>
                        <p className="app-hint">
                          {activePreset
                            ? `${activePreset.model} · ${activePreset.note}`
                            : "选择预设自动填入地址与模型，也可在下方手填任意兼容端点。"}
                        </p>
                      </div>
                    </div>

                    <div className="pref-row-top">
                      <label className="pref-label-pt" htmlFor="base-url">
                        服务地址
                      </label>
                      <div className="pref-control flex flex-col gap-1.5">
                        <input
                          id="base-url"
                          className="app-field font-mono text-mini"
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

                    <div className="pref-row-top">
                      <label className="pref-label-pt" htmlFor="model">
                        模型
                      </label>
                      <div className="pref-control flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <input
                            id="model"
                            className="app-field flex-1 font-mono text-mini"
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
                            className="btn-action h-8 w-8 flex-none justify-center px-0"
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

                    <div className="pref-row">
                      <label className="pref-label" htmlFor="translate-lang">
                        翻译目标语言
                      </label>
                      <div className="pref-control relative">
                        <select
                          id="translate-lang"
                          className="app-field cursor-pointer appearance-none pr-8"
                          value={TRANSLATE_LANGUAGES.includes(form.translateLang) ? form.translateLang : "custom"}
                          onChange={(e) => {
                            if (e.target.value !== "custom") update("translateLang", e.target.value);
                          }}
                        >
                          {TRANSLATE_LANGUAGES.map((lang) => (
                            <option key={lang} value={lang}>
                              {lang}
                            </option>
                          ))}
                          {/* A hand-edited settings.json can hold anything; keep
                              it selectable instead of silently reverting. */}
                          {!TRANSLATE_LANGUAGES.includes(form.translateLang) && (
                            <option value="custom">{form.translateLang}（自定义）</option>
                          )}
                        </select>
                        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 color-faint">
                          <IconChevronDown size={13} />
                        </span>
                      </div>
                    </div>

                    <div className="pref-row pt-1">
                      <span className="pref-label">连接测试</span>
                      <div className="pref-control flex flex-wrap items-center gap-2.5">
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

                        {verified && !showReport && (
                          <span className="badge badge-color-green" title="当前配置已通过连接测试">
                            <span className="h-1.5 w-1.5 flex-none rounded-full bg-current" />
                            已验证
                          </span>
                        )}
                      </div>
                    </div>
                  </section>

                  <div className="pref-divider" />

                  <section className="flex flex-col gap-4" data-testid="pref-card" aria-label="身份凭据">
                    <div className="pref-group-title">身份凭据</div>

                    <div className="pref-row-top">
                      <label className="pref-label-pt" htmlFor="api-key">
                        API 密钥
                      </label>
                      <div className="pref-control flex flex-col gap-1.5">
                        <div className="relative">
                          <input
                            id="api-key"
                            ref={keyRef}
                            className="app-field pr-9 font-mono text-mini tracking-wider"
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
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span
                            className={`badge border-0 ${
                              keyStatus ? "badge-color-green" : "badge-color-red"
                            }`}
                          >
                            <span className="h-1.5 w-1.5 flex-none rounded-full bg-current" />
                            {keyStatus ? "已保存" : "未设置"}
                          </span>
                          <p className="app-hint inline">
                            点「保存」时才会写入；留空表示沿用已保存的密钥。
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
                    </div>
                  </section>
                </>
              )}
              {section === "general" && (
                <>
                  <section className="flex flex-col gap-2.5" data-testid="pref-card" aria-label="存储位置">
                    <div className="pref-group-title pl-0">存储位置</div>

                    <label htmlFor="save-dir" className="block text-[13px] font-500 color-base">
                      默认保存目录
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="save-dir"
                        className="app-field flex-1 font-mono text-mini"
                        type="text"
                        value={form.saveDir ?? ""}
                        placeholder="留空使用默认目录"
                        spellCheck={false}
                        onChange={(e) => update("saveDir", e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn-action h-8 flex-none"
                        onClick={() => void pickDirectory()}
                      >
                        选择…
                      </button>
                      <button
                        type="button"
                        className="btn-action h-8 flex-none"
                        onClick={() => void openSaveDirectory()}
                      >
                        打开
                      </button>
                    </div>
                    <p className="app-hint">留空将恢复默认目录 ~/Pictures/Shutter；截图按时间戳自动命名。</p>
                  </section>

                  <div className="pref-divider ml-0" />

                  <section className="flex flex-col gap-4" data-testid="pref-card" aria-label="自动化与行为">
                    <div className="pref-group-title pl-0">自动化与行为</div>

                    <div className="flex items-center justify-between gap-6">
                      <label className="block min-w-0 cursor-pointer" htmlFor="auto-save">
                        <b className="block text-[13px] font-500 color-base">自动保存到图库</b>
                        <em className="mt-0.5 block text-mini not-italic leading-relaxed color-faint">
                          关闭后只有按下{" "}
                          <kbd className="rounded border border-line bg-sunken px-1 py-px font-sans text-micro color-muted">
                            ⌘S
                          </kbd>{" "}
                          保存的截图才会出现在图库
                        </em>
                      </label>
                      <Toggle
                        label="自动保存到图库"
                        checked={form.autoSave}
                        onChange={(next) => update("autoSave", next)}
                      />
                    </div>

                    <div className="flex items-center justify-between gap-6 border-t border-mute pt-4">
                      <label className="block min-w-0 cursor-pointer" htmlFor="copy-after">
                        <b className="block text-[13px] font-500 color-base">自动复制到剪贴板</b>
                        <em className="mt-0.5 block text-mini not-italic leading-relaxed color-faint">
                          截图确认后立即写入剪贴板，可直接{" "}
                          <kbd className="rounded border border-line bg-sunken px-1 py-px font-sans text-micro color-muted">
                            ⌘V
                          </kbd>{" "}
                          粘贴
                        </em>
                      </label>
                      <Toggle
                        label="自动复制到剪贴板"
                        checked={form.copyAfterCapture}
                        onChange={(next) => update("copyAfterCapture", next)}
                      />
                    </div>
                  </section>
                </>
              )}

              {section === "shortcuts" && (
                <>
                  <section className="flex flex-col gap-4" data-testid="pref-card" aria-label="全局热键">
                    <div className="pref-group-title pl-0">全局热键</div>

                    <div className="flex items-center justify-between gap-6">
                      <div className="min-w-0">
                        <div className="text-[13px] font-500 color-base">开始截图</div>
                        <div className="mt-0.5 text-mini leading-relaxed color-faint">
                          在任何应用程序前台时均可按下此热键触发选区截图
                        </div>
                      </div>
                      <div className="flex flex-none items-center gap-2.5">
                        <ShortcutRecorder
                          value={form.captureShortcut}
                          disabled={saving}
                          onChange={(accel) => update("captureShortcut", accel)}
                          onRecordingChange={setRecordingShortcut}
                        />
                        <button
                          type="button"
                          className="rounded px-1 py-1 text-mini color-faint transition-colors hover:color-primary-600"
                          title={`恢复为默认 ${formatAccelerator(defaultCaptureShortcut)}`}
                          onClick={() => update("captureShortcut", defaultCaptureShortcut)}
                        >
                          恢复默认
                        </button>
                      </div>
                    </div>
                    <p className="app-hint">
                      点击热键框后按下新的快捷组合键；按 Esc 退出录制。保存时向系统重新注册。
                    </p>
                  </section>

                  <div className="pref-divider ml-0" />

                  <section className="flex flex-col gap-3" data-testid="pref-card" aria-label="选区浮层操作">
                    <div className="flex items-center justify-between">
                      <div className="pref-group-title pl-0">选区浮层操作</div>
                      <span className="text-mini color-faint">选区确认后生效</span>
                    </div>
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-6 gap-y-1">
                      {[
                        ["Enter", "确认并复制"],
                        [IS_MAC ? "⌘S" : "Ctrl+S", "确认并保存"],
                        ["Esc", "取消截图"],
                        [IS_MAC ? "⌘Z" : "Ctrl+Z", "撤销标注"],
                        ["1 – 9", "切换工具"],
                      ].map(([k, label]) => (
                        <div
                          key={k}
                          className="flex items-center justify-between rounded-lg px-2.5 py-1.5 transition-colors hover:bg-hover"
                        >
                          <span className="text-mini color-muted">{label}</span>
                          <kbd className="app-kbd">{k}</kbd>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <footer className="flex flex-none items-center justify-between gap-3 border-t border-base bg-secondary px-6 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-block h-1.5 w-1.5 flex-none rounded-full ${
              footerState.tone === "error"
                ? "bg-error-500"
                : footerState.tone === "dirty"
                  ? "bg-amber-500"
                  : "bg-success-500"
            }`}
            aria-hidden="true"
          />
          <span
            className={`min-w-0 truncate text-mini ${toneClass}`}
            data-testid="save-state"
          >
            {footerState.text}
          </span>
        </div>
        <button
          type="button"
          className="btn-primary flex-none px-5"
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
