# cap-photo

macOS 截图 + 标注 + 贴图 + 多模型视觉助手。

> 由 [oubuild](https://github.com/oubuild) 构建。截图交互参考了小旺AI截图的设计语言，
> 代码与美术资源全部独立实现。

## 功能

- **截图**：`⌘⇧A` 或托盘菜单，多显示器各自一个透明覆层
- **标注**：矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 / 文字 / 高亮 / 序号 / 取色，`⌘Z` 撤销
- **输出**：复制到剪贴板、保存到 `~/Pictures/cap-photo/`、贴图置顶（可拖动、滚轮缩放）
- **AI**：提取文字 / 翻译 / 解释 / 自由提问，流式返回
- **任意模型**：任何兼容 OpenAI Chat Completions 且支持 `image_url` 的端点

## 快速开始

```bash
pnpm install
pnpm app:dev
```

首次运行：

1. 系统设置 → 隐私与安全性 → **屏幕录制**，勾选 cap-photo
2. 托盘图标 → **设置…**，填入服务地址 / 模型 / API Key
3. `⌘⇧A` 截图

## 模型配置

设置页提供预设，也可手填：

| 服务 | base URL | 模型 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Ollama | `http://127.0.0.1:11434/v1` | `llava` |

请求地址会自动补 `/chat/completions`。模型必须支持图片输入。

**API Key 存在 macOS 钥匙串**（service `cap-photo`），不写入配置文件，前端也拿不到。

## 测试

```bash
pnpm typecheck                      # 前端类型
cd src-tauri && cargo test          # 单元 + AI 集成（本地 mock SSE）
cd src-tauri && cargo test --test capture_pipeline -- --ignored   # 真实屏幕
cd src-tauri && cargo test --test ai_stream -- --ignored live_deepseek  # 真实模型（消耗额度）
```

真实屏幕测试需要屏幕录制权限，否则 `screencapture` 只能拿到壁纸。

## 结构

```
src/                    React 前端
  routes/Overlay.tsx    截图覆层（选区 + 标注 + 工具条）
  routes/Pin.tsx        贴图窗口
  routes/Chat.tsx       AI 流式对话
  routes/Settings.tsx   设置
  canvas/               标注图元与 Konva 渲染
src-tauri/src/
  capture.rs            显示器枚举与抓帧（xcap）
  compose.rs            坐标换算、裁切、标注合成（唯一换算点）
  session.rs            全分辨率帧与会话
  ai.rs                 OpenAI 兼容流式请求（SSE）
  settings.rs           配置 + 钥匙串
  overlay.rs / pin.rs / windows.rs / commands.rs
```

坐标约定见 `src-tauri/src/types.rs` 顶部注释：前端只传 CSS px，Rust 在
`compose::to_pixel_rect` 里**只做一次** `× scale_factor`。

## 许可证

MIT
