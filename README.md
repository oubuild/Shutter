# Shutter

截图 · 标注 · 贴图 · 多模型视觉助手，macOS / Windows / Linux 三平台。

一个常驻菜单栏 / 托盘的原生小工具：`⌘⇧A` 框选截图，就地标注，然后复制、保存、贴到屏幕上，
或者直接丢给视觉模型提取文字、翻译、解释。

> 仓库名与对外名称是 **Shutter**；包名（`shutter`）、bundle identifier 与系统凭据
> service（`dev.oubuild.shutter`）等内部标识保持原样，没有跟着改名。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS 12+ / Windows / Linux](https://img.shields.io/badge/platform-macOS%2012%2B%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24c8db)

## 功能

- **截图**：`⌘⇧A`（Windows / Linux 为 `Ctrl+Shift+A`）或点击菜单栏 / 托盘图标；多显示器各自一个透明覆层，选区可整体拖动、八向手柄缩放
- **标注**：矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 / 文字 / 高亮 / 序号 / 取色，`⌘Z` 撤销
- **长截图**：选区后点工具栏「长截图」或按 `C`——自动滚动注入（仅 macOS，需辅助功能权限；无权限时改为手动滚动 + 控制条暂停/继续），逐帧行签名位移估计 + MAE / 边缘 NCC / 行完整性多重校验，置信度不足原地重抓、拒绝硬拼（宁可少拼一帧），固定顶栏自动去重，实时预览缩略图，完成可保存 / 复制 / 取消
- **输出**：复制到剪贴板、保存到系统「图片」目录下的 `Shutter/`（macOS 为 `~/Pictures/Shutter/`）、贴图置顶（拖动移动、滚轮缩放、双击关闭）
- **AI**：提取文字 / 翻译 / 解释 / 自由提问，流式返回，回答可一键复制
- **任意模型**：任何兼容 OpenAI Chat Completions 且接受 `image_url` 的端点，内置常用预设

## 系统要求

- macOS 12.0 及以上（Apple Silicon / Intel）
- Windows（x64）
- Linux x64，`.deb` 以 Ubuntu 24.04 为构建基线
- 构建需要 Rust ≥ 1.90、Node.js ≥ 20、pnpm
- Linux 构建还需要 webkit2gtk 4.1、GTK 3、libayatana-appindicator3、D-Bus，以及 PipeWire ≥ 0.3.65 的开发头文件（`libpipewire-0.3-dev`、`libspa-0.2-dev`）：`libspa-sys` 要用 bindgen 对着系统头文件生成绑定，libspa 0.10 至少要 0.3.65，Ubuntu 22.04 的 0.3.48 编不过，所以 CI 固定在 ubuntu-24.04

## 平台差异

截图 / 标注 / 贴图 / AI 动作三平台一致，下面这些能力目前只有 macOS 是完整的：

| 功能 | macOS | Windows / Linux |
| --- | --- | --- |
| 长截图自动滚动注入与滚轮监听 | 支持（需辅助功能权限） | 不支持，改为定时抓帧，滚动由使用者自己完成 |
| 窗口悬停识别（自动框住光标下的窗口） | 支持 | 不支持，退化为自由框选 |
| 目录选择 / 另存为对话框 | 原生对话框 | Windows 走 PowerShell 原生对话框；Linux 未接，命令直接报错 |
| 启动权限预检 | 启动只请求屏幕录制，辅助功能在长截图开始时检查 | 无此流程 |
| 菜单栏常驻（不进 Dock） | 支持 | 常规窗口 + 托盘 |
| API Key 存储 | 系统钥匙串 | Windows 凭据管理器 / Linux Secret Service（GNOME Keyring、KWallet） |

## 安装

从 [releases/latest](https://github.com/oubuild/Shutter/releases/latest) 下载对应平台的文件（文件名里的 `*` 是版本号）：

| 平台 | 文件 |
| --- | --- |
| macOS (Apple Silicon) | `Shutter_*_aarch64.dmg` |
| macOS (Intel) | `Shutter_*_x64.dmg` |
| Windows | `Shutter_*_x64-setup.exe`（NSIS）、`Shutter_*_x64_en-US.msi` |
| Linux | `Shutter_*_amd64.deb`、`Shutter_*_amd64.AppImage` |

macOS 构建为 ad-hoc 签名、未公证。首次打开会被拦下，走
系统设置 → 隐私与安全性 → 仍要打开。`releases/latest` 始终指向最新 tag，具体版本号以该 release 页为准。

## 快速开始

```bash
pnpm install
pnpm app:dev        # 开发模式，前端热更新
pnpm app:build      # 打包本平台安装包到 src-tauri/target/release/bundle/
```

首次运行：

1. 系统设置 → 隐私与安全性 → **屏幕录制**，勾选 Shutter（macOS；Windows / Linux 没有这一步）
2. **辅助功能**权限不在启动时请求：长截图开始时静默检查，缺权限就回退到手动滚动，控制条会提示「无辅助功能权限，请手动滚动页面」
3. 菜单栏 / 托盘图标 → **设置…**，填入服务地址 / 模型 / API Key
4. `⌘⇧A` 截图

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `⌘⇧A`（Windows / Linux 为 `Ctrl+Shift+A`） | 开始截图（全局） |
| `Esc` | 取消截图 |
| `Enter` / `⌘C` | 确认并复制 |
| `⌘S` | 确认并保存 |
| `⌘Z` | 撤销上一个标注 |
| `1` – `9` | 切换矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 / 文字 / 高亮 / 序号 / 取色 |

（`⌘` 在 Windows / Linux 上对应 `Ctrl`。）

## 模型配置

设置页提供预设，也可手填任意兼容端点：

| 服务 | base URL | 模型 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Ollama | `http://127.0.0.1:11434/v1` | `llava` |

请求地址会自动补 `/chat/completions`。模型必须支持图片输入，否则会返回错误。

## 隐私

- **API Key 存在系统凭据存储**（service `dev.oubuild.shutter`：macOS 钥匙串 / Windows 凭据管理器 / Linux Secret Service），不写入配置文件，前端拿不到
- 截图帧与设置存放在系统应用数据目录下的 `Shutter/`（macOS 为 `~/Library/Application Support/Shutter/`，帧在 `frames/`），新一次截图会清理上一帧
- 只有点击 AI 动作时，当前选区的 PNG 才会发往你配置的端点；除此之外没有网络请求
- 无遥测、无自动更新、无后台服务

## 结构

```
src/                    React 前端
  routes/Overlay.tsx    截图覆层（选区 + 标注 + 工具条）
  routes/Pin.tsx        贴图窗口
  routes/Chat.tsx       AI 流式对话
  routes/Settings.tsx   设置
  routes/               另含 Main / Gallery / About / ScrollBar
  canvas/               标注图元与 Konva 渲染（model.ts、ShapeNode.tsx）
  components/           工具条、预览、确认、快捷键录制
  lib/                  IPC 封装、几何换算、快捷键解析
src-tauri/src/
  capture.rs            显示器枚举与抓帧（xcap）；macOS 另含窗口枚举
  compose.rs            坐标换算、裁切、标注合成（唯一换算点）
  session.rs            全分辨率帧与会话
  ai.rs                 OpenAI 兼容流式请求（SSE）
  settings.rs           配置 + 系统凭据存储
  scroll/               长截图：抓帧管线、位移估计与拼接（autoscroll / pipeline / stitch / types）
  output.rs             复制 / 保存 / 贴图的落地
  gallery.rs            历史截图列表
  overlay.rs / pin.rs / windows.rs / commands.rs
```

坐标约定见 [`src-tauri/src/types.rs`](src-tauri/src/types.rs) 顶部注释：前端只传 CSS px，
Rust 在 `compose::to_pixel_rect` 里**只做一次** `× scale_factor`。

## 发版

发布完全由人手动触发，且只走 tag：本地跑 `pnpm release`（基于 antfu 的
[bumpp](https://github.com/antfu/bumpp)），交互式选择新版本号后，它会同步
`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 与
`src-tauri/Cargo.lock` 四处版本，提交 `chore: release vX.Y.Z` 并推送 `v*` tag。

tag 推送后 CI 接管：

1. [changelogithub](https://github.com/antfu/changelogithub) 从 Conventional
   Commits 生成变更日志，创建**草稿** Release
2. 四个构建目标（macOS arm64 / macOS x64 / Windows x64 / Linux x64）各自构建安装包并传到该 Release
3. 全部成功且安装包齐全后，publish job 自动把草稿发布为正式 Release

任一平台失败则草稿保持原状，由人决定重试或修复。约定：功能提交用
`feat:` / `fix:` / `chore:` 等规范前缀，changelog 会按此分组。

## 测试

```bash
pnpm typecheck                      # 前端类型
cd src-tauri && cargo test          # 单元 + AI 集成（本地 mock SSE）
cd src-tauri && cargo test --test capture_pipeline -- --ignored   # 真实屏幕
cd src-tauri && cargo test --lib capture::tests::capture_works -- --ignored   # 真实屏幕（抓帧）
cd src-tauri && cargo test --test ai_stream -- --ignored live_deepseek  # 真实模型（消耗额度）
```

真实屏幕测试需要屏幕录制权限，否则只能拿到壁纸或黑帧。

## 常见问题

- **macOS 首次打开被拦下**：构建是 ad-hoc 签名、未公证，走 系统设置 → 隐私与安全性 → 仍要打开
- **Windows / Linux 上长截图不会自己滚**：这两个平台没有滚动注入，需要你自己滚动，程序按定时抓帧拼接
- **Linux 上「选择保存目录」「另存为」不可用**：对话框没有接，改在设置里手填路径或直接用默认的图片目录
- **截出来是黑图 / 壁纸**：macOS 上检查「屏幕录制」权限，没授权时系统返回的是黑帧而不是报错

## 致谢

截图交互参考了同类截图工具的设计语言；代码与美术资源均为独立实现。

## 许可证

[MIT](LICENSE) © Oubuild
