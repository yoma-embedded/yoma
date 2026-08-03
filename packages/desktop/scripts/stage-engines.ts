#!/usr/bin/env bun
/**
 * 打包前的 engines 校验 + 实体化 —— 把三种"静默出坏包"的方式变成响亮的失败/警告。
 *
 * 背景:仓库根的 `engines` 是指向 ../my-pi/engines 的软链,bin/ 和 data/ 里又全是
 * 指向各引擎构建产物的软链。三个坑:
 *
 *   1. **没在 my-pi 跑过 `bun engines/build.ts`** → 软链悬空 → 这里直接失败。
 *   2. **electron-builder 对 extraResources 里的软链是原样保留,不 dereference**
 *      (实测:打出来的 Yoma.app 里 engines/bin/board_ir 还是一条指向
 *      ../controller_map/.venv/bin/board_ir 的断链,签名阶段 stat ENOENT)。
 *      → 所以这里把 engines **实体化**拷进 `.engines-stage/`(跟随软链、保留权限位),
 *      electron-builder 的 extraResources 指向暂存目录而不是原始软链。
 *   3. **venv console script**(shebang 指向构建机绝对路径)→ 拷到别人电脑上
 *      "bad interpreter" 必坏。根治要 my-pi 侧把 Python 引擎做成自包含产物,
 *      我们不改内核 → 响亮警告并列出受影响的工具。
 */

import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const enginesDir = path.resolve(desktopDir, "..", "..", "engines")
const stageDir = path.join(desktopDir, ".engines-stage")

function fail(message: string): never {
  console.error(`\n[stage-engines] ${message}`)
  console.error("[stage-engines] 先在 my-pi 仓库跑 `bun engines/build.ts`,再回来打包。\n")
  process.exit(1)
}

if (!existsSync(enginesDir)) fail(`找不到 engines 目录:${enginesDir}`)

// ---- 校验 --------------------------------------------------------------

const nonPortable: string[] = []
for (const sub of ["bin", "data"] as const) {
  const dir = path.join(enginesDir, sub)
  let entries: string[]
  try {
    entries = readdirSync(dir).filter((name) => !name.startsWith("."))
  } catch {
    fail(`engines/${sub} 不存在`)
  }
  if (entries.length === 0) fail(`engines/${sub} 是空的 —— 打出去的包会在用户第一次用硬件工具时才炸`)

  for (const name of entries) {
    const target = path.join(dir, name)
    // statSync 跟随软链:悬空软链在这里抛,正好变成响亮失败。
    let stat
    try {
      stat = statSync(target)
    } catch {
      fail(`engines/${sub}/${name} 是悬空软链(构建产物不在)`)
    }
    if (sub !== "bin" || !stat.isFile()) continue
    const head = readFileSync(target)
    if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) {
      const shebang = head.subarray(0, Math.min(head.length, 200)).toString("utf8").split("\n")[0]!
      nonPortable.push(`${name} → ${shebang}`)
    }
  }
}

if (nonPortable.length > 0) {
  console.warn("\n[stage-engines] ⚠ 以下引擎是解释器脚本,shebang 指向本机绝对路径,")
  console.warn("[stage-engines] ⚠ 打进安装包后在**别人的电脑上必坏**(bad interpreter):")
  for (const line of nonPortable) console.warn(`[stage-engines] ⚠   ${line}`)
  console.warn("[stage-engines] ⚠ 根治需要 my-pi 的 engines/build.ts 产出自包含可执行文件。")
  console.warn("[stage-engines] ⚠ 本次继续打包:除这几个工具外其余功能不受影响。\n")
}

// ---- 实体化 ------------------------------------------------------------

rmSync(stageDir, { recursive: true, force: true })
for (const sub of ["bin", "data"] as const) {
  // dereference: 把所有软链(含 data 深处的)替换成真实内容;权限位默认保留,
  // 二进制的可执行位跟着过来。内部若有悬空软链,cpSync 抛错 = 响亮失败。
  cpSync(path.join(enginesDir, sub), path.join(stageDir, sub), { recursive: true, dereference: true })
}

// data 里的文件全部剥掉可执行位。它们是芯片数据库/固件包/文档,不是 mac 可执行文件,
// 但源树里不少带着 755 —— electron-builder 的签名器按可执行位收集"待签二进制",
// 会把几万个数据文件一个一个 codesign(实测签到 CMSIS 文档的 PNG 上,一次打包要跑几小时)。
// 配置里同时给签名器加了 signIgnore,这里是双保险 + 权限卫生。
function stripExecBits(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      stripExecBits(target)
    } else {
      const mode = statSync(target).mode
      if ((mode & 0o111) !== 0) chmodSync(target, mode & ~0o111)
    }
  }
}
stripExecBits(path.join(stageDir, "data"))

// 拷完再验一遍产物:bin 里必须是可执行的真实文件,没有任何残留软链。
const staged = readdirSync(path.join(stageDir, "bin")).filter((name) => !name.startsWith("."))
for (const name of staged) {
  const file = path.join(stageDir, "bin", name)
  const stat = statSync(file)
  if (!stat.isFile()) fail(`.engines-stage/bin/${name} 不是普通文件`)
  if ((stat.mode & 0o111) === 0) fail(`.engines-stage/bin/${name} 丢了可执行位`)
}

console.log(`[stage-engines] 通过:${staged.length} 个引擎(${staged.join(", ")})已实体化到 .engines-stage/`)
