import { useEffect, useState } from "react";
import { api, errorText, type Preset, type Settings } from "../lib/ipc";

/**
 * Settings section of the main window. The backend never returns the stored API
 * key, so the password field is write-only: it starts empty and is cleared after
 * saving.
 */
export function SettingsView() {
  const [form, setForm] = useState<Settings | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [keyStatus, setKeyStatus] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const timer = window.setTimeout(() => setSaved(false), 2000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  /** Apply a preset's endpoint + model in one click; the key is unchanged. */
  function applyPreset(preset: Preset) {
    setForm((prev) =>
      prev ? { ...prev, baseUrl: preset.baseUrl, model: preset.model } : prev,
    );
    setSaved(false);
  }

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function saveSettings() {
    if (!form) return;
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await api.saveSettings({
        ...form,
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        translateLang: form.translateLang.trim(),
        // Empty means "use the default"; the backend models that as null.
        saveDir: form.saveDir?.trim() ? form.saveDir.trim() : null,
      });
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveKey() {
    const key = keyInput.trim();
    if (!key) return;
    setError(null);
    setKeyBusy(true);
    try {
      await api.setApiKey(key);
      setKeyInput("");
      setKeyStatus(await api.apiKeyStatus());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setKeyBusy(false);
    }
  }

  async function clearKey() {
    setError(null);
    setKeyBusy(true);
    try {
      await api.clearApiKey();
      setKeyStatus(await api.apiKeyStatus());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setKeyBusy(false);
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

  return (
    <div className="settings">
      <header className="section-header">
        <h1>设置</h1>
        <span className="section-sub">改动在点击「保存」后生效</span>
      </header>

      <div className="section-scroll">
        {form === null ? (
          <div className="hint">{error ? "加载设置失败" : "加载中…"}</div>
        ) : (
          <>
            <section className="settings-group">
              <h2>AI 服务</h2>
              <div className="field">
                <label>快速选择</label>
                <div className="preset-row">
                  {presets.map((p) => {
                    const active =
                      p.baseUrl === form.baseUrl && p.model === form.model;
                    return (
                      <button
                        key={p.label}
                        type="button"
                        className={`preset ${active ? "active" : ""}`}
                        title={p.note}
                        onClick={() => applyPreset(p)}
                      >
                        <span className="preset-label">{p.label}</span>
                        <span className="preset-model">{p.model}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="hint">
                  点选即可填入下面的地址与模型；也可直接手填任意兼容端点。
                </div>
              </div>

              <div className="field">
                <label htmlFor="base-url">服务地址</label>
                <input
                  id="base-url"
                  type="text"
                  value={form.baseUrl}
                  placeholder="https://api.deepseek.com"
                  onChange={(e) => update("baseUrl", e.target.value)}
                />
                <div className="hint">
                  任何兼容 OpenAI 接口的服务都可以使用；请求时会自动拼接
                  /chat/completions。
                </div>
              </div>

              <div className="field">
                <label htmlFor="model">模型</label>
                <input
                  id="model"
                  type="text"
                  value={form.model}
                  placeholder="deepseek-flash"
                  onChange={(e) => update("model", e.target.value)}
                />
                <div className="hint">该端点必须支持图片输入。</div>
              </div>

              <div className="field">
                <label htmlFor="translate-lang">翻译目标语言</label>
                <input
                  id="translate-lang"
                  type="text"
                  value={form.translateLang}
                  placeholder="简体中文"
                  onChange={(e) => update("translateLang", e.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="api-key">API Key</label>
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className={keyStatus ? "status ok" : "status bad"}>
                    {keyStatus ? "已保存" : "未设置"}
                  </span>
                  {keyStatus && (
                    <button type="button" className="ghost" disabled={keyBusy} onClick={clearKey}>
                      清除
                    </button>
                  )}
                </div>
                <div className="row">
                  <input
                    id="api-key"
                    type="password"
                    value={keyInput}
                    placeholder="sk-..."
                    autoComplete="new-password"
                    onChange={(e) => setKeyInput(e.target.value)}
                  />
                  <button
                    type="button"
                    disabled={keyBusy || keyInput.trim() === ""}
                    onClick={saveKey}
                  >
                    保存密钥
                  </button>
                </div>
                <div className="hint">密钥保存在系统钥匙串，不会写入配置文件。</div>
              </div>
            </section>

            <section className="settings-group">
              <h2>截图与保存</h2>
              <div className="field">
                <label htmlFor="save-dir">保存目录</label>
                <div className="row">
                  <input
                    id="save-dir"
                    type="text"
                    value={form.saveDir ?? ""}
                    placeholder="留空使用默认目录"
                    onChange={(e) => update("saveDir", e.target.value)}
                  />
                  <button type="button" onClick={() => void pickDirectory()}>
                    选择…
                  </button>
                  <button type="button" onClick={() => void openSaveDirectory()}>
                    打开
                  </button>
                </div>
                <div className="hint">
                  留空则使用默认目录 ~/Pictures/Shutter。
                </div>
              </div>

              <div className="field">
                <label>截图完成后</label>
                <label className="toggle-row" htmlFor="auto-save">
                  <input
                    id="auto-save"
                    type="checkbox"
                    checked={form.autoSave}
                    onChange={(e) => update("autoSave", e.target.checked)}
                  />
                  <span>
                    自动保存到图库
                    <em>关闭后只有按 ⌘S 保存的截图才会出现在图库</em>
                  </span>
                </label>
                <label className="toggle-row" htmlFor="copy-after">
                  <input
                    id="copy-after"
                    type="checkbox"
                    checked={form.copyAfterCapture}
                    onChange={(e) => update("copyAfterCapture", e.target.checked)}
                  />
                  <span>
                    自动复制到剪贴板
                    <em>截图确认后立即复制，可直接粘贴</em>
                  </span>
                </label>
              </div>
            </section>
          </>
        )}
      </div>

      <footer className="section-footer">
        <span className="toast" style={error ? { color: "var(--danger)" } : undefined}>
          {error ?? (saved ? "设置已保存" : "")}
        </span>
        <button type="button" className="primary" disabled={disabled} onClick={saveSettings}>
          {saving ? "保存中…" : "保存"}
        </button>
      </footer>
    </div>
  );
}
