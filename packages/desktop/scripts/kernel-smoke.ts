/**
 * 内核冒烟:对 **构建产物** 跑,不对源码跑。
 *
 * 为什么必须存在:yoma 现在约每天一次提交,而它的 packages/agent/src/index.ts 在近期
 * 十几个提交里改过多次。electron-vite 把它整个 inline 进 out/main/kernel.js(kernel 在 devDependencies 里,不被外部化) —— 也就是说
 * 内核的一次重构可以在我们这边零编译错误地把桌面端搞死,直到用户点下去才发现。
 * 这个脚本是唯一能在 CI 里挡住那种情况的东西。
 *
 * 用法:
 *   tsx packages/desktop/scripts/kernel-smoke.ts
 * 前置:先 `npm run build -w packages/desktop`。
 */

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { diffToolNames } from "@yoma-desktop/kernel"
import { resolveElectron } from "./electron-bin.ts"
import { selfCheckLa } from "../../../engines/logic-analyzer/build.ts"

const here = dirname(fileURLToPath(import.meta.url))
const workspaceDesktop = join(here, "..")
const desktop = process.env.YOMA_DESKTOP_DIR ?? workspaceDesktop
const repoRoot = join(workspaceDesktop, "..", "..")

const bundle = join(desktop, "out", "main", "kernel.js")

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function exe(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name
}

// 此脚本由普通 Node 启动,不能 stat app.asar 内的虚拟路径;交给 Electron 自己加载并验证。
if (!(desktop.endsWith(".asar") ? existsSync(desktop) : existsSync(bundle))) {
  fail(`没有构建产物 ${bundle} —— 先跑 npm run build -w packages/desktop`)
}

let electron: string
try {
  electron = resolveElectron(workspaceDesktop)
} catch (error) {
  fail((error as Error).message)
}

// ---------------------------------------------------------------------------
// 1. 内核在真实 runtime 下加载得起来,四件套都构造得出来
// ---------------------------------------------------------------------------

const enginesDir = process.env.YOMA_ENGINES_DIR ?? join(repoRoot, "engines")
let report: { node: string; electron: string | null; harness: string; tools: string[] }
try {
  const stdout = execFileSync(electron, [bundle], {
    env: { ...process.env, YOMA_KERNEL_SELFCHECK: "1", YOMA_ENGINES_DIR: enginesDir, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  })
  report = JSON.parse(stdout)
} catch (error) {
  fail(`内核自检失败:\n${(error as { stdout?: string; message?: string }).stdout ?? (error as Error).message}`)
}

// 期望清单不再手写:TOOL_NAMES 是工具清单的唯一真源(kernel/src/types.ts),这里拿**构建产物**
// 自检报上来的装配面与它逐字同序比(与 kernel-entry 的自检、bench 的 check 走同一个 diffToolNames)。
// 清单已同源之后,"多出来的工具"也是漂移(源码装配面与 out/ 不是同一版),所以不再只 warn。
const diff = diffToolNames(report.tools)
if (diff)
  fail(
    `工具清单与 TOOL_NAMES 不一致(旧 out/?先 npm run build -w packages/desktop;还是 TOOL_NAMES 没跟上装配面?)\n${diff}`,
  )

console.log(`✓ 内核加载正常 (node ${report.node} / electron ${report.electron ?? "n/a"}),${report.tools.length} 个工具`)

// ---------------------------------------------------------------------------
// 2. engines 二进制真的在
// ---------------------------------------------------------------------------

const bin = join(enginesDir, "bin")
const stm32Data = join(enginesDir, "data", "stm32")
const REQUIRED_BINS = ["stm32kernel", "controller_map", "board_ir", "connections", "rg"].map(exe)

if (!existsSync(bin)) {
  fail(`${bin} 不存在 —— 核对 YOMA_ENGINES_DIR 与安装包资源;源码构建者可运行 npm run engines:build。`)
}
const present = readdirSync(bin)
const missingBins = REQUIRED_BINS.filter((name) => !present.includes(name))
if (missingBins.length) fail(`engines/bin 缺少:${missingBins.join(", ")}`)
console.log(`✓ engines 就位:${present.join(", ")}`)

// 必须真正启动:Windows 的 venv launcher 也是 PE,光验 MZ 或文件名看不出它依赖构建机。
function runBin(name: string, args: string[]): string {
  return execFileSync(join(bin, exe(name)), args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  })
}
try {
  for (const name of ["controller_map", "board_ir", "connections"]) runBin(name, ["--help"])
  runBin("rg", ["--version"])
  if (!runBin("stm32kernel", ["schema"]).includes("ConfigDoc")) throw new Error("schema 缺 ConfigDoc")
  console.log("✓ 五个必需引擎可启动,STM32 schema 可用(无需器件数据)")
} catch (error) {
  fail(`引擎启动失败:${(error as Error).message}`)
}

// yoma-la 是可选引擎;Windows 发布 CI 已装 MSYS2,其它环境可能没有。
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
// 只有显式允许缺数据的分发构建才放行;缺失时 board_ir 也不可用,原始网表仍可解析。
const irpacks = existsSync(stm32Data)
  ? readdirSync(stm32Data).filter((name) => name.endsWith(".irpack") && statSync(join(stm32Data, name)).isFile())
  : []
const manifestFile = join(enginesDir, "manifest.json")
if (existsSync(manifestFile)) {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { irpacks?: number }
  if (manifest.irpacks !== undefined && manifest.irpacks !== irpacks.length) {
    fail(`交付的 irpack 数量与 manifest 不符:声明 ${manifest.irpacks},实际 ${irpacks.length}`)
  }
}
if (irpacks.length === 0) {
  if (process.argv.includes("--require-stm32-data")) fail("要求 STM32 数据,但交付目录中没有 irpack")
  console.log("↷ 跳过 STM32 配置与 board_ir 验收:交付目录中没有 irpack;仅 schema 与原始网表可用")
} else {
  try {
    const result = JSON.parse(runBin("stm32kernel", ["list-mcus", "--data-dir", stm32Data])) as { mcus?: unknown[] }
    if (!Array.isArray(result.mcus) || result.mcus.length === 0) throw new Error("list-mcus 未返回器件")
    console.log(`✓ stm32 irpacks ${irpacks.length} 个包可加载,${result.mcus.length} 条 MCU 记录`)
  } catch (error) {
    fail(`STM32 数据在但无法读取:${(error as Error).message}`)
  }
}

console.log(
  existsSync(join(stm32Data, "fw"))
    ? "ℹ HAL/CMSIS 目录存在;本冒烟不验证 generate/编译"
    : "↷ HAL/CMSIS 未交付(与 irpack 不同);完整工程生成/编译仍待单独验收",
)

console.log("\n冒烟通过。")
