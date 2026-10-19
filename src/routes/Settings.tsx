import { useEffect, useState } from "react";
import { api, errorText, type Settings } from "../lib/ipc";

/**
 * Settings window. The backend never returns the stored API key, so the
 * password field is write-only: it starts empty and is cleared after saving.
 */
export function SettingsView() {
  const [form, setForm] = useState<Settings | null>(null);
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
        const [loaded, hasKey] = await Promise.all([
          api.getSettings(),
          api.apiKeyStatus(),
        ]);
        if (!alive) return;
        setForm(loaded);
        setKeyStatus(hasKey);
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

  return (
    <div className="panel">
      <header className="panel-header">
        <div className="panel-title">设置</div>
      </header>

      <div className="panel-body">
        {form === null ? (
          <div className="hint">{error ? "加载设置失败" : "加载中…"}</div>
        ) : (
          <>
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
              <label htmlFor="save-dir">保存目录</label>
              <input
                id="save-dir"
                type="text"
                value={form.saveDir ?? ""}
                placeholder="~/Pictures/cap-photo"
                onChange={(e) => update("saveDir", e.target.value)}
              />
              <div className="hint">留空则使用默认目录 ~/Pictures/cap-photo。</div>
            </div>

            <div className="field">
              <label htmlFor="copy-after">截图后自动复制</label>
              <div className="row">
                <input
                  id="copy-after"
                  type="checkbox"
                  checked={form.copyAfterCapture}
                  style={{ width: "auto" }}
                  onChange={(e) => update("copyAfterCapture", e.target.checked)}
                />
                <span>截图完成后自动复制到剪贴板</span>
              </div>
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
              <div className="hint">密钥保存在 macOS 钥匙串，不会写入配置文件。</div>
            </div>
          </>
        )}
      </div>

      <footer className="panel-footer">
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
