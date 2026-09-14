/**
 * toolchain 工具(host/tools/toolchain/{contract,session}.ts)的验收。
 *
 * 探测/账本/下载本身在 domain/toolchain 那一层各有自己的测试(toolchain-resolve / -ledger / -install,
 * 230 条),这里只钉**工具这一层新增的判断**:
 *
 * - check 是纯读、resolve 才写回账本 —— 两者渲染同一段文本,分叉只在写不写,肉眼看不出来。
 * - install 的三条接线:进度既上卡片又出事件、装完先刷 PATH 再报"可用"、失败/取消也补一条终态进度
 *   (不补的话 UI 的进度行永远停在最后一个百分比)。
 * - **两个入口共用一把安装锁**:agent 正在装的包,设置页那边点"取消"要能停下它;反过来设置页在装的
 *   包,agent 再装一次要被拒。这两条是这一刀真正新增的风险面 —— 两路往同一棵目录树里解压不会报错,
 *   只会产出一棵交错的树。
 *
 * 一个字节都不走真网络:installer 全程注入假货。真实下载路径归 toolchain-install.test.ts。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { createInstallRegistry, installKey } from "../src/host/domain/toolchain/install.ts"
import type { InstalledToolchain, InstallToolchainOptions } from "../src/host/domain/toolchain/install.ts"
import { readLedger } from "../src/host/domain/toolchain/ledger.ts"
import type { ResolvedTool } from "../src/host/domain/toolchain/resolve.ts"
import { MANIFEST_RELATIVE } from "../src/host/domain/toolchain/schema.ts"
import type { ToolSpec } from "../src/host/domain/toolchain/schema.ts"
import {
  MANIFEST_PATH,
  TOOLCHAIN_CONTRACT,
  type ToolchainDetails,
  type ToolchainInput,
} from "../src/host/tools/toolchain/contract.ts"
import {
  createToolchainTool,
  installProgressLine,
  renderToolLine,
  type ToolchainToolOptions,
} from "../src/host/tools/toolchain/session.ts"

let projectDir: string
let configDir: string
let binDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "yoma-tc-tool-project-"))
  configDir = mkdtempSync(join(tmpdir(), "yoma-tc-tool-config-"))
  binDir = mkdtempSync(join(tmpdir(), "yoma-tc-tool-bin-"))
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
  // maxRetries:被 probeVersion 起过的假工具在 Windows 上偶尔比子进程退出晚一拍才放开文件句柄。
  rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

/** 假工具:打印一行版本号就退出(与 toolchain-resolve.test.ts 同一套)。 */
function writeFakeExe(dir: string, name: string, version: string): string {
  mkdirSync(dir, { recursive: true })
  if (process.platform === "win32") {
    const file = join(dir, `${name}.bat`)
    writeFileSync(file, `@echo off\r\necho ${version}\r\n`)
    return file
  }
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\necho "${version}"\n`)
  chmodSync(file, 0o755)
  return file
}

function writeManifest(tools: ToolSpec[]): void {
  mkdirSync(join(projectDir, ".yoma"), { recursive: true })
  writeFileSync(join(projectDir, ".yoma", "toolchain.json"), JSON.stringify({ schema: "yoma/toolchain@1", tools }))
}

/** PATH 从空串起步:这台机器上真装了什么都不许漏进判定(根 CLAUDE.md 点名的反模式)。 */
function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: "", PATHEXT: ".EXE;.CMD;.BAT;.COM", ...overrides }
}

interface Harness {
  run: (params: ToolchainInput, context?: Context) => Promise<AgentToolResult<ToolchainDetails>>
  updates: string[]
}

function makeTool(options: ToolchainToolOptions = {}): Harness {
  const updates: string[] = []
  const tool = createToolchainTool({ configDir, platform: process.platform, env: baseEnv(), ...options })
  const run = (params: ToolchainInput, context: Context = BACKGROUND_CONTEXT) =>
    tool.execute(
      "c1",
      params,
      (partial) => updates.push(partial.content.map((part) => (part.type === "text" ? part.text : "")).join("")),
      { env: new NodeExecutionEnv({ cwd: projectDir }) },
      invocation,
      context,
    ) as Promise<AgentToolResult<ToolchainDetails>>
  return { run, updates }
}

function textOf(result: AgentToolResult<ToolchainDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

// ─── check / resolve ─────────────────────────────────────────────────────────

describe("check / resolve", () => {
  it("没有清单时不报错,而是说明情况并提出草拟一份(details.declared=false)", async () => {
    const result = await makeTool().run({ action: "check" })
    expect(textOf(result)).toContain("No toolchain manifest found")
    expect(textOf(result)).toContain(MANIFEST_PATH)
    expect(result.details?.declared).toBe(false)
    expect(result.details?.ok).toBe(true)
  })

  it("契约里的清单路径字面量与 domain 的 MANIFEST_RELATIVE 同值", () => {
    // 契约不许 import domain(boundary.test.ts 第 5 条),所以那边是抄的字面量 —— 抄错了只有这条能发现。
    expect(MANIFEST_PATH).toBe(MANIFEST_RELATIVE)
  })

  it("装好的工具报 OK,带路径、版本和来源;details.tools 是三格摘要", async () => {
    writeFakeExe(binDir, "widget", "1.2.3")
    writeManifest([{ id: "widget", bin: ["widget"] }])
    const result = await makeTool({ env: baseEnv({ PATH: binDir }) }).run({ action: "check" })
    const text = textOf(result)
    expect(text).toContain("widget: OK")
    expect(text).toContain("1.2.3")
    expect(result.details?.tools).toEqual([{ id: "widget", status: "ok", optional: false }])
    expect(result.details?.ok).toBe(true)
  })

  it("缺的工具报 MISSING 并把清单里的安装提示带出来,summary 点名要处理谁", async () => {
    writeManifest([
      {
        id: "widget",
        bin: ["widget"],
        install: { win32: "winget install widget", darwin: "brew install widget", linux: "apt install widget" },
      },
    ])
    const result = await makeTool().run({ action: "check" })
    const text = textOf(result)
    expect(text).toContain("widget: MISSING")
    expect(text).toContain("install widget")
    expect(text).toContain("Required tools needing attention: widget.")
    expect(result.details?.ok).toBe(false)
  })

  it("check 是纯读:探到了也不写账本 —— 写了的话下一次 check 就不再真的看这台机器", async () => {
    writeFakeExe(binDir, "widget", "1.2.3")
    writeManifest([{ id: "widget", bin: ["widget"] }])
    await makeTool({ env: baseEnv({ PATH: binDir }) }).run({ action: "check" })
    expect(Object.keys((await readLedger(configDir)).entries)).toEqual([])
  })

  it("resolve 把新鲜探到的结果写回账本(by:auto),文本也说清它记住了", async () => {
    writeFakeExe(binDir, "widget", "1.2.3")
    writeManifest([{ id: "widget", bin: ["widget"] }])
    const result = await makeTool({ env: baseEnv({ PATH: binDir }) }).run({ action: "resolve" })
    expect(textOf(result)).toContain("freshly probed")
    const entries = (await readLedger(configDir)).entries
    expect(entries.widget?.by).toBe("auto")
    expect(entries.widget?.version).toBe("1.2.3")
  })
})

describe("能自助安装的提示行", () => {
  // 手造 ResolvedTool 而不是端到端:installableFor 要这台机器的宿主键在目录里有产物,
  // 端到端会变成"在 macOS 上测不到、在 Windows 上才测得到"的那种闸门。
  const missing = (id: string, installable: ResolvedTool["installable"], wanted?: string): ResolvedTool => ({
    id,
    status: "missing",
    optional: false,
    bin: {},
    ...(wanted ? { wanted } : {}),
    installable,
  })
  const ARM = { packageId: "arm-gnu-toolchain", title: "Arm GNU Toolchain", version: "15.2.rel1", bytes: 300e6 }

  it("一个包带好几个工具时,每一行都指向同一个 id 并说清这一次装覆盖了谁", () => {
    const gcc = renderToolLine(missing("arm-gcc", ARM))
    const gdb = renderToolLine(missing("arm-gdb", ARM))
    // 两行各喊各的 id 的话,模型会在同一批里发两次 install,而注册表按包去重 —— 第二次必被拒。
    expect(gcc).toContain('run toolchain install id="arm-gcc"')
    expect(gdb).toContain('run toolchain install id="arm-gcc"')
    expect(gdb).toContain("one install covers arm-gcc, arm-gdb")
  })

  it("包只带一个工具时不说多余的话", () => {
    const line = renderToolLine(
      missing("cmake", { packageId: "cmake", title: "CMake", version: "3.31.6", bytes: 50e6 }),
    )
    expect(line).toContain('run toolchain install id="cmake"')
    expect(line).not.toContain("one install covers")
  })

  it("目录里钉的版本满足不了清单要求时,明说别装 —— 否则模型在装→核→再装里空转", () => {
    const line = renderToolLine(missing("arm-gcc", ARM, ">=99"))
    expect(line).toContain("does NOT satisfy >=99")
    expect(line).not.toContain("run toolchain install")
  })
})

// ─── set ─────────────────────────────────────────────────────────────────────

describe("set", () => {
  it("用户报的是安装目录时,在目录(及其 bin/)里解析出可执行文件再记账", async () => {
    const exe = writeFakeExe(binDir, "widget", "1.2.3")
    writeManifest([{ id: "widget", bin: ["widget"] }])
    const result = await makeTool().run({ action: "set", id: "widget", path: binDir })
    expect(textOf(result)).toContain(exe)
    expect(textOf(result)).toContain("no need to ask again")
    expect(result.details).toMatchObject({ action: "set", ok: true, id: "widget" })
    expect((await readLedger(configDir)).entries.widget?.by).toBe("user")
  })

  it("缺 id 或缺 path 时抛错,而且话术直接说要补什么", async () => {
    const tool = makeTool()
    await expect(tool.run({ action: "set", path: binDir })).rejects.toThrow(/requires "id"/)
    await expect(tool.run({ action: "set", id: "widget" })).rejects.toThrow(/requires "path"/)
  })

  it("路径根本不存在时拒绝落账 —— 账本里留一条假路径比没有条目更糟", async () => {
    writeManifest([{ id: "widget", bin: ["widget"] }])
    await expect(makeTool().run({ action: "set", id: "widget", path: join(binDir, "nope") })).rejects.toThrow()
    expect(Object.keys((await readLedger(configDir)).entries)).toEqual([])
  })
})

// ─── install ─────────────────────────────────────────────────────────────────

const INSTALLED: InstalledToolchain = {
  packageId: "widget-tools",
  version: "1.2.3",
  dir: "/tmp/widget-1.2.3",
  binDir: "/tmp/widget-1.2.3/bin",
  reused: false,
  recorded: [{ id: "widget", binPath: "/tmp/widget-1.2.3/bin/widget", version: "1.2.3" }],
}

/** 假安装器:可选地先吐几条进度,再按 behaviour 结束。一个字节都不下载。 */
function fakeInstaller(behaviour: (opts: InstallToolchainOptions) => Promise<InstalledToolchain>) {
  const seen: InstallToolchainOptions[] = []
  const installer = async (opts: InstallToolchainOptions) => {
    seen.push(opts)
    return behaviour(opts)
  }
  return { installer: installer as typeof import("../src/host/domain/toolchain/install.ts").installToolchain, seen }
}

describe("install", () => {
  it("缺 id 时抛错", async () => {
    await expect(makeTool().run({ action: "install" })).rejects.toThrow(/requires "id"/)
  })

  it("进度既上卡片(onUpdate)又走宿主事件(onInstallProgress),下载阶段带百分比", async () => {
    const progress: string[] = []
    const { installer } = fakeInstaller(async (opts) => {
      opts.onProgress?.({
        toolId: "widget",
        packageId: "widget-tools",
        version: "1.2.3",
        phase: "download",
        bytes: 15_000_000,
        total: 30_000_000,
      })
      opts.onProgress?.({ toolId: "widget", packageId: "widget-tools", version: "1.2.3", phase: "extract" })
      return INSTALLED
    })
    const tool = makeTool({ installer, onInstallProgress: (p) => progress.push(p.phase) })
    await tool.run({ action: "install", id: "widget" })
    expect(tool.updates[0]).toBe("widget: download 50% (15.0/30.0 MB)")
    expect(tool.updates.at(-1)).toBe("widget: extract")
    expect(progress).toEqual(["download", "extract"])
  })

  it("装完先刷宿主 PATH 再返回,文案才敢说后续命令直接可用", async () => {
    const order: string[] = []
    const { installer } = fakeInstaller(async () => {
      order.push("install")
      return INSTALLED
    })
    const result = await makeTool({
      installer,
      // **必须是异步的**:生产里它是 refreshMachineEnv —— 读账本、为每个开着的会话重解析一遍清单、
      // 起一堆 --version 子进程。同步的假货会让这条用例在 `void onInstalled()` 下照样绿(审稿实测)。
      onInstalled: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        order.push("refresh")
      },
    }).run({ action: "install", id: "widget" })
    // 结果回到模型手上的那一刻,刷新必须已经做完 —— 顺序反了的代价是模型拿到"已经可用",
    // 下一条命令照样 command not found。
    expect(order).toEqual(["install", "refresh"])
    expect(textOf(result)).toContain("on PATH for your later commands in this session")
    expect(result.details?.installed?.packageId).toBe("widget-tools")
  })

  it("刷 PATH 自己炸了不算安装失败:包已经装好了,只是改口让模型用绝对路径", async () => {
    const { installer } = fakeInstaller(async () => INSTALLED)
    const result = await makeTool({
      installer,
      onInstalled: () => {
        throw new Error("ledger unreadable")
      },
    }).run({ action: "install", id: "widget" })
    // 报错的代价:一次几百 MB 的成功安装被说成失败,模型转头再装一次。
    expect(result.details?.ok).toBe(true)
    expect(textOf(result)).toContain("call the executables by the absolute paths above")
  })

  it("宿主没接刷 PATH 的钩子时改口,让模型用绝对路径 —— 不许说一句做不到的话", async () => {
    const { installer } = fakeInstaller(async () => INSTALLED)
    const result = await makeTool({ installer }).run({ action: "install", id: "widget" })
    expect(textOf(result)).toContain("call the executables by the absolute paths above")
    expect(textOf(result)).not.toContain("in this session and for every later session")
  })

  it("失败时补一条终态进度(phase:error)并把错误原样抛出去,不吞成看起来成功", async () => {
    const phases: string[] = []
    const { installer } = fakeInstaller(async (opts) => {
      opts.onProgress?.({
        toolId: "widget",
        packageId: "widget-tools",
        version: "1.2.3",
        phase: "download",
        bytes: 1,
        total: 10,
      })
      throw new Error("sha256 mismatch")
    })
    const tool = makeTool({ installer, onInstallProgress: (p) => phases.push(p.phase) })
    await expect(tool.run({ action: "install", id: "widget" })).rejects.toThrow(/sha256 mismatch/)
    // 没有这一条,UI 的进度行永远停在最后一个百分比上。
    expect(phases).toEqual(["download", "error"])
  })

  it("用户按停止 ⇒ 安装器收到已经中止的信号", async () => {
    const { installer, seen } = fakeInstaller(async () => INSTALLED)
    await makeTool({ installer }).run(
      { action: "install", id: "widget" },
      withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT),
    )
    expect(seen[0]?.signal?.aborted).toBe(true)
  })
})

// ─── 与设置页共用的那把锁 ────────────────────────────────────────────────────

describe("安装注册表(与设置页共用)", () => {
  it("同一个包正在装时,再装一次被拒 —— 两路往同一棵目录树里解压不会报错,只会解出一棵交错的树", async () => {
    const registry = createInstallRegistry()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { installer } = fakeInstaller(async () => {
      await gate
      return INSTALLED
    })
    const tool = makeTool({ installer, installRegistry: registry })
    const first = tool.run({ action: "install", id: "widget" })
    // 让第一路真的进到注册表里(start 之前有两个 await)。
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(tool.run({ action: "install", id: "widget" })).rejects.toThrow(/already installing/)
    release?.()
    await expect(first).resolves.toBeTruthy()
  })

  it("设置页点取消 ⇒ agent 正在跑的那次安装收到中止信号", async () => {
    const registry = createInstallRegistry()
    const { installer } = fakeInstaller(
      (opts) =>
        new Promise<InstalledToolchain>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("cancelled")))
        }),
    )
    const tool = makeTool({ installer, installRegistry: registry })
    const running = tool.run({ action: "install", id: "widget" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 设置页的取消按钮走的就是这一句(host/index.ts 的 toolchain.installCancel)。
    expect(registry.cancel(installKey("widget"))).toBe(true)
    await expect(running).rejects.toThrow(/cancelled/)
    expect(registry.active()).toEqual([])
  })

  it("锁按**包**不按工具 id:arm-gcc 在装时 arm-gdb 也装不了(同一个包)", async () => {
    // installKey 的全部意义就在这一条上。用假 id "widget"(不在目录里)时 installKey 恒等,
    // 把 installKey(id) 换成 id 全部用例照样绿 —— 审稿人变异证明过。这里用目录里真实的一对。
    const registry = createInstallRegistry()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { installer } = fakeInstaller(async () => {
      await gate
      return INSTALLED
    })
    const tool = makeTool({ installer, installRegistry: registry })
    const first = tool.run({ action: "install", id: "arm-gcc" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await expect(tool.run({ action: "install", id: "arm-gdb" })).rejects.toThrow(/already installing/)
    release?.()
    await first
  })

  it("刷 PATH 期间锁还攥着:那几秒里第二次装同一个包必须还是被拒", async () => {
    // 设置页 RPC 把这条写成了不变量(host/toolchain.ts):refreshMachineEnv 要为每个开着的会话
    // 重解析一遍清单,不短。锁在那之前就放掉的话,按钮会在刷新还没跑完时重新亮起来。
    const registry = createInstallRegistry()
    const { installer } = fakeInstaller(async () => INSTALLED)
    let heldDuringRefresh: string[] = []
    await makeTool({
      installer,
      installRegistry: registry,
      onInstalled: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        heldDuringRefresh = registry.active()
      },
    }).run({ action: "install", id: "widget" })
    expect(heldDuringRefresh).toEqual(["widget"])
    expect(registry.active()).toEqual([])
  })

  it("agent 装的包在设置页那边看得见(installsActive 读的就是同一个注册表)", async () => {
    const registry = createInstallRegistry()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { installer } = fakeInstaller(async () => {
      await gate
      return INSTALLED
    })
    const running = makeTool({ installer, installRegistry: registry }).run({ action: "install", id: "widget" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(registry.active()).toEqual(["widget"])
    release?.()
    await running
    expect(registry.active()).toEqual([])
  })
})

// ─── 契约 ────────────────────────────────────────────────────────────────────

describe("契约", () => {
  it("只有 install 要问用户:它下几百 MB、解压进主目录、还改了后续命令的 PATH", () => {
    const confirm = (action: ToolchainInput["action"]) =>
      TOOLCHAIN_CONTRACT.confirm({ action, id: "widget", path: "/x" })
    expect(confirm("install")).toBe(true)
    expect(confirm("check")).toBe(false)
    expect(confirm("resolve")).toBe(false)
    // set 只是把用户刚说的一句话记进账本,拦它只会平白多一次点击。
    expect(confirm("set")).toBe(false)
  })

  it("summary 在参数还没拼完时也给得出话(卡片副标题是流式渲染的)", () => {
    expect(TOOLCHAIN_CONTRACT.summary({ action: "install", id: "arm-gcc" })).toBe("install arm-gcc")
    expect(TOOLCHAIN_CONTRACT.summary({ action: "install" })).toBe("install")
    expect(TOOLCHAIN_CONTRACT.summary({ action: "set", id: "arm-gcc", path: "/opt/gcc" })).toBe(
      "set arm-gcc → /opt/gcc",
    )
    expect(TOOLCHAIN_CONTRACT.summary({ action: "set", id: "arm-gcc" })).toBe("set arm-gcc")
    expect(TOOLCHAIN_CONTRACT.summary({})).toBe("")
  })

  it("进度行:download 有总数才算百分比,没有就只报阶段", () => {
    const base = { toolId: "arm-gcc", packageId: "arm-gnu", version: "14.2" } as const
    expect(installProgressLine({ ...base, phase: "download", bytes: 3_000_000, total: 12_000_000 })).toBe(
      "arm-gcc: download 25% (3.0/12.0 MB)",
    )
    // 镜像/代理不给 content-length 时 total 缺席 —— 这时报个 NaN% 比不报还糟。
    expect(installProgressLine({ ...base, phase: "download", bytes: 3_000_000 })).toBe("arm-gcc: download")
    expect(installProgressLine({ ...base, phase: "verify", message: "sha256" })).toBe("arm-gcc: verify — sha256")
  })
})
