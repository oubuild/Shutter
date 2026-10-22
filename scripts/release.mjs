#!/usr/bin/env node
/**
 * Shutter 发版脚本（antfu 工具链：bumpp）
 *
 * 用法：pnpm release
 *
 * 流程：
 *   1. 守卫：必须在 main 分支、工作树干净、不落后于远端
 *   2. bumpp 交互式选择新版本号，同步 package.json /
 *      src-tauri/tauri.conf.json / src-tauri/Cargo.toml
 *   3. cargo update -w --offline 同步 src-tauri/Cargo.lock
 *      （不能让 bumpp 对 Cargo.lock 做全局文本替换：锁文件里其他
 *        依赖可能恰好同版本号，会被误改）
 *   4. 校验四处版本一致、无预期外改动后：
 *      提交 chore: release vX.Y.Z、打 tag、推送 main 与 tag
 *
 * 之后 CI（.github/workflows/build.yml）接管：tag 触发 changelogithub
 * 生成说明并创建草稿 Release，四个平台把安装包传上去，
 * 全部成功后由 publish job 自动发布。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const VERSION_FILES = [
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
]

function fail (message) {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

function step (name) {
  console.log(`\n▸ ${name}`)
}

/** 交互式运行：失败时以相同退出码终止 */
function run (cmd, args, { cwd } = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd })
  if (result.error) {
    fail(`无法执行 ${cmd}：${result.error.message}（是否已安装并在 PATH 中？）`)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
  return result
}

/** 静默捕获 stdout，失败即终止 */
function capture (cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    fail(`命令失败：${cmd} ${args.join(' ')}\n${result.stderr ?? ''}`)
  }
  return result.stdout.trim()
}

// ---------------------------------------------------------------------------
// 1. 守卫
// ---------------------------------------------------------------------------
step('检查工作区')

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') {
  fail(`发版必须在 main 分支上执行（当前在 ${branch}）`)
}

const dirty = capture('git', ['status', '--porcelain'])
if (dirty) {
  fail(`工作树不干净，请先提交或清理：\n${dirty}`)
}

capture('git', ['fetch', 'origin', 'main'])
const behind = Number(capture('git', ['rev-list', '--count', 'HEAD..origin/main']))
if (behind > 0) {
  fail(`本地 main 落后远端 ${behind} 个提交，请先 git pull`)
}

const oldVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
console.log(`  当前版本 v${oldVersion}`)

// ---------------------------------------------------------------------------
// 2. bumpp：选择新版本号并写入三个版本文件
//    （版本文件列表与 git 开关见 bump.config.mjs）
// ---------------------------------------------------------------------------
step('bumpp：选择新版本号')

// 交互模式直接 `pnpm release`；带参数（如 `pnpm release minor`）则非交互执行。
const extraArgs = process.argv.slice(2)
const bumppArgs = ['exec', 'bumpp']
if (extraArgs.length) bumppArgs.push('--release', extraArgs[0], '-y')

const bumpp = spawnSync('pnpm', bumppArgs, { stdio: 'inherit' })

if (bumpp.status !== 0) {
  if (!capture('git', ['status', '--porcelain'])) {
    console.log('\n已取消，没有任何改动。')
    process.exit(0)
  }
  fail('bumpp 执行失败')
}

const newVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
if (newVersion === oldVersion) {
  console.log(`\n版本未变化（v${oldVersion}），未发版。`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 3. 同步 Cargo.lock
// ---------------------------------------------------------------------------
step('同步 src-tauri/Cargo.lock')

run('cargo', ['update', '-w', '--offline'], { cwd: 'src-tauri' })

// ---------------------------------------------------------------------------
// 4. 校验
// ---------------------------------------------------------------------------
step('校验版本一致性')

const versions = {
  'package.json': newVersion,
  'src-tauri/tauri.conf.json': JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version,
  'src-tauri/Cargo.toml': readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  'src-tauri/Cargo.lock': readFileSync('src-tauri/Cargo.lock', 'utf8').match(/^name = "shutter"\nversion = "([^"]+)"/m)?.[1],
}

const mismatched = Object.entries(versions).filter(([, v]) => v !== newVersion)
if (mismatched.length) {
  fail(`版本不一致，期望 v${newVersion}：\n${
    mismatched.map(([f, v]) => `  ${f}: ${v ?? '(未找到)'}`).join('\n')
  }`)
}
console.log(`  四处均为 v${newVersion} ✓`)

const changed = capture('git', ['status', '--porcelain']).split('\n').filter(Boolean)
const unexpected = changed.filter(line => !VERSION_FILES.some(f => line.endsWith(f)))
if (unexpected.length) {
  fail(`出现了预期之外的文件改动：\n${unexpected.join('\n')}`)
}

// ---------------------------------------------------------------------------
// 5. 提交、打 tag、推送
// ---------------------------------------------------------------------------
step('提交并打 tag')

run('git', ['add', ...VERSION_FILES])
run('git', ['commit', '-m', `chore: release v${newVersion}`])
run('git', ['tag', `v${newVersion}`])

step('推送到远端')

run('git', ['push', 'origin', 'main'])
run('git', ['push', 'origin', `v${newVersion}`])

console.log(`
✔ v${oldVersion} → v${newVersion} 已推送。

  CI 将生成 changelog、构建四个平台的安装包并挂到草稿 Release，
  全部成功后自动发布：
  https://github.com/oubuild/Shutter/actions
`)
