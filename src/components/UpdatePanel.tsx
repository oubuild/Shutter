/**
 * The 软件更新 pane: download source + check/download/relaunch, in the same
 * flat macOS form rows as the settings sections (group caption + label-value
 * rows). Shared by the 更多设置 window's 更新 tab and the About window.
 *
 * `updateSource` persists immediately through a read-modify-write
 * (save_settings_cmd stores the whole object; other windows may hold unsaved
 * edits), so this pane never touches the settings form state.
 */

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api, errorText, type UpdateSource } from "../lib/ipc";
import { useAppUpdater } from "../lib/updater";

export function UpdatePanel() {
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
    <section className="flex flex-col gap-4" aria-label="软件更新">
      <div className="pref-group-title pl-0">软件更新</div>

      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="text-[13px] font-500 color-base">更新下载源</div>
          <div className="mt-0.5 text-mini leading-relaxed color-faint">
            大陆网络推荐 CNB 镜像加速，海外网络推荐 GitHub
          </div>
        </div>
        {/* Source picker as the monochrome capsule segmented control. */}
        <div className="inline-flex flex-none items-center gap-1 rounded-lg bg-sunken p-1">
          {(
            [
              ["cnb", "CNB 镜像"],
              ["github", "GitHub"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`h-5.5 rounded-md px-3 text-mini transition-all duration-150 ${
                updateSource === value
                  ? "bg-primary-500 font-500 text-white dark:bg-neutral-200 dark:text-neutral-900"
                  : "color-muted hover:color-base"
              }`}
              disabled={updater.phase !== "idle"}
              onClick={() => void changeUpdateSource(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-6">
        <span className="min-w-0 truncate text-mini color-faint">
          当前版本 v{version ?? "…"}
        </span>
        <div className="flex flex-none items-center gap-2.5">
          {updater.phase === "idle" && (
            <button
              type="button"
              className="btn-action"
              onClick={() => void updater.check()}
            >
              检查更新
            </button>
          )}
          {updater.phase === "checking" && (
            <span className="text-mini color-faint">正在检查…</span>
          )}
          {updater.phase === "available" && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => void updater.downloadAndInstall()}
            >
              下载并安装 v{updater.newVersion}
            </button>
          )}
          {updater.phase === "downloading" && (
            <span className="text-mini tabular-nums color-faint">
              正在下载 {updater.progressLabel ?? "…"}
            </span>
          )}
          {updater.phase === "ready" && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => void updater.relaunch()}
            >
              重启生效
            </button>
          )}
        </div>
      </div>

      {updater.phase === "downloading" && updater.progress?.total != null && (
        <div className="h-1 w-full max-w-md overflow-hidden rounded-full bg-sunken">
          <div
            className="h-full rounded-full bg-primary-500 transition-all duration-300 ease-out dark:bg-neutral-300"
            style={{
              width: `${Math.min(
                100,
                Math.round((updater.progress.downloaded / updater.progress.total) * 100),
              )}%`,
            }}
          />
        </div>
      )}

      {(updater.message || updater.error) && (
        <p
          className={`m-0 text-mini leading-6 ${
            updater.error ? "text-error-600 dark:text-error-400" : "color-faint"
          }`}
        >
          {updater.error ?? updater.message}
          {updater.phase === "idle" && updater.message === "已是最新版本" && (
            <>
              {" "}
              <button
                type="button"
                className="btn-action ml-1 h-6 px-2 py-0 text-mini"
                onClick={updater.openReleasePage}
              >
                查看发布页
              </button>
            </>
          )}
        </p>
      )}
      {updater.phase === "available" && updater.notes && (
        <p className="m-0 line-clamp-3 text-mini leading-6 color-faint">{updater.notes}</p>
      )}
      {error && <p className="m-0 text-mini leading-6 text-error-600">{error}</p>}
    </section>
  );
}
