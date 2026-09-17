/**
 * 工具链清单接入会话装配(session-manager.ts ensureOpen() 的那三行改动)的验证。
 *
 * 只测这一层的接线,不重测 resolve.ts / shellEnvFor 自身的判定逻辑 —— 那部分已经在
 * kernel/test/toolchain-resolve.test.ts 覆盖过。这里要证明的是三件事:
 *
 * 1. 解析出的 PATH 前置 + exports 真的到了 NodeExecutionEnv 构造出来的 shellEnv,
 *    并且真的送进了后续 spawn 的子进程 —— 用 bash 工具跑一条真命令验证,不 mock
 *    NodeExecutionEnv:PATH/环境变量这类跨进程边界的东西正是"类型系统永远抓不到"
 *    的那类问题(根 CLAUDE.md「会咬人的地方」),mock 掉构造参数只能证明"我们传了
 *    某个值",证明不了"这个值真的影响了 spawn 出来的进程"。
 * 2. 系统提示词只在"有需要留意的工具"时才追加一段 <toolchain> 说明;没有清单、
 *    或清单里的工具全部 ok 时字节不变(不追加任何 contextFiles 条目)。
 * 3. 清单存在但内容损坏时发 kernel.error,不拖累会话本身开不起来。
 * 4.(2026-09)机器级目录:Yoma 自己装的(<configDir>/toolchains/…/bin)与用户手指的
 *    (账本 by:"user")前置进同一条 PATH,by:"auto" 的不前置;装完 refreshMachineEnv()
 *    让**已经开着的**会话下一条命令就看得见,不用重开。
 */
import { afterEach, beforeAll, describe, expect, test } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai"

import type { KernelEvent } from "../protocol.ts"
import type { ToolPart } from "../types.ts"
import { SessionManager } from "./session-manager.ts"
import { createKernelHost } from "./index.ts"
import { fakeExeName, writeFakeExe as writeNativeFakeExe } from "../../test/fixtures/fake-exe.ts"
import { patient } from "../../test/patience.ts"

// 真 ~/.yoma/probe.lock 归用户,测试绝不碰它。这个文件里有用例会真跑 flash,flash 要先拿探针租约,而租约
// 除了进程内那份还落一把**跨进程**的锁文件。不隔离的话,vitest 分给不同 worker 进程的用例文件共用机器上
// 同一把锁:两边的 flash 一重叠,后到的拿不到租约、工具回 "探针被占"(error 不是 completed),等"完成数
// 恰好为 N"的那一处就永远等不到 —— ci 时红时绿里反复出现的两条(这个文件一条、host.test.ts 一条)就是这么来的
// (2026-09-17 用一个活着的外部进程占锁原样复现过)。它同时还会误伤开发机上正开着的 Yoma。
beforeAll(() => {
  process.env.YOMA_PROBE_LOCK = path.join(tmpdir(), `yoma-probe-test-${process.pid}.lock`)
})

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function writeJSON(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value))
}

let fauxCount = 0

/** 一次性 faux provider,和 host.test.ts 的 harnessWith 同一个套路——这里不需要思考档位。 */
function harnessWith(steps: unknown[]) {
  const models = createModels()
  const faux = fauxProvider({ provider: `faux-tc-${++fauxCount}`, models: [{ id: "plain" }] })
  models.setProvider(faux.provider)
  faux.setResponses(steps as never)
  return { models, model: faux.getModel() as Model<string> }
}

function makeManager(steps: unknown[], options: { configDir?: string; enginesDir?: string } = {}) {
  const events: KernelEvent[] = []
  const manager = new SessionManager({
    sessionsRoot: tempDir("yoma-tc-sessions-"),
    // 隔离开发机真实的 ~/.yoma —— 不传的话 resolveToolchain 会去读它的
    // toolchains.json 账本,测试结果就取决于跑测试的机器上账本记了什么。
    configDir: options.configDir ?? tempDir("yoma-tc-config-"),
    enginesDir: options.enginesDir,
    inspectStm32Availability: async () => ({ available: true }),
    emit: (batch) => events.push(...batch),
    resolveModels: async () => harnessWith(steps),
  })
  return { manager, events }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > patient(timeoutMs)) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function toolPartsOf(events: KernelEvent[]): ToolPart[] {
  return events.flatMap((e) =>
    e.type === "message.part.updated" && e.part.type === "tool" ? [e.part as ToolPart] : [],
  )
}

function kernelErrorsOf(events: KernelEvent[]): Array<{ type: "kernel.error"; message: string; sessionID?: string }> {
  return events.flatMap((e) => (e.type === "kernel.error" ? [e] : []))
}

describe("有清单且工具解析成功", () => {
  test("PATH 前置到解析出的目录、exports 变量真的送到 bash 工具 spawn 出来的进程;系统提示词不多话", async () => {
    const workspace = tempDir("yoma-tc-ws-")
    mkdirSync(path.join(workspace, ".yoma"), { recursive: true })

    // 提交进库的那份:只说"要什么",零绝对路径。
    writeJSON(path.join(workspace, ".yoma", "toolchain.json"), {
      schema: "yoma/toolchain@1",
      tools: [{ id: "gizmo", bin: ["gizmofake"], exports: { YOMA_TC_TEST_BIN: "{bin}" } }],
    })

    // 本机覆盖使用可执行入口,真实跨过版本探测与进程环境边界。
    const binDir = tempDir("yoma-tc-bin-")
    const binPath = writeFakeExe(binDir, "gizmofake")
    writeJSON(path.join(workspace, ".yoma", "toolchain.local.json"), {
      gizmo: { id: "gizmo", bin: { gizmofake: binPath }, confirmedAt: Date.now(), by: "user" },
    })

    let systemPrompt = ""
    const { manager, events } = makeManager([
      (context: { systemPrompt?: string }) => {
        systemPrompt = context?.systemPrompt ?? ""
        return fauxAssistantMessage([fauxToolCall("bash", { command: 'echo "$YOMA_TC_TEST_BIN|$PATH"' })])
      },
      fauxAssistantMessage([fauxText("好")]),
    ])

    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "看看环境变量" })

    await waitFor(() =>
      toolPartsOf(events).some((part) => part.state.status === "completed" || part.state.status === "error"),
    )

    let output: string | undefined
    for (const part of toolPartsOf(events)) {
      const state = part.state
      if (state.status === "completed") output = state.output
    }
    expect(output).toBeDefined()

    // exports 的 {bin} 替换成解析到的绝对路径;自定义变量名不在 Git Bash/MSYS 的
    // 路径自动转换名单里(那份名单只认 PATH 等少数几个),所以 bash 应该原样吐出这个
    // Windows 风格的绝对路径,可以精确匹配子串。
    expect(output).toContain(binPath)
    // PATH 前置:bash 收到的 $PATH 会被 Git Bash 转成 POSIX 形式(盘符、分隔符都会
    // 变形),所以只断言目录名这个子串还在,不断言整条路径的确切格式。
    expect(output).toContain(path.basename(binDir))

    // 工具全部 ok、没有需要留意的——promptSectionFor 返回 undefined,系统提示词
    // 不应该被追加任何 <toolchain> 说明。
    expect(systemPrompt).not.toContain("Project toolchain requirements")
    expect(kernelErrorsOf(events)).toEqual([])

    await manager.disposeAll()
  }, 20_000)
})

describe("有清单但工具缺失", () => {
  test("needsAttention 非空时系统提示词追加一段 <toolchain> 说明,内容点名缺失的工具", async () => {
    const workspace = tempDir("yoma-tc-ws-")
    mkdirSync(path.join(workspace, ".yoma"), { recursive: true })
    writeJSON(path.join(workspace, ".yoma", "toolchain.json"), {
      schema: "yoma/toolchain@1",
      // 名字刻意写得又长又怪——不能是这台机器上真实装过的任何工具,否则 PATH/
      // 已知安装位置/注册表某一档可能真的命中,测试就成了看这台机器装了什么。
      tools: [{ id: "yoma-test-missing-tool", bin: ["yoma-test-missing-tool-binary-9f3c1a"] }],
    })

    let systemPrompt = ""
    const { manager, events } = makeManager([
      (context: { systemPrompt?: string }) => {
        systemPrompt = context?.systemPrompt ?? ""
        return fauxAssistantMessage([fauxText("好")])
      },
    ])

    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "你好" })
    await waitFor(() => systemPrompt !== "")

    expect(systemPrompt).toContain("Project toolchain requirements")
    expect(systemPrompt).toContain('path="<toolchain>"')
    expect(systemPrompt).toContain("yoma-test-missing-tool")
    expect(systemPrompt).toContain("MISSING")
    // "missing" 是正常的解析结果,不是异常——不该顺带触发 resolveToolchainSafe 的
    // catch 分支。
    expect(kernelErrorsOf(events)).toEqual([])

    await manager.disposeAll()
  })
})

describe("没有清单", () => {
  test("绝大多数项目的路径:系统提示词不受影响,也不发 kernel.error", async () => {
    const workspace = tempDir("yoma-tc-ws-")
    // 故意不建 .yoma/toolchain.json —— 这是没有声明工具链需求的普通项目。

    let systemPrompt = ""
    const { manager, events } = makeManager([
      (context: { systemPrompt?: string }) => {
        systemPrompt = context?.systemPrompt ?? ""
        return fauxAssistantMessage([fauxText("好")])
      },
    ])

    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "你好" })
    await waitFor(() => systemPrompt !== "")

    expect(systemPrompt).not.toContain("<toolchain>")
    expect(systemPrompt).not.toContain("Project toolchain requirements")
    expect(kernelErrorsOf(events)).toEqual([])

    await manager.disposeAll()
  })
})

describe("清单存在但内容损坏", () => {
  test("发 kernel.error(带 sessionID),但会话照常开、照常聊", async () => {
    const workspace = tempDir("yoma-tc-ws-")
    mkdirSync(path.join(workspace, ".yoma"), { recursive: true })
    // 坏 JSON——parseManifest 会在这里失败,resolveToolchain 因此抛出(而不是像
    // "文件不存在"那样静默),resolveToolchainSafe 必须把这个异常吞掉。
    writeFileSync(path.join(workspace, ".yoma", "toolchain.json"), "{ not json")

    const { manager, events } = makeManager([fauxAssistantMessage([fauxText("能聊")])])

    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "你好" })
    await waitFor(() => events.some((e) => e.type === "message.updated" && e.message.role === "assistant"))

    const errors = kernelErrorsOf(events)
    expect(errors.some((e) => e.message.includes("工具链清单解析失败"))).toBe(true)
    expect(errors.some((e) => e.sessionID === session.id)).toBe(true)

    await manager.disposeAll()
  }, 20_000)
})

// ─── 机器级目录(managed 安装 + 账本 by:"user")─────────────────────────────────
//
// 这一档与项目清单无关:**没有**清单的项目(绝大多数)也必须白得 Yoma 装进
// <configDir>/toolchains/ 的东西,否则"设置页点了安装、agent 还是说 command not found"。
// 断言全部走 bash 工具真 spawn 出来的子进程看到的 $PATH —— 与本文件第一条测试同一条
// 理由:PATH 是跨进程边界的东西,mock 掉构造参数证明不了它真的到了子进程。

/** 使用真实启动器,入口探测和子进程 PATH 均走生产代码。 */
function writeFakeExe(dir: string, name: string): string {
  return writeNativeFakeExe(dir, name, 'console.log("1.0.0")')
}

/** 按 install.ts 的 ManagedInstall 布局摆一个"Yoma 装过"的包,返回它的 binDir。 */
function writeManagedInstall(configDir: string, packageId: string, version: string, provides: string[]): string {
  const dir = path.join(configDir, "toolchains", packageId, version)
  const binDir = path.join(dir, "bin")
  writeFakeExe(binDir, `${packageId}-tool`)
  writeJSON(path.join(dir, ".yoma-toolchain.json"), {
    packageId,
    version,
    dir,
    binDir: "bin",
    provides,
    archiveSha256: "0".repeat(64),
    installedAt: Date.now(),
  })
  return binDir
}

function writeLedger(configDir: string, entries: Record<string, unknown>): void {
  writeJSON(path.join(configDir, "toolchains.json"), { schema: "yoma/toolchains@1", entries })
}

/** 每个工具调用的最终输出,按发生顺序(同一个 part 的多条快照只留完成那条)。 */
/** 会话状态的时间序列 —— 发下一轮之前必须等它落回 idle。 */
function statusesOf(events: KernelEvent[]): string[] {
  return events.flatMap((event) => (event.type === "session.status" ? [event.status.type] : []))
}

function completedOutputs(events: KernelEvent[]): string[] {
  const byId = new Map<string, string>()
  for (const part of toolPartsOf(events)) {
    if (part.state.status === "completed") byId.set(part.id, part.state.output)
  }
  return [...byId.values()]
}

const echoPath = () => fauxAssistantMessage([fauxToolCall("bash", { command: 'echo "$PATH"' })])

describe("机器级目录进会话 PATH", () => {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH"
  let savedPath: string | undefined
  function guardProcessPath(): void {
    savedPath = process.env[pathKey]
  }
  afterEach(() => {
    expect(process.env[pathKey]).toBe(savedPath)
  })

  test("没有项目清单时也前置:managed 的 bin 与账本 by:user 的目录在,by:auto 的不在", async () => {
    guardProcessPath()
    const configDir = tempDir("yoma-tc-config-")
    const workspace = tempDir("yoma-tc-ws-") // 故意没有 .yoma/toolchain.json

    writeManagedInstall(configDir, "yoma-test-managed-pkg", "1.0.0", ["gizmo"])
    const userDir = tempDir("yoma-tc-userpick-")
    const autoDir = tempDir("yoma-tc-autoprobe-")
    const userExe = writeFakeExe(userDir, "usertool")
    const autoExe = writeFakeExe(autoDir, "autotool")
    writeLedger(configDir, {
      usertool: { id: "usertool", bin: { usertool: userExe }, confirmedAt: Date.now(), by: "user" },
      autotool: { id: "autotool", bin: { autotool: autoExe }, confirmedAt: Date.now(), by: "auto" },
    })

    const { manager, events } = makeManager([echoPath(), fauxAssistantMessage([fauxText("好")])], { configDir })
    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "看看 PATH" })
    await waitFor(() => completedOutputs(events).length >= 1)

    const output = completedOutputs(events)[0]!
    // Git Bash 会把 PATH 整条转成 POSIX 形式(盘符、分隔符都变),所以只断言目录名
    // 这个子串在不在 —— 与本文件第一条测试同一条理由。
    expect(output).toContain("yoma-test-managed-pkg")
    expect(output).toContain(path.basename(userDir))
    // by:"auto" 是"在 PATH / 已知位置探到的",再前置只会遮蔽用户自己的同名工具。
    expect(output).not.toContain(path.basename(autoDir))

    await manager.disposeAll()
  }, 30_000)

  test("装完调 refreshMachineEnv():已经开着的会话下一条命令就看得见,不用重开", async () => {
    guardProcessPath()
    const configDir = tempDir("yoma-tc-config-")
    const workspace = tempDir("yoma-tc-ws-")
    writeManagedInstall(configDir, "yoma-test-first-pkg", "1.0.0", ["gizmo"])

    const { manager, events } = makeManager(
      [echoPath(), fauxAssistantMessage([fauxText("好")]), echoPath(), fauxAssistantMessage([fauxText("好")])],
      { configDir },
    )
    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "第一次" })
    await waitFor(() => completedOutputs(events).length >= 1)
    expect(completedOutputs(events)[0]).not.toContain("yoma-test-second-pkg")
    // 工具跑完 ≠ 这一轮跑完(后面还有一条 assistant 消息)。不等到 idle 就发下一轮,
    // prompt() 会先去中断这一轮,两边抢同一条 lane —— 机器一忙就超时。
    await waitFor(() => statusesOf(events).at(-1) === "idle")

    // 安装发生在会话开着的时候。
    writeManagedInstall(configDir, "yoma-test-second-pkg", "2.0.0", ["widget"])
    await manager.refreshMachineEnv()

    await manager.prompt(session.id, { text: "第二次" })
    await waitFor(() => completedOutputs(events).length >= 2)

    const second = completedOutputs(events)[1]!
    expect(second).toContain("yoma-test-second-pkg")
    // 旧的不能被顶掉。
    expect(second).toContain("yoma-test-first-pkg")

    await manager.disposeAll()
  }, 30_000)
})

describe("内置执行器使用会话工具链", () => {
  const binary = "yoma-native-fixture"
  function fixture(dir: string, marker: string): string {
    return writeNativeFakeExe(
      dir,
      binary,
      `
      if (process.argv.includes("--version")) console.log("1.0.0");
      else console.log(${JSON.stringify(marker)} + "|" + process.env.YOMA_PROJECT_EXPORT);
    `,
    )
  }
  function project(): string {
    const workspace = tempDir("yoma-native-project-")
    mkdirSync(path.join(workspace, ".yoma"))
    writeJSON(path.join(workspace, ".yoma", "toolchain.json"), {
      schema: "yoma/toolchain@1",
      tools: [{ id: binary, bin: [binary], exports: { YOMA_PROJECT_EXPORT: "{bin}" } }],
    })
    return workspace
  }
  function local(workspace: string, exe: string): void {
    writeJSON(path.join(workspace, ".yoma", "toolchain.local.json"), {
      [binary]: { id: binary, bin: { [binary]: exe }, confirmedAt: Date.now(), by: "user" },
    })
  }
  const call = () => fauxAssistantMessage([fauxToolCall("flash", { command: [fakeExeName(binary)] })])
  const done = () => fauxAssistantMessage([fauxText("done")])

  test("version probes and native calls both receive engine PATH, machine PATH, and declared exports", async () => {
    const configDir = tempDir("yoma-native-config-")
    const enginesDir = tempDir("yoma-native-engines-")
    writeNativeFakeExe(path.join(enginesDir, "bin"), "yoma-engine-helper", 'console.log("engine")')
    const machineExe = writeNativeFakeExe(
      tempDir("yoma-native-machine-"),
      "yoma-machine-helper",
      'console.log("machine")',
    )
    writeLedger(configDir, {
      "yoma-machine-helper": {
        id: "yoma-machine-helper",
        bin: { "yoma-machine-helper": machineExe },
        confirmedAt: Date.now(),
        by: "user",
      },
    })
    const workspace = project()
    const executable = writeNativeFakeExe(
      tempDir("yoma-native-probe-"),
      binary,
      `
      import { execFileSync } from "node:child_process";
      if (!process.env.YOMA_PROJECT_EXPORT) process.exit(5);
      const a = execFileSync(${JSON.stringify(fakeExeName("yoma-engine-helper"))}, [], { windowsHide: true }).toString().trim();
      const b = execFileSync(${JSON.stringify(fakeExeName("yoma-machine-helper"))}, [], { windowsHide: true }).toString().trim();
      console.log(process.argv.includes("--version") ? "1.0.0" : a + "|" + b + "|" + process.env.YOMA_PROJECT_EXPORT);
    `,
    )
    local(workspace, executable)
    let prompt = ""
    const { manager, events } = makeManager(
      [
        (context: { systemPrompt?: string }) => {
          prompt = context.systemPrompt ?? ""
          return call()
        },
        done(),
      ],
      { configDir, enginesDir },
    )
    try {
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "verify configured environment" })
      await waitFor(() => completedOutputs(events).length === 1 && statusesOf(events).at(-1) === "idle")
      expect(prompt).not.toContain("Project toolchain requirements")
      expect(completedOutputs(events)[0]).toContain(`engine|machine|${executable}`)
    } finally {
      await manager.disposeAll()
    }
  }, 30_000)

  test("two projects resolve the same command to different binaries/exports, ahead of a conflicting machine entry", async () => {
    const processPath = process.env.PATH
    const configDir = tempDir("yoma-native-config-")
    const a = project()
    const b = project()
    const aExe = fixture(tempDir("yoma-native-a-"), "A")
    const bExe = fixture(tempDir("yoma-native-b-"), "B")
    local(a, aExe)
    local(b, bExe)
    writeLedger(configDir, {
      [binary]: {
        id: binary,
        bin: { [binary]: fixture(tempDir("yoma-native-machine-"), "MACHINE") },
        confirmedAt: Date.now(),
        by: "user",
      },
    })
    const { manager, events } = makeManager([call(), done(), call(), done(), call(), done()], { configDir })
    try {
      const first = await manager.create(a)
      const second = await manager.create(b)
      for (const [index, id] of [first.id, second.id, first.id].entries()) {
        await manager.prompt(id, { text: "run fake native command" })
        await waitFor(() => completedOutputs(events).length > index && statusesOf(events).at(-1) === "idle")
      }
      const outputs = completedOutputs(events)
      expect(outputs[0]).toContain(`A|${aExe}`)
      expect(outputs[1]).toContain(`B|${bExe}`)
      expect(outputs[2]).toContain(`A|${aExe}`)
      expect(outputs.join("\n")).not.toContain("MACHINE|")
      expect(process.env.PATH).toBe(processPath)
    } finally {
      await manager.disposeAll()
    }
  }, 30_000)

  test("settings set and fresh resolution update native calls and system prompt in an already-open session", async () => {
    const configDir = tempDir("yoma-native-config-")
    const workspace = project()
    const events: KernelEvent[] = []
    const prompts: string[] = []
    const capture = (run: boolean) => (context: { systemPrompt?: string }) => {
      prompts.push(context.systemPrompt ?? "")
      return run ? call() : done()
    }
    const host = createKernelHost({
      sessionsRoot: tempDir("yoma-native-sessions-"),
      configDir,
      stateDir: tempDir("yoma-native-state-"),
      onEvents: (batch) => events.push(...batch),
      inspectStm32Availability: async () => ({ available: true }),
      resolveModels: async () => harnessWith([capture(false), capture(true), done(), capture(true), done()]),
    })
    try {
      const session = await host.handle("session.create", { directory: workspace })
      await host.handle("session.prompt", { sessionID: session.id, input: { text: "inspect missing tool" } })
      await waitFor(() => prompts.length === 1 && statusesOf(events).at(-1) === "idle")
      expect(prompts[0]).toContain("MISSING")
      const firstExe = fixture(tempDir("yoma-native-first-"), "FIRST")
      await host.handle("toolchain.set", { directory: workspace, id: binary, path: firstExe })
      await host.handle("session.prompt", { sessionID: session.id, input: { text: "run after setting" } })
      await waitFor(() => completedOutputs(events).length === 1 && statusesOf(events).at(-1) === "idle")
      expect(completedOutputs(events)[0]).toContain(`FIRST|${firstExe}`)
      expect(prompts[1]).not.toContain("Project toolchain requirements")

      const secondExe = fixture(tempDir("yoma-native-second-"), "SECOND")
      writeLedger(configDir, {
        [binary]: { id: binary, bin: { [binary]: secondExe }, confirmedAt: Date.now(), by: "user" },
      })
      await host.handle("toolchain.status", { directory: workspace, fresh: true })
      await host.handle("session.prompt", { sessionID: session.id, input: { text: "run after reprobe" } })
      await waitFor(() => completedOutputs(events).length === 2 && statusesOf(events).at(-1) === "idle")
      expect(completedOutputs(events)[1]).toContain(`SECOND|${secondExe}`)
    } finally {
      await host.dispose()
    }
  }, 30_000)

  test("a slow old refresh cannot overwrite a newer settings environment", async () => {
    const configDir = tempDir("yoma-native-config-")
    const workspace = project()
    const oldDir = tempDir("yoma-native-old-")
    const started = path.join(oldDir, "started")
    const release = path.join(oldDir, "release")
    const delay = path.join(oldDir, "delay")
    const oldExe = writeNativeFakeExe(
      oldDir,
      binary,
      `
      import { existsSync, writeFileSync } from "node:fs";
      if (process.argv.includes("--version")) {
        if (existsSync(${JSON.stringify(delay)})) {
          writeFileSync(${JSON.stringify(started)}, "started");
          while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
        }
        console.log("1.0.0");
      } else console.log("OLD|" + process.env.YOMA_PROJECT_EXPORT);
    `,
    )
    const newExe = fixture(tempDir("yoma-native-new-"), "NEW")
    const select = (exe: string) =>
      writeLedger(configDir, {
        [binary]: { id: binary, bin: { [binary]: exe }, confirmedAt: Date.now(), by: "user" },
      })
    select(oldExe)
    const { manager, events } = makeManager([done(), call(), done()], { configDir })
    let oldRefresh: Promise<void> | undefined
    try {
      const session = await manager.create(workspace)
      await manager.prompt(session.id, { text: "open session" })
      await waitFor(() => statusesOf(events).at(-1) === "idle")
      writeFileSync(delay, "delay")
      oldRefresh = manager.refreshMachineEnv()
      await waitFor(() => existsSync(started))
      select(newExe)
      await manager.refreshMachineEnv()
      writeFileSync(release, "release")
      await oldRefresh
      await manager.prompt(session.id, { text: "run with latest settings" })
      await waitFor(() => completedOutputs(events).length === 1 && statusesOf(events).at(-1) === "idle")
      expect(completedOutputs(events)[0]).toContain(`NEW|${newExe}`)
    } finally {
      writeFileSync(release, "release")
      await oldRefresh
      await manager.disposeAll()
    }
  }, 30_000)
})
