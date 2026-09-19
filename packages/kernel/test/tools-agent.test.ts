/**
 * 子 agent 四件工具(host/tools/{agent,task_output,task_stop,send_message})的验收,用假的 TaskHost
 * (docs/子agent-设计方案-v0.4-20260918.md §5、§12 P1)。宿主怎么开子会话、怎么等是 P2 的事;这里钉的是
 * 工具这一层:参数怎么交给宿主、结果怎么写成模型看到的话。
 *
 * 结果文本**逐字**照 CC(`AgentTool.tsx` / `TaskOutputTool.tsx` / `TaskStopTool.ts` / `SendMessageTool.ts`),
 * 只把 SendMessage 换成 send_message、Read / Bash 换成 read / bash —— 那是模型已经学会的信号。
 */

import type { AgentHarnessToolInvocation, AgentToolResult, ExecutionToolContext } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"
import { describe, expect, it } from "vitest"

import { BUILTIN_AGENTS } from "../src/host/domain/agents/builtin.ts"
import type {
  SendOutcome,
  SpawnCall,
  SpawnOutcome,
  SpawnRequest,
  StopOutcome,
  TaskHost,
  TaskOutputView,
  TaskSnapshot,
} from "../src/host/domain/agents/task-host.ts"
import { createAgentTool, SUBAGENTS_UNAVAILABLE } from "../src/host/tools/agent/session.ts"
import { createSendMessageTool } from "../src/host/tools/send_message/session.ts"
import { createTaskOutputTool } from "../src/host/tools/task_output/session.ts"
import { createTaskStopTool } from "../src/host/tools/task_stop/session.ts"
import { activeToolNames, createAgentTools } from "../src/host/session-manager.ts"

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}
const toolContext: ExecutionToolContext = { env: new NodeExecutionEnv({ cwd: process.cwd() }) }

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskID: "sub-1",
    agent: "Explore",
    description: "Trace clock tree",
    status: "completed",
    background: false,
    turns: 3,
    usage: { totalTokens: 1234, toolUses: 5, durationMs: 6789 },
    outputFile: "/tmp/yoma/parent/tasks/sub-1.output",
    ...overrides,
  }
}

interface Calls {
  spawn: Array<{ request: SpawnRequest; call: SpawnCall }>
  output: Array<{ taskID: string; block: boolean; timeoutMs: number; signal: AbortSignal | undefined }>
  stop: string[]
  send: Array<{ to: string; message: string; summary?: string; signal: AbortSignal | undefined }>
}

function fakeHost(behavior: {
  background?: boolean
  spawn?: (request: SpawnRequest, call: SpawnCall) => Promise<SpawnOutcome>
  output?: () => Promise<TaskOutputView | undefined>
  stop?: () => Promise<StopOutcome>
  send?: () => Promise<SendOutcome>
}): { host: TaskHost; calls: Calls } {
  const calls: Calls = { spawn: [], output: [], stop: [], send: [] }
  const unexpected = () => Promise.reject(new Error("unexpected call"))
  const host: TaskHost = {
    profiles: () => BUILTIN_AGENTS,
    backgroundAllowed: () => behavior.background ?? true,
    spawn: (request, call) => {
      calls.spawn.push({ request, call })
      return behavior.spawn ? behavior.spawn(request, call) : unexpected()
    },
    output: (taskID, options) => {
      calls.output.push({ taskID, ...options })
      return behavior.output ? behavior.output() : unexpected()
    },
    stop: (taskID) => {
      calls.stop.push(taskID)
      return behavior.stop ? behavior.stop() : unexpected()
    },
    send: (to, message, options) => {
      calls.send.push({ to, message, ...options })
      return behavior.send ? behavior.send() : unexpected()
    },
  }
  return { host, calls }
}

function textOf(result: AgentToolResult<unknown>): string[] {
  return result.content.map((part) => (part.type === "text" ? part.text : ""))
}

function runAgent(tool: ReturnType<typeof createAgentTool>, params: Record<string, unknown>, context: Context = BACKGROUND_CONTEXT) {
  const updates: Array<AgentToolResult<unknown>> = []
  const result = tool.execute("call-1", params as never, (partial) => updates.push(partial), toolContext, invocation, context)
  return { result, updates }
}

describe("agent 工具:描述与 schema", () => {
  it("描述照 CC 的结构,列出每个 agent 与它的工具", () => {
    const { host } = fakeHost({})
    const description = createAgentTool({ host }).description
    expect(description.startsWith("Launch a new agent to handle complex, multi-step tasks autonomously.")).toBe(true)
    expect(description).toContain(
      "- general-purpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
    )
    expect(description).toContain("(Tools: All tools except edit, write, toolchain, stm32config)")
    expect(description).toContain("(Tools: datasheet, read, grep, find, ls)")
    expect(description).toContain("If omitted, the general-purpose agent is used.")
    expect(description).toContain("do NOT sleep, poll, or proactively check on its progress")
    expect(description).toContain("**Don't race.**")
    expect(description).toContain("**Never delegate understanding.**")
    expect(description).toContain("Sub-agents cannot use hardware tools (flash, log, la, scope, gdb)")
  })

  it("宿主不能后台时:run_in_background 从 schema 里摘掉,后台相关的段落与例子不出", () => {
    const { host } = fakeHost({ background: false })
    const tool = createAgentTool({ host })
    const properties = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)
    expect(properties).toEqual(["description", "prompt", "subagent_type", "model"])
    expect(tool.description).not.toContain("run_in_background")
    expect(tool.description).not.toContain("Don't race")
    expect(tool.description).not.toContain("background")
    const withBackground = createAgentTool({ host: fakeHost({}).host })
    expect(Object.keys((withBackground.parameters as { properties: Record<string, unknown> }).properties)).toContain(
      "run_in_background",
    )
  })

  it("没有宿主:照常登记,execute 报不支持", async () => {
    const tool = createAgentTool()
    expect(tool.name).toBe("agent")
    await expect(runAgent(tool, { description: "x", prompt: "y" }).result).rejects.toThrow(SUBAGENTS_UNAVAILABLE)
  })
})

describe("agent 工具:交给宿主的东西", () => {
  it("缺省类型 general-purpose;model 去空白;toolCallId 与父的中止信号原样交给宿主", async () => {
    const { host, calls } = fakeHost({ spawn: async () => ({ kind: "completed", task: task(), text: "done", oneShot: false }) })
    const controller = new AbortController()
    await runAgent(
      createAgentTool({ host }),
      { description: "Trace clock tree", prompt: "find SystemClock_Config", model: "  deepseek/deepseek-v4-flash " },
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    ).result
    expect(calls.spawn).toHaveLength(1)
    expect(calls.spawn[0]!.request).toEqual({
      agent: "general-purpose",
      description: "Trace clock tree",
      prompt: "find SystemClock_Config",
      model: "deepseek/deepseek-v4-flash",
      runInBackground: false,
    })
    expect(calls.spawn[0]!.call.toolCallId).toBe("call-1")
    expect(calls.spawn[0]!.call.signal).toBe(controller.signal)
  })

  it("不认识的 agent 类型:CC 的原话,并列出可用的", async () => {
    const { host, calls } = fakeHost({})
    await expect(
      runAgent(createAgentTool({ host }), { description: "x", prompt: "y", subagent_type: "nope" }).result,
    ).rejects.toThrow("Agent type 'nope' not found. Available agents: general-purpose, Explore, datasheet")
    expect(calls.spawn).toEqual([])
  })

  it("run_in_background:能后台时照交;不能后台时模型硬塞进来也不认", async () => {
    const launched = async (): Promise<SpawnOutcome> => ({ kind: "async_launched", task: task({ background: true, status: "running" }) })
    const allowed = fakeHost({ spawn: launched })
    await runAgent(createAgentTool({ host: allowed.host }), { description: "d", prompt: "p", run_in_background: true }).result
    expect(allowed.calls.spawn[0]!.request.runInBackground).toBe(true)

    const denied = fakeHost({ background: false, spawn: async () => ({ kind: "completed", task: task(), text: "x", oneShot: true }) })
    await runAgent(createAgentTool({ host: denied.host }), { description: "d", prompt: "p", run_in_background: true }).result
    expect(denied.calls.spawn[0]!.request.runInBackground).toBe(false)
  })

  it("父被中止时信号到得了宿主:宿主停掉子 agent,工具以错误结束并带部分结果", async () => {
    const { host } = fakeHost({
      spawn: (_request, call) =>
        new Promise((resolve) =>
          call.signal!.addEventListener("abort", () =>
            resolve({ kind: "stopped", task: task({ status: "killed" }), reason: "killed", partial: "found PLL at rcc.c:88" }),
          ),
        ),
    })
    const controller = new AbortController()
    const { result } = runAgent(createAgentTool({ host }), { description: "Trace clock tree", prompt: "p" }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))
    controller.abort()
    await expect(result).rejects.toThrow(
      `Agent "Trace clock tree" was stopped before it finished.\n\nPartial result:\nfound PLL at rcc.c:88\n\nagentId: sub-1 (use send_message with to: 'sub-1' to continue this agent)`,
    )
  })

  it("宿主报进度 → 父 lane 上一拍 tool_update,正文一行、details 是任务快照", async () => {
    const { host } = fakeHost({
      spawn: async (_request, call) => {
        call.onProgress(task({ status: "running", turns: 2, usage: { totalTokens: 10, toolUses: 3, durationMs: 50 }, lastTool: "grep" }))
        return { kind: "completed", task: task(), text: "ok", oneShot: false }
      },
    })
    const { result, updates } = runAgent(createAgentTool({ host }), { description: "d", prompt: "p" })
    await result
    expect(updates).toHaveLength(1)
    expect(textOf(updates[0]!)).toEqual(["2 turns · 3 tool uses · last: grep"])
    expect(updates[0]!.details).toMatchObject({ taskID: "sub-1", status: "running", turns: 2, lastTool: "grep" })
  })
})

describe("agent 工具:结果的原话(CC mapToolResultToToolResultBlockParam)", () => {
  it("前台完成:结果正文 + 续跑尾巴", async () => {
    const { host } = fakeHost({ spawn: async () => ({ kind: "completed", task: task(), text: "SYSCLK is 168 MHz", oneShot: false }) })
    const result = await runAgent(createAgentTool({ host }), { description: "d", prompt: "p" }).result
    expect(textOf(result)).toEqual([
      "SYSCLK is 168 MHz",
      "agentId: sub-1 (use send_message with to: 'sub-1' to continue this agent)\n<usage>total_tokens: 1234\ntool_uses: 5\nduration_ms: 6789</usage>",
    ])
    expect(result.details).toMatchObject({ taskID: "sub-1", agent: "Explore", status: "completed", outputFile: "/tmp/yoma/parent/tasks/sub-1.output" })
  })

  it("一次性 agent 省掉尾巴;没有文字时换成占位句", async () => {
    const oneShot = fakeHost({ spawn: async () => ({ kind: "completed", task: task(), text: "found it", oneShot: true }) })
    expect(textOf(await runAgent(createAgentTool({ host: oneShot.host }), { description: "d", prompt: "p" }).result)).toEqual(["found it"])
    const empty = fakeHost({ spawn: async () => ({ kind: "completed", task: task(), text: "  ", oneShot: true }) })
    expect(textOf(await runAgent(createAgentTool({ host: empty.host }), { description: "d", prompt: "p" }).result)).toEqual([
      "(Subagent completed but returned no output.)",
    ])
  })

  it("后台派出:CC 的 async_launched 原话,父能读文件时带 output_file", async () => {
    const launched = async (): Promise<SpawnOutcome> => ({ kind: "async_launched", task: task({ status: "running", background: true }) })
    const { host } = fakeHost({ spawn: launched })
    expect(textOf(await runAgent(createAgentTool({ host }), { description: "d", prompt: "p", run_in_background: true }).result)).toEqual([
      `Async agent launched successfully.
agentId: sub-1 (internal ID - do not mention to user. Use send_message with to: 'sub-1' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes.
Do not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.
output_file: /tmp/yoma/parent/tasks/sub-1.output
If asked, you can check progress before completion by using read or bash tail on the output file.`,
    ])
    const blind = createAgentTool({ host: fakeHost({ spawn: launched }).host, canReadOutputFile: false })
    const [text] = textOf(await runAgent(blind, { description: "d", prompt: "p", run_in_background: true }).result)
    expect(text!.endsWith(
      "Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message.",
    )).toBe(true)
  })

  it("前台失败:错误带原因;没有部分结果时明说", async () => {
    const { host } = fakeHost({
      spawn: async () => ({ kind: "stopped", task: task({ status: "failed" }), reason: "failed", error: "model unavailable", partial: undefined }),
    })
    await expect(runAgent(createAgentTool({ host }), { description: "d", prompt: "p" }).result).rejects.toThrow(
      `Agent "Trace clock tree" failed: model unavailable\n\nIt produced no output before it stopped.\n\nagentId: sub-1`,
    )
  })
})

describe("task_output 工具", () => {
  const view: TaskOutputView = {
    retrieval_status: "success",
    task: { task_id: "sub-1", task_type: "local_agent", status: "completed", description: "d", prompt: "p", output: "the result\n" },
  }

  it("缺省 block = true、timeout = 30000;超出范围钳到 0..600000;中止信号交给宿主", async () => {
    const { host, calls } = fakeHost({ output: async () => view })
    const tool = createTaskOutputTool({ host })
    const controller = new AbortController()
    await tool.execute("c", { task_id: "sub-1" }, () => {}, toolContext, invocation, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))
    await tool.execute("c", { task_id: "sub-1", block: false, timeout: 10_000_000 }, () => {}, toolContext, invocation, BACKGROUND_CONTEXT)
    await tool.execute("c", { task_id: "sub-1", timeout: -5 }, () => {}, toolContext, invocation, BACKGROUND_CONTEXT)
    expect(calls.output.map(({ block, timeoutMs }) => [block, timeoutMs])).toEqual([
      [true, 30_000],
      [false, 600_000],
      [true, 0],
    ])
    expect(calls.output[0]!.signal).toBe(controller.signal)
  })

  it("结果照 CC 的 XML 段落;找不到任务时 CC 的原话", async () => {
    const { host } = fakeHost({ output: async () => view })
    const result = await createTaskOutputTool({ host }).execute("c", { task_id: "sub-1" }, () => {}, toolContext, invocation, BACKGROUND_CONTEXT)
    expect(textOf(result)).toEqual([
      "<retrieval_status>success</retrieval_status>\n\n<task_id>sub-1</task_id>\n\n<task_type>local_agent</task_type>\n\n<status>completed</status>\n\n<output>\nthe result\n</output>",
    ])
    const missing = fakeHost({ output: async () => undefined })
    await expect(
      createTaskOutputTool({ host: missing.host }).execute("c", { task_id: "zzz" }, () => {}, toolContext, invocation, BACKGROUND_CONTEXT),
    ).rejects.toThrow("No task found with ID: zzz")
  })
})

describe("task_stop 工具", () => {
  it("停掉:CC 的 JSON 形状", async () => {
    const { host, calls } = fakeHost({ stop: async () => ({ ok: true, task: task({ status: "killed" }) }) })
    const result = await createTaskStopTool({ host }).execute("c", { task_id: "sub-1" }, () => {}, toolContext, invocation, BACKGROUND_CONTEXT)
    expect(calls.stop).toEqual(["sub-1"])
    expect(JSON.parse(textOf(result)[0]!)).toEqual({
      message: "Successfully stopped task: sub-1 (Trace clock tree)",
      task_id: "sub-1",
      task_type: "local_agent",
      command: "Trace clock tree",
    })
  })

  it("找不到 / 不在跑:两句不同的错", async () => {
    const tool = (outcome: StopOutcome) => createTaskStopTool({ host: fakeHost({ stop: async () => outcome }).host })
    await expect(
      tool({ ok: false, reason: "not_found" }).execute("c", { task_id: "x" }, () => {}, toolContext, invocation, BACKGROUND_CONTEXT),
    ).rejects.toThrow("No task found with ID: x")
    await expect(
      tool({ ok: false, reason: "not_running", status: "completed" }).execute("c", { task_id: "x" }, () => {}, toolContext, invocation, BACKGROUND_CONTEXT),
    ).rejects.toThrow("Task x is not running (status: completed)")
  })
})

describe("send_message 工具", () => {
  const send = async (outcome: SendOutcome) => {
    const { host, calls } = fakeHost({ send: async () => outcome })
    const result = await createSendMessageTool({ host }).execute(
      "c",
      { to: "sub-1", message: "also check DMA", summary: "check DMA too" },
      () => {},
      toolContext,
      invocation,
      BACKGROUND_CONTEXT,
    )
    return { result, calls }
  }

  it("运行中:排队,CC 的原话;summary 交给宿主", async () => {
    const { result, calls } = await send({ kind: "queued", task: task({ status: "running" }) })
    expect(JSON.parse(textOf(result)[0]!)).toEqual({
      success: true,
      message: "Message queued for delivery to sub-1 at its next tool round.",
    })
    expect(calls.send[0]).toMatchObject({ to: "sub-1", message: "also check DMA", summary: "check DMA too" })
  })

  it("已结束:后台续跑,CC 的原话带续跑前的状态与 output_file", async () => {
    const { result } = await send({ kind: "resumed", task: task({ status: "running" }), previousStatus: "completed" })
    expect(JSON.parse(textOf(result)[0]!)).toEqual({
      success: true,
      message:
        "Agent \"sub-1\" was stopped (completed); resumed it in the background with your message. You'll be notified when it finishes. Output: /tmp/yoma/parent/tasks/sub-1.output",
    })
  })

  it("不能后台的宿主:前台续跑,结果与 agent 工具的前台结果同形", async () => {
    const { result } = await send({ kind: "resumed_foreground", outcome: { kind: "completed", task: task(), text: "DMA ok", oneShot: false } })
    expect(textOf(result)[0]).toBe("DMA ok")
    expect(textOf(result)[1]).toContain("agentId: sub-1")
  })

  it("找不到:success 为 false,告诉模型该用哪个 id", async () => {
    const { result } = await send({ kind: "not_found" })
    expect(JSON.parse(textOf(result)[0]!)).toEqual({
      success: false,
      message: 'No agent with ID "sub-1". Use the agentId from the agent tool result.',
    })
  })
})

describe("装配与激活", () => {
  it("四件登记在装配面末尾;宿主没接 TaskHost 之前不激活(模型看不见用不了的工具)", () => {
    const tools = createAgentTools()
    expect(tools.slice(-4).map((tool) => tool.name)).toEqual(["agent", "task_output", "task_stop", "send_message"])
    const active = activeToolNames(tools, true)
    expect(active).not.toContain("agent")
    expect(active).toContain("stm32config")
    expect(activeToolNames(tools, false)).not.toContain("stm32config")
  })
})
