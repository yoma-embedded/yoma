/**
 * 工具链清单接入会话装配(session-manager.ts ensureOpen() 的那三行改动)的验证。
 *
 * 只测这一层的接线,不重测 resolve.ts / shellEnvFor 自身的判定逻辑 —— 那部分已经在
 * coding-agent/test/toolchain-resolve.test.ts 覆盖过。这里要证明的是三件事:
 *
 * 1. 解析出的 PATH 前置 + exports 真的到了 NodeExecutionEnv 构造出来的 shellEnv,
 *    并且真的送进了后续 spawn 的子进程 —— 用 bash 工具跑一条真命令验证,不 mock
 *    NodeExecutionEnv:PATH/环境变量这类跨进程边界的东西正是"类型系统永远抓不到"
 *    的那类问题(根 CLAUDE.md「会咬人的地方」),mock 掉构造参数只能证明"我们传了
 *    某个值",证明不了"这个值真的影响了 spawn 出来的进程"。
 * 2. 系统提示词只在"有需要留意的工具"时才追加一段 <toolchain> 说明;没有清单、
 *    或清单里的工具全部 ok 时字节不变(不追加任何 contextFiles 条目)。
 * 3. 清单存在但内容损坏时发 kernel.error,不拖累会话本身开不起来。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Model } from "@earendil-works/pi-ai"

import type { KernelEvent } from "../protocol.ts"
import type { ToolPart } from "../types.ts"
import { SessionManager } from "./session-manager.ts"

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

function makeManager(steps: unknown[]) {
  const events: KernelEvent[] = []
  const manager = new SessionManager({
    sessionsRoot: tempDir("yoma-tc-sessions-"),
    // 隔离开发机真实的 ~/.yoma —— 不传的话 resolveToolchain 会去读它的
    // toolchains.json 账本,测试结果就取决于跑测试的机器上账本记了什么。
    configDir: tempDir("yoma-tc-config-"),
    emit: (batch) => events.push(...batch),
    resolveModels: async () => harnessWith(steps),
  })
  return { manager, events }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("等待超时")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function toolPartsOf(events: KernelEvent[]): ToolPart[] {
  return events.flatMap((e) => (e.type === "message.part.updated" && e.part.type === "tool" ? [e.part as ToolPart] : []))
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

    // 本机账本覆盖(不提交):直接给一个真实存在的假文件。不需要它真能跑——清单里
    // 没写 version,resolveTool 的 satisfiesWanted 对"没有版本要求"永远为真,
    // probeVersion 探测这个假文件必然失败(它不是可执行文件)也不影响最终 status。
    const binDir = tempDir("yoma-tc-bin-")
    const binPath = path.join(binDir, "gizmofake")
    writeFileSync(binPath, "")
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

    await waitFor(() => toolPartsOf(events).some((part) => part.state.status === "completed" || part.state.status === "error"))

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
