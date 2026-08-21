#!/usr/bin/env bun
/**
 * 内核冒烟:对 **构建产物** 跑,不对源码跑。
 *
 * 为什么必须存在:yoma 现在约每天一次提交,而它的 packages/agent/src/index.ts 在近期
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
import { resolveElectron } from "./electron-bin.ts"
import { selfCheckLa } from "../../../engines/logic-analyzer/build.ts"

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, "..")
const repoRoot = join(desktop, "..", "..")

const bundle = join(desktop, "out", "main", "kernel.js")

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function exe(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name
}

if (!existsSync(bundle)) fail(`没有构建产物 ${bundle} —— 先跑 bun --cwd packages/desktop run build`)

let electron: string
try {
  electron = resolveElectron(desktop)
} catch (error) {
  fail((error as Error).message)
}

// ---------------------------------------------------------------------------
// 1. 内核在真实 runtime 下加载得起来,而且 10 个工具都构造得出来
// ---------------------------------------------------------------------------

const enginesDir = join(repoRoot, "engines")
let report: { node: string; electron: string | null; harness: string; tools: string[] }
try {
  const stdout = execFileSync(electron, [bundle], {
    env: { ...process.env, YOMA_KERNEL_SELFCHECK: "1", YOMA_ENGINES_DIR: enginesDir, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  })
  report = JSON.parse(stdout)
} catch (error) {
  fail(`内核自检失败:\n${(error as { stdout?: string; message?: string }).stdout ?? (error as Error).message}`)
}

// grep 已随 yoma 2026-08 的装配面精简退役(视图侧仍认得它,只为重放旧会话)。
// 对着**构建产物**核对:这个清单落后于内核装配面时,旧 out/ 会在这里如实报缺。
const EXPECTED = [
  "read",
  "bash",
  "edit",
  "write",
  "toolchain",
  "examples",
  "netlist",
  "datasheet",
  "stm32config",
  "flash",
  "log",
  "gdb",
  "la",
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
const stm32Data = join(enginesDir, "data", "stm32")
const REQUIRED_BINS = ["stm32kernel", "controller_map", "board_ir", "connections"].map(exe)

if (!existsSync(bin)) {
  fail(`${bin} 不存在 —— 跑 \`bun engines/build.ts\`(在仓库根)。\n` + `注意:yoma 的 enginesDir() 是向上查找 + existsSync,会"找到"一个没有 bin/ 的空壳然后报"去跑 build.ts",别被那条信息带偏。`)
}
const present = readdirSync(bin)
const missingBins = REQUIRED_BINS.filter((name) => !present.includes(name))
if (missingBins.length) fail(`engines/bin 缺少:${missingBins.join(", ")}`)
console.log(`✓ engines 就位:${present.join(", ")}`)

// yoma-la(逻辑分析仪)是可选引擎:Windows 上要 MSYS2 工具链才编得出,GitHub runner 没有。
// 像 irpack 一样缺了只跳过 —— 但有的话必须真能跑:自检与 engines/build.ts 装完那次是同一个函数。
if (present.includes(exe("yoma-la"))) {
  try {
    console.log(`✓ yoma-la ${await selfCheckLa(enginesDir)}(内嵌 Python + 解码器就位)`)
  } catch (error) {
    fail(`yoma-la 在但跑不起来(DLL / Python 标准库缺?):${(error as Error).message.split("\n")[0]}`)
  }
} else {
  console.log("↷ 跳过逻辑分析仪闸门:engines/bin 里没有 yoma-la(构建机无 MSYS2 时属预期)")
}

// irpack 是 CubeMX 解析产物,不进 git。GitHub runner / 没装 CubeMX 的机器上没有 pack
// 是预期,STM32 配置不可用;网表(controller_map/board_ir)和内核工具闸门不受影响。
const irpacks = existsSync(stm32Data) ? readdirSync(stm32Data).filter((name) => name.endsWith(".irpack")) : []
if (irpacks.length === 0) {
  console.log("↷ 跳过 STM32 配置闸门:没有 irpack(本机无 CubeMX 时属预期)")
} else {
  console.log(`✓ stm32 irpacks ${irpacks.length} 个族`)
}

console.log("\n冒烟通过。")
