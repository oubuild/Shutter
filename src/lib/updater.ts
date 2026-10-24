/**
 * App-update flow over tauri-plugin-updater (GitHub Releases, single source).
 *
 * Deliberately manual: the About page promises no background services, so
 * nothing runs until the user clicks "检查更新". The plugin fetches the
 * endpoints configured in tauri.conf.json (releases/latest/download/latest.json)
 * and verifies package signatures against the pubkey bundled there — a
 * tampered release fails verification instead of installing.
 */

import { useCallback, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready";

export type DownloadProgress = { downloaded: number; total: number | null };

/** The dev browser mock has no Tauri IPC; plugin calls would just throw. */
function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function useAppUpdater() {
  const [phase, setPhase] = useState<UpdaterPhase>("idle");
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const updateRef = useRef<Update | null>(null);

  const check = useCallback(async () => {
    if (!isTauriRuntime()) {
      setError("浏览器预览模式不支持检查更新");
      return;
    }
    setPhase("checking");
    setError(null);
    setMessage(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      updateRef.current = update;
      if (!update) {
        setPhase("idle");
        setMessage("已是最新版本");
        return;
      }
      setNewVersion(update.version);
      setNotes(update.body ?? null);
      setPhase("available");
    } catch (e) {
      updateRef.current = null;
      setPhase("idle");
      setError(`检查更新失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update || phase !== "available") return;
    setPhase("downloading");
    setError(null);
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            downloaded = 0;
            setProgress({ downloaded: 0, total: event.data.contentLength ?? null });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress((p) => ({ downloaded, total: p?.total ?? null }));
            break;
          case "Finished":
            setProgress((p) => ({ downloaded: p?.total ?? downloaded, total: p?.total ?? downloaded }));
            break;
        }
      });
      // The NSIS installer owns process replacement on Windows (the app exits
      // and the installer relaunches it); everywhere else we relaunch here.
      if (!navigator.userAgent.includes("Windows")) {
        setPhase("ready");
        setMessage("更新已安装，重启后生效");
        return;
      }
      setMessage("更新已下载，安装器将在应用退出后完成安装");
      setPhase("idle");
    } catch (e) {
      setPhase("available");
      setError(`下载或安装失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [phase]);

  const relaunch = useCallback(async () => {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setError(`重启失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const openReleasePage = useCallback(() => {
    const url = "https://github.com/oubuild/Shutter/releases/latest";
    void import("@tauri-apps/plugin-opener")
      .then(({ openUrl }) => openUrl(url))
      .catch(() => window.open(url, "_blank", "noopener,noreferrer"));
  }, []);

  return {
    phase,
    newVersion,
    notes,
    message,
    error,
    progress,
    /** Human-readable "12.3 MB / 45.6 MB" for the download row. */
    progressLabel: progress
      ? progress.total
        ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
        : formatBytes(progress.downloaded)
      : null,
    check,
    downloadAndInstall,
    relaunch,
    openReleasePage,
  };
}
