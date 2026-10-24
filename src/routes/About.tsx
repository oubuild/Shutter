/**
 * About section: version, where files live, and the keyboard shortcut.
 *
 * Deliberately sparse — this is the "what is this and where does it put things"
 * page, not a marketing page.
 */

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api, errorText } from "../lib/ipc";
import { useAppUpdater } from "../lib/updater";
import { formatAccelerator } from "../lib/shortcut";

export function About() {
  const [dir, setDir] = useState<string | null>(null);
  const [captureAccel, setCaptureAccel] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updater = useAppUpdater();

  useEffect(() => {
    api
      .saveDirectory()
      .then(setDir)
      .catch((e) => setError(errorText(e)));
    api
      .getSettings()
      .then((s) => setCaptureAccel(s.captureShortcut))
      .catch(() => undefined);
    // Read from the bundle so the page never disagrees with tauri.conf.json.
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-6 py-5">
      <div className="mb-4 flex items-center gap-3.5">
        {/* The real app icon (same source as src-tauri/icons/icon.png) —
            macOS rounds the dock/canvas corners itself, so square is correct
            here; the previous gradient "S" placeholder is gone. */}
        <img
          src="icon-256.png"
          alt="Shutter"
          width={48}
          height={48}
          className="h-12 w-12 flex-none rounded-xl"
          draggable={false}
        />
        <div>
          <h1 className="m-0 text-lg font-600 color-base">Shutter</h1>
          <div className="text-mini color-faint">版本 {version ?? "…"}</div>
        </div>
      </div>

      <p className="mb-5 mt-0 max-w-[56ch] text-compact leading-7 color-muted">
        常驻菜单栏的截图工具：⌘⇧A 框选，就地标注，然后复制、保存、贴图，
        或者交给视觉模型提取文字、翻译、解释。
      </p>

      <section className="border-t border-base py-3.5">
        <h2 className="mb-2.5 mt-0 text-micro font-600 tracking-wider uppercase color-faint">
          文件位置
        </h2>
        <div className="flex items-center gap-2.5 py-1 text-compact">
          <span className="w-32 flex-none color-muted">截图保存</span>
          <code className="min-w-0 flex-1 truncate font-mono text-mini color-faint">
            {dir ?? error ?? "…"}
          </code>
          <button
            type="button"
            className="btn-action"
            onClick={() => dir && void api.openDirectory(dir).catch(() => undefined)}
            disabled={!dir}
          >
            打开
          </button>
        </div>
        <div className="flex items-center gap-2.5 py-1 text-compact">
          <span className="w-32 flex-none color-muted">配置与帧缓存</span>
          <code className="min-w-0 flex-1 truncate font-mono text-mini color-faint">
            ~/Library/Application Support/Shutter
          </code>
        </div>
        <div className="flex items-center gap-2.5 py-1 text-compact">
          <span className="w-32 flex-none color-muted">API Key</span>
          <span className="text-mini color-faint">保存在 macOS 钥匙串，不写入配置文件</span>
        </div>
      </section>

      <section className="border-t border-base py-3.5">
        <h2 className="mb-2.5 mt-0 text-micro font-600 tracking-wider uppercase color-faint">
          快捷键
        </h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-5 gap-y-1">
          {[
            [captureAccel ? formatAccelerator(captureAccel) : "⌘⇧A", "开始截图"],
            ["Esc", "取消截图 / 关闭预览"],
            ["Enter", "确认并复制"],
            ["⌘S", "确认并保存"],
            ["⌘Z", "撤销上一个标注"],
            ["1 – 9", "切换标注工具"],
          ].map(([key, label]) => (
            <div key={key} className="flex items-center gap-2.5 py-0.5 text-compact">
              <kbd className="app-kbd flex-none">{key}</kbd>
              <span className="color-muted">{label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-base py-3.5">
        <h2 className="mb-2.5 mt-0 text-micro font-600 tracking-wider uppercase color-faint">
          软件更新
        </h2>
        <div className="flex items-center gap-2.5 py-1 text-compact">
          <span className="w-32 flex-none color-muted">当前版本</span>
          <span className="min-w-0 flex-1 text-mini color-faint">
            v{version ?? "…"}
          </span>
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
          <p className="mb-0 mt-1.5 line-clamp-3 text-mini leading-6 color-faint">
            {updater.notes}
          </p>
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
      </section>

      <section className="border-t border-base py-3.5">
        <h2 className="mb-2.5 mt-0 text-micro font-600 tracking-wider uppercase color-faint">
          隐私
        </h2>
        <p className="text-mini leading-7 color-faint">
          只有点击 AI 动作时，当前选区的图片才会发往你在设置里配置的端点。
          没有遥测，没有后台服务；检查更新只在你点击时访问 GitHub Releases。
        </p>
      </section>
    </div>
  );
}
