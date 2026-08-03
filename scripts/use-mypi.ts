#!/usr/bin/env bun
/**
 * 切换后端内核指向哪一个 my-pi 检出(主仓 / 任意 worktree)。
 *
 *   bun use-mypi                       # 看当前指向谁
 *   bun use-mypi ../my-pi/.claude/worktrees/verify-skill
 *   bun use-mypi --reset               # 回到默认的兄弟目录 ../my-pi
 *
 * 为什么要有这个脚本、而不是让你自己设个 MY_PI_DIR:my-pi 的路径映射有三份
 * (tsconfig.mypi.json、packages/kernel/tsconfig.json 的内联副本、打包期的 MY_PI_ALIASES),
 * 环境变量只能改到最后一份。**半切是这里最贵的失败** —— app 跑的是 worktree 的代码,
 * typecheck 和单测却还在验主仓那一份,两边全绿,而它们说的不是同一件事。
 *
 * 所以这里改的是两份 tsconfig(真源),mypi.ts 从 tsconfig.mypi.json 反推,自动跟上。
 * `packages/kernel/src/mypi-alias.test.ts` 负责在三份不一致时炸响。
 *
 * 改的是 **文本替换** 而不是重新序列化 JSON,格式和注释一个字都不动,
 * `git diff` 只有路径那几行 —— 切过的状态一眼可见,而不是藏在环境变量里。
 *
 * engines **不跟着切**。它是另一条软链(仓库根的 `engines`),里面是编译产物不是源码,
 * 而 worktree 基本不会去跑 `bun engines/build.ts`。真要跟着切,自己重指那条软链。
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MARKER = "packages/agent/src/index.ts"
const DEFAULT = path.resolve(repoRoot, "..", "my-pi")

/** 两份 tsconfig 都拿 `@yoma/my-pi` 那一条当锚,推出它当前用的前缀。 */
const CONFIGS = [path.join(repoRoot, "tsconfig.mypi.json"), path.join(repoRoot, "packages", "kernel", "tsconfig.json")]

function currentPrefix(file: string): string {
  const raw = readFileSync(file, "utf8")
  const match = raw.match(/"@yoma\/my-pi"\s*:\s*\[\s*"([^"]+)"/)
  if (!match?.[1]) throw new Error(`${path.relative(repoRoot, file)} 里找不到 @yoma/my-pi 的 paths 条目`)
  const entry = match[1]
  if (!entry.endsWith(MARKER)) throw new Error(`${path.relative(repoRoot, file)} 的条目不是 .../${MARKER}:${entry}`)
  return entry.slice(0, entry.length - MARKER.length - 1)
}

function currentRoot(): string {
  const file = CONFIGS[0]!
  return path.resolve(path.dirname(file), currentPrefix(file))
}

function relativeFrom(file: string, target: string): string {
  const rel = path.relative(path.dirname(file), target)
  // 保持相对写法(仓库里提交的默认值就是 ../my-pi,新克隆才能零配置),
  // 但如果目标在另一个盘/另一棵树上,相对路径会难看到没法读,那就写绝对的。
  return rel && rel.split(path.sep).filter((s) => s === "..").length <= 4 ? rel : target
}

function describe(): void {
  const root = currentRoot()
  const ok = existsSync(path.join(root, MARKER))
  console.log(`  内核源码 -> ${path.relative(repoRoot, root) || "."}`)
  console.log(`            = ${root}`)
  console.log(`            ${ok ? "就位" : "**找不到**(路径不对,或不是 my-pi 检出)"}`)
  for (const file of CONFIGS) console.log(`  ${path.relative(repoRoot, file)}: ${currentPrefix(file)}`)

  const engines = path.join(repoRoot, "engines")
  if (existsSync(engines)) {
    const target = lstatSync(engines).isSymbolicLink() ? readlinkSync(engines) : "(实体目录)"
    const built = existsSync(path.join(engines, "bin"))
    console.log(`  engines -> ${target}  ${built ? "已构建" : "**没有 bin/**,硬件工具会炸"}`)
  }
}

function point(to: string): void {
  const absolute = path.resolve(process.cwd(), to)
  if (!existsSync(path.join(absolute, MARKER))) {
    console.error(`不是一个 my-pi 检出:${absolute}`)
    console.error(`  (缺 ${MARKER} —— 这是认领标志,宁可现在报错也别等运行时)`)
    process.exit(1)
  }

  for (const file of CONFIGS) {
    const from = currentPrefix(file)
    const to = relativeFrom(file, absolute)
    if (from === to) continue
    const raw = readFileSync(file, "utf8")
    // 只替换 paths 值里的前缀:`"<from>/` → `"<to>/`。注释里的 ../my-pi 不带引号,不会被误伤。
    const next = raw.split(`"${from}/`).join(`"${to}/`)
    if (next === raw) throw new Error(`${path.relative(repoRoot, file)} 没有任何路径被替换,前缀推断错了?`)
    writeFileSync(file, next)
  }

  console.log("已切换:")
  describe()
  console.log("\n下一步 —— 内核没有 HMR,dev 必须重起:")
  console.log("  bun typecheck && bun --cwd packages/kernel test")
  console.log("  bun build:desktop && bun --cwd packages/desktop smoke")
  console.log("  bun dev:desktop")
}

const arg = process.argv[2]
if (!arg) {
  console.log("当前内核指向:")
  describe()
  console.log("\n切换:bun use-mypi <目录>    恢复默认:bun use-mypi --reset")
} else if (arg === "--reset") {
  point(DEFAULT)
} else {
  point(arg)
}
