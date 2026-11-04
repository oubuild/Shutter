/**
 * About window: brand, keyboard shortcuts, updates and the shared 环境与数据
 * tail (AboutMeta). Deliberately sparse — the "what is this and where does it
 * put things" page; rows follow the same flat label-value grammar as the
 * settings panes.
 */

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api } from "../lib/ipc";
import { formatAccelerator } from "../lib/shortcut";
import { UpdatePanel } from "../components/UpdatePanel";
import { AboutMeta } from "../components/AboutMeta";

export function About() {
  const [captureAccel, setCaptureAccel] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-8 py-6">
      <div className="mb-6 flex flex-col items-center gap-2.5 pt-1 text-center">
        {/* The real app icon (same source as src-tauri/icons/icon.png) —
            macOS rounds the dock/canvas corners itself, so square is correct
            here; the previous gradient "S" placeholder is gone. */}
        <img
          src="icon-256.png"
          alt="Shutter"
          width={64}
          height={64}
          className="h-16 w-16 flex-none rounded-[18px] shadow-lg"
          draggable={false}
        />
        <div>
          <h1 className="m-0 text-[17px] font-600 tracking-tight color-base">Shutter</h1>
          <div className="mt-1 inline-flex items-center rounded-full bg-sunken px-2 py-0.5 text-micro font-500 color-muted">
            版本 {version ?? "…"}
          </div>
        </div>
        <p className="mx-auto mb-0 mt-2.5 max-w-[46ch] text-mini leading-6 color-muted">
          常驻菜单栏的截图工具：
          <span className="font-mono color-base">
            {captureAccel ? formatAccelerator(captureAccel) : "⌘⇧A"}
          </span>{" "}
          框选，就地标注，然后复制、保存、贴图，或交给视觉模型提取文字、翻译、解释。
        </p>
      </div>

      <section className="flex flex-col gap-3" aria-label="快捷键">
        <div className="pref-group-title pl-0">快捷键</div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-6 gap-y-1">
          {[
            [captureAccel ? formatAccelerator(captureAccel) : "⌘⇧A", "开始截图"],
            ["Esc", "取消截图 / 关闭预览"],
            ["Enter", "确认并复制"],
            ["⌘S", "确认并保存"],
            ["⌘Z", "撤销上一个标注"],
            ["1 – 9", "切换标注工具"],
          ].map(([key, label]) => (
            <div
              key={key}
              className="flex items-center justify-between rounded-lg px-2.5 py-1.5 transition-colors hover:bg-hover"
            >
              <span className="text-mini color-muted">{label}</span>
              <kbd className="app-kbd">{key}</kbd>
            </div>
          ))}
        </div>
      </section>

      <div className="pref-divider ml-0" />

      <UpdatePanel />

      <div className="pref-divider ml-0" />

      <AboutMeta />
    </div>
  );
}
