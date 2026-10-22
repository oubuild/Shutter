// bumpp 配置（pnpm release 使用，见 scripts/release.mjs）。
//
// 只让 bumpp 改版本号、不做任何 git 操作：提交、打 tag、推送由
// scripts/release.mjs 统一处理，因为提交里还要包含 cargo 同步出的
// src-tauri/Cargo.lock（bumpp 自己只会提交它改过的文件）。
//
// Cargo.lock 不放进 files：bumpp 对文本文件做的是全局整词替换，
// 锁文件里其他依赖可能恰好与旧版本同号，会被误改。
export default {
  files: [
    'package.json',
    'src-tauri/tauri.conf.json',
    'src-tauri/Cargo.toml',
  ],
  commit: false,
  tag: false,
  push: false,
}
