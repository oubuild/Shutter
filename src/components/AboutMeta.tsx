/**
 * 环境与数据 rows + the privacy notice — the shared tail of the About window
 * and the 更多设置 window's 更新与关于 tab. Self-contained: it loads the save
 * directory itself so both hosts stay one-liners.
 */

import { useEffect, useState } from "react";
import { api, errorText } from "../lib/ipc";

export function AboutMeta() {
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .saveDirectory()
      .then(setDir)
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <>
      <section className="flex flex-col gap-3" aria-label="环境与数据">
        <div className="pref-group-title pl-0">环境与数据</div>
        <div className="flex flex-col text-mini">
          <div className="flex items-center justify-between gap-3 py-1.5">
            <span className="w-20 flex-none color-muted">截图存储</span>
            <code className="min-w-0 flex-1 truncate px-2 font-mono text-mini color-base">
              {dir ?? error ?? "…"}
            </code>
            <button
              type="button"
              className="flex-none text-mini color-base underline underline-offset-2 hover:color-primary-600"
              onClick={() => dir && void api.openDirectory(dir).catch(() => undefined)}
              disabled={!dir}
            >
              打开
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-mute py-1.5">
            <span className="w-20 flex-none color-muted">配置与缓存</span>
            <code className="min-w-0 flex-1 truncate px-2 font-mono text-mini color-faint">
              ~/Library/Application Support/Shutter
            </code>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-mute py-1.5">
            <span className="w-20 flex-none color-muted">API 密钥</span>
            <span className="min-w-0 flex-1 px-2 text-success-700 dark:text-success-400">
              保存在 macOS 钥匙串，不写入配置文件
            </span>
          </div>
        </div>
      </section>

      <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-mute bg-sunken p-2.5 text-mini leading-6 color-muted">
        <svg
          className="mt-0.5 h-4 w-4 flex-none color-faint"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        <div>
          <b className="font-500 color-base">纯本地安全策略：</b>
          无遥测埋点与后台常驻服务。仅当主动点击 AI 动作时，当前选区图片才会发往你在「AI 服务」中配置的端点。
        </div>
      </div>
    </>
  );
}
