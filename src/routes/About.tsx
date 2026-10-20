/**
 * About section: version, where files live, and the keyboard shortcut.
 *
 * Deliberately sparse — this is the "what is this and where does it put things"
 * page, not a marketing page.
 */

import { useEffect, useState } from "react";
import { api, errorText } from "../lib/ipc";

export function About() {
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .saveDirectory()
      .then(setDir)
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <div className="about">
      <div className="about-hero">
        <div className="about-mark">S</div>
        <div>
          <h1>Shutter</h1>
          <div className="about-version">版本 0.1.0</div>
        </div>
      </div>

      <p className="about-lead">
        常驻菜单栏的截图工具：⌘⇧A 框选，就地标注，然后复制、保存、贴图，
        或者交给视觉模型提取文字、翻译、解释。
      </p>

      <section className="about-section">
        <h2>文件位置</h2>
        <div className="about-row">
          <span className="about-label">截图保存</span>
          <code className="about-path">{dir ?? error ?? "…"}</code>
          <button
            type="button"
            onClick={() => dir && void api.openDirectory(dir).catch(() => undefined)}
            disabled={!dir}
          >
            打开
          </button>
        </div>
        <div className="about-row">
          <span className="about-label">配置与帧缓存</span>
          <code className="about-path">~/Library/Application Support/Shutter</code>
        </div>
        <div className="about-row">
          <span className="about-label">API Key</span>
          <span className="about-note">保存在 macOS 钥匙串，不写入配置文件</span>
        </div>
      </section>

      <section className="about-section">
        <h2>快捷键</h2>
        <div className="about-keys">
          {[
            ["⌘⇧A", "开始截图"],
            ["Esc", "取消截图 / 关闭预览"],
            ["Enter", "确认并复制"],
            ["⌘S", "确认并保存"],
            ["⌘Z", "撤销上一个标注"],
            ["1 – 9", "切换标注工具"],
          ].map(([key, label]) => (
            <div key={key} className="about-key-row">
              <kbd>{key}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="about-section">
        <h2>隐私</h2>
        <p className="about-note">
          只有点击 AI 动作时，当前选区的图片才会发往你在设置里配置的端点。
          没有遥测，没有自动更新，没有后台服务。
        </p>
      </section>
    </div>
  );
}
