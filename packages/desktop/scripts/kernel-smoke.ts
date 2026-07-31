#!/usr/bin/env bun
/**
 * 内核冒烟:对 **构建产物** 跑,不对源码跑。
 *
 * 为什么必须存在:my-pi 现在约每天一次提交,而它的 packages/agent/src/index.ts 在近期
 * 十几个提交里改过多次。我们通过 alias 把它整个 inline 进 out/main/kernel.js —— 也就是说
 * 内核的一次重构可以在我们这边零编译错误地把桌面端搞死,直到用户点下去才发现。
 * 这个脚本是唯一能在 CI 里挡住那种情况的东西。
 *
 * 用法:
 *   bun packages/desktop/scripts/kernel-smoke.ts
 * 前置:先 `bun --cwd packages/desktop run build`。
 */

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, "..")
const repoRoot = join(desktop, "..", "..")

const bundle = join(desktop, "out", "main", "kernel.js")
const electron = join(desktop, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (!existsSync(bundle)) fail(`没有构建产物 ${bundle} —— 先跑 bun --cwd packages/desktop run build`)

// ---------------------------------------------------------------------------
// 1. 内核在真实 runtime 下加载得起来,而且 11 个工具都构造得出来
// ---------------------------------------------------------------------------

const enginesDir = join(repoRoot, "engines")
let report: { node: string; electron: string | null; harness: string; tools: string[] }
try {
  const stdout = execFileSync(existsSync(electron) ? electron : process.execPath, [bundle], {
    env: { ...process.env, YOMA_KERNEL_SELFCHECK: "1", YOMA_ENGINES_DIR: enginesDir, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  })
  report = JSON.parse(stdout)
} catch (error) {
  fail(`内核自检失败:\n${(error as { stdout?: string; message?: string }).stdout ?? (error as Error).message}`)
}

const EXPECTED = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "netlist",
  "datasheet",
  "stm32config",
  "flash",
  "log",
  "gdb",
]

const missing = EXPECTED.filter((tool) => !report.tools.includes(tool))
if (missing.length) fail(`工具缺失:${missing.join(", ")}(内核改了工具集?)`)

const extra = report.tools.filter((tool) => !EXPECTED.includes(tool))
if (extra.length) {
  // 不算失败,但要大声说 —— 新工具没有渲染器就会掉进 GenericTool,只画一行标题没有输出体。
  console.warn(`⚠ 内核新增了工具:${extra.join(", ")} —— 需要在 session-ui 里补渲染器`)
}

console.log(`✓ 内核加载正常 (node ${report.node} / electron ${report.electron ?? "n/a"}),${report.tools.length} 个工具`)

// ---------------------------------------------------------------------------
// 2. engines 二进制真的在
// ---------------------------------------------------------------------------

const bin = join(enginesDir, "bin")
const data = join(enginesDir, "data")
const REQUIRED_BINS = ["stm32kernel", "probe-rs", "controller_map", "board_ir", "connections"]

if (!existsSync(bin)) {
  fail(`${bin} 不存在 —— 跑 \`bun engines/build.ts\`(在 my-pi 仓库)。\n` + `注意:my-pi 的 enginesDir() 是向上查找 + existsSync,会"找到"一个没有 bin/ 的空壳然后报"去跑 build.ts",别被那条信息带偏。`)
}
const present = readdirSync(bin)
const missingBins = REQUIRED_BINS.filter((name) => !present.includes(name))
if (missingBins.length) fail(`engines/bin 缺少:${missingBins.join(", ")}`)
if (!existsSync(data)) fail(`${data} 不存在 —— stm32 的 irpack/固件数据没装`)

console.log(`✓ engines 就位:${present.join(", ")}`)
console.log("\n冒烟通过。")
