/**
 * The 软件更新 card: download source toggle + check/download/relaunch.
 *
 * Extracted from About.tsx so the 更多设置 window's 更新 tab can render the
 * same surface. `updateSource` persists immediately through a read-modify-write
 * (save_settings_cmd stores the whole object; other windows may hold unsaved
 * edits), so this card never touches the settings form state.
 */

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api, errorText, type UpdateSource } from "../lib/ipc";
import { useAppUpdater } from "../lib/updater";

export function UpdatePanel({ divided = true }: { divided?: boolean }) {
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateSource, setUpdateSource] = useState<UpdateSource>("cnb");
  const updater = useAppUpdater(updateSource);

  const changeUpdateSource = async (source: UpdateSource) => {
    if (source === updateSource) return;
    setUpdateSource(source);
    try {
      // Read-modify-write: the settings page may be holding other unsaved
      // edits elsewhere, but save_settings_cmd persists the whole object, so
      // patch only our field on top of what is currently stored.
      const settings = await api.getSettings();
      await api.saveSettings({ ...settings, updateSource: source });
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setUpdateSource(s.updateSource ?? "cnb"))
      .catch(() => undefined);
    // Read from the bundle so the page never disagrees with tauri.conf.json.
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <section className={divided ? "border-t border-base py-3.5" : "py-1"}>
      <h2 className="mb-2.5 mt-0 text-micro font-600 tracking-wider uppercase color-faint">
        软件更新
      </h2>
      <div className="flex items-center gap-2.5 py-1 text-compact">
        <span className="w-32 flex-none color-muted">下载源</span>
        <div className="flex gap-1.5">
          {(
            [
              ["cnb", "CNB 镜像"],
              ["github", "GitHub"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={updateSource === value ? "btn-primary" : "btn-action"}
              disabled={updater.phase !== "idle"}
              onClick={() => void changeUpdateSource(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2.5 py-1 text-compact">
        <span className="w-32 flex-none color-muted">当前版本</span>
        <span className="min-w-0 flex-1 text-mini color-faint">v{version ?? "…"}</span>
        {updater.phase === "idle" && (
          <button
            type="button"
            className="btn-action flex-none"
            onClick={() => void updater.check()}
          >
            检查更新
          </button>
        )}
        {updater.phase === "checking" && (
          <span className="flex-none text-mini color-faint">正在检查…</span>
        )}
        {updater.phase === "available" && (
          <button
            type="button"
            className="btn-primary flex-none"
            onClick={() => void updater.downloadAndInstall()}
          >
            下载并安装 v{updater.newVersion}
          </button>
        )}
        {updater.phase === "downloading" && (
          <span className="flex-none text-mini color-faint">
            正在下载 {updater.progressLabel ?? "…"}
          </span>
        )}
        {updater.phase === "ready" && (
          <button
            type="button"
            className="btn-primary flex-none"
            onClick={() => void updater.relaunch()}
          >
            重启生效
          </button>
        )}
      </div>
      {(updater.message || updater.error) && (
        <p
          className={`mb-0 mt-1.5 text-mini leading-6 ${
            updater.error ? "text-error-600" : "color-faint"
          }`}
        >
          {updater.error ?? updater.message}
          {updater.phase === "idle" && updater.message === "已是最新版本" && (
            <>
              {" "}
              <button
                type="button"
                className="btn-action flex-none"
                onClick={updater.openReleasePage}
              >
                查看发布页
              </button>
            </>
          )}
        </p>
      )}
      {updater.phase === "available" && updater.notes && (
        <p className="mb-0 mt-1.5 line-clamp-3 text-mini leading-6 color-faint">{updater.notes}</p>
      )}
      {updater.phase === "downloading" && updater.progress?.total != null && (
        <div className="mt-2 h-1 w-full max-w-md overflow-hidden rounded-full bg-base">
          <div
            className="h-full rounded-full bg-primary-500"
            style={{
              width: `${Math.min(
                100,
                Math.round((updater.progress.downloaded / updater.progress.total) * 100),
              )}%`,
            }}
          />
        </div>
      )}
      {error && <p className="mb-0 mt-1.5 text-mini leading-6 text-error-600">{error}</p>}
    </section>
  );
}
