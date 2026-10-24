/**
 * App-update flow over the Rust command layer (src-tauri/src/updater.rs).
 *
 * Two download sources, switchable in the About page and persisted in
 * settings: the CNB mirror (default, mainland-friendly) and GitHub Releases.
 * Both discover the latest release through the GitHub manifest; the backend
 * swaps the installer download URL to CNB when the mirror already has it, so
 * a release that hasn't been synced yet silently falls back to GitHub.
 *
 * Deliberately manual: the About page promises no background services, so
 * nothing runs until the user clicks "检查更新".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, type AppUpdateProgress, type UpdateSource } from "./ipc";

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

export function useAppUpdater(source: UpdateSource) {
  const [phase, setPhase] = useState<UpdaterPhase>("idle");
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const busyRef = useRef(false);

  // Switching sources invalidates whatever the previous source reported.
  useEffect(() => {
    setPhase("idle");
    setNewVersion(null);
    setNotes(null);
    setMessage(null);
    setError(null);
    setProgress(null);
  }, [source]);

  const check = useCallback(async () => {
    if (busyRef.current) return;
    if (!isTauriRuntime()) {
      setError("浏览器预览模式不支持检查更新");
      return;
    }
    busyRef.current = true;
    setPhase("checking");
    setError(null);
    setMessage(null);
    try {
      const info = await api.checkAppUpdate(source);
      if (!info) {
        setPhase("idle");
        setMessage("已是最新版本");
        return;
      }
      setNewVersion(info.latestVersion);
      setNotes(info.notes);
      setPhase("available");
    } catch (e) {
      setPhase("idle");
      setError(`检查更新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busyRef.current = false;
    }
  }, [source]);

  const downloadAndInstall = useCallback(async () => {
    if (busyRef.current || !newVersion || phase !== "available") return;
    busyRef.current = true;
    setPhase("downloading");
    setError(null);
    setProgress(null);
    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<AppUpdateProgress>("app-update-progress", ({ payload }) => {
        setProgress({ downloaded: payload.downloaded, total: payload.total });
      });
      await api.installAppUpdate(source, newVersion);
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
      const text = e instanceof Error ? e.message : String(e);
      if (text.includes("VERSION_CHANGED")) {
        // A newer release landed between check and install; re-check so the
        // button offers the version that will actually install.
        setPhase("idle");
        setMessage(null);
        await check();
        return;
      }
      setPhase("available");
      setError(`下载或安装失败：${text}`);
    } finally {
      unlisten?.();
      busyRef.current = false;
    }
  }, [check, newVersion, phase, source]);

  const relaunch = useCallback(async () => {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setError(`重启失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const openReleasePage = useCallback(() => {
    const url =
      source === "cnb"
        ? "https://cnb.cool/ryanuo/shutter/-/releases"
        : "https://github.com/oubuild/Shutter/releases/latest";
    void import("@tauri-apps/plugin-opener")
      .then(({ openUrl }) => openUrl(url))
      .catch(() => window.open(url, "_blank", "noopener,noreferrer"));
  }, [source]);

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
