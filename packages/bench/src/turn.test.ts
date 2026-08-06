/**
 * 一轮 agent 执行的端到端:真 kernel host + 真 harness + 真权限门,只把模型换成
 * pi-ai 的 faux provider(不要网络、不要 key)。
 *
 * 这一条守的是 bench 最容易静默坏掉的地方:轮次结束判定。判早了 grader 会和自动压缩
 * 抢会话;判晚了每轮白等。所以这里专门断言"工具跑完之后仍然等到真 idle"。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

import { parseJob, type Job } from "./job.ts"
import { runTurn } from "./turn.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

let fauxCount = 0
function models(steps: unknown[]) {
  return async () => {
    const registry = createModels()
    const faux = fauxProvider({ provider: `faux-bench-${++fauxCount}` })
    registry.setProvider(faux.provider)
    faux.setResponses(steps as never)
    return { models: registry, model: faux.getModel() as Model<string> }
  }
}

function job(workspace: string, overrides: Record<string, unknown> = {}): Job {
  return parseJob({
    id: "j-test",
    title: "测试任务",
    task: "修一个 bug",
    repo: { directory: workspace },
    bench: { chip: "STM32G474RE", knownGoodElf: "good.elf" },
    success: { checks: [{ type: "bash", command: "true" }] },
    policy: "unattended",
    ...overrides,
  })
}

function turnOptions(workspace: string, steps: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    job: job(workspace, (overrides.jobOverrides as Record<string, unknown>) ?? {}),
    workspace,
    sessionsRoot: tempDir("bench-sessions-"),
    stateDir: tempDir("bench-state-"),
    prompt: "开始",
    resolveModels: models(steps),
    // 隔离开发机真实的 ~/.my-pi:否则测试结果取决于跑测试的人装了什么技能。
    configDir: tempDir("bench-config-"),
    settleMs: 120,
    ...overrides,
  }
}

/** 一条可重试的 provider 失败。faux 的 step 可以直接是一条 AssistantMessage。 */
function retryableError(errorMessage = "503 Service Unavailable") {
  return {
    role: "assistant",
    content: [],
    api: "faux",
    provider: "faux",
    model: "faux",
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

describe("runTurn", () => {
  test("跑完一轮,拿到正文与用量", async () => {
    const workspace = tempDir("bench-ws-")
    const result = await runTurn(turnOptions(workspace, [fauxAssistantMessage([fauxText("已定位到中断优先级配错")])]))

    expect(result.text).toContain("中断优先级")
    // 会话 id 是内核铸的 uuidv7,不是 opencode 的 ses_ 前缀 —— 报告里的回放链接按它拼。
    expect(result.sessionID).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.stopReason).toBeUndefined()
    expect(result.errors).toEqual([])
    expect(result.usage.tokens.output).toBeGreaterThanOrEqual(0)
  })

  test("result.text 只含模型说的话 —— 提示词不能回流进报告的根因分析", async () => {
    const workspace = tempDir("bench-ws-")
    const result = await runTurn({
      ...turnOptions(workspace, [fauxAssistantMessage([fauxText("根因是 RX FIFO 没开中断")])]),
      prompt: "这是任务书,里面有一句很特别的话:紫色的大象在跳舞",
    })

    expect(result.text).toContain("RX FIFO")
    expect(result.text).not.toContain("紫色的大象")
  })

  test("工具调用被记录,且轮次等到工具真的跑完", async () => {
    const workspace = tempDir("bench-ws-")
    writeFileSync(path.join(workspace, "main.c"), "int main(void){return 0;}\n")
    const result = await runTurn(
      turnOptions(workspace, [
        fauxAssistantMessage([fauxToolCall("read", { path: "main.c" })]),
        fauxAssistantMessage([fauxText("看过了")]),
      ]),
    )

    const read = result.toolCalls.find((call) => call.tool === "read")
    expect(read).toBeDefined()
    expect(read!.status).toBe("completed")
    expect(result.text).toContain("看过了")
  })

  test("策略放行的动作不产生升级", async () => {
    const workspace = tempDir("bench-ws-")
    writeFileSync(path.join(workspace, "main.c"), "int main(void){return 0;}\n")
    const escalations: string[] = []
    const result = await runTurn(
      turnOptions(
        workspace,
        [
          fauxAssistantMessage([fauxToolCall("read", { path: "main.c" })]),
          fauxAssistantMessage([fauxText("done")]),
        ],
        { onEscalation: async (request: { tool: string }) => (escalations.push(request.tool), "reject" as const) },
      ),
    )

    expect(escalations).toEqual([])
    expect(result.decisions.map((d) => `${d.tool}:${d.verdict}`)).toContain("read:allow")
  })

  test("策略要升级时走 onEscalation,拒绝会让工具被拦下", async () => {
    const workspace = tempDir("bench-ws-")
    const asked: string[] = []
    const result = await runTurn(
      turnOptions(
        workspace,
        [
          fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /" })]),
          fauxAssistantMessage([fauxText("被拦了")]),
        ],
        {
          onEscalation: async (request: { tool: string }) => {
            asked.push(request.tool)
            return "reject" as const
          },
        },
      ),
    )

    expect(asked).toEqual(["bash"])
    const bash = result.decisions.find((d) => d.tool === "bash")
    expect(bash?.verdict).toBe("deny")
    expect(bash?.rule).toBe("bash.not-allowed")
  })

  test("没有 onEscalation 时一律拒绝,且审计要记成 policy 而不是 human", async () => {
    const workspace = tempDir("bench-ws-")
    const result = await runTurn(
      turnOptions(workspace, [
        fauxAssistantMessage([fauxToolCall("bash", { command: "curl http://evil" })]),
        fauxAssistantMessage([fauxText("被拦了")]),
      ]),
    )

    const bash = result.decisions.find((d) => d.tool === "bash")
    expect(bash?.verdict).toBe("deny")
    // 当时没有人在,记成 human 就是把责任安在不存在的人头上。
    expect(bash?.by).toBe("policy")
    expect(bash?.rule).toBe("bash.not-allowed")
  })

  test("job 的 allowCommands 写 ./x.sh 也能生效 —— 匹配端看的是 basename", async () => {
    const workspace = tempDir("bench-ws-")
    writeFileSync(path.join(workspace, "check.sh"), "#!/bin/sh\nexit 0\n")
    const result = await runTurn(
      turnOptions(
        workspace,
        [
          fauxAssistantMessage([fauxToolCall("bash", { command: "./check.sh" })]),
          fauxAssistantMessage([fauxText("跑过了")]),
        ],
        { jobOverrides: { allowCommands: ["./check.sh"] } },
      ),
    )

    expect(result.decisions.find((d) => d.tool === "bash")?.verdict).toBe("allow")
  })

  test("shouldStop 触发时中断本轮并给出理由", async () => {
    const workspace = tempDir("bench-ws-")
    writeFileSync(path.join(workspace, "main.c"), "int main(void){return 0;}\n")
    const result = await runTurn(
      turnOptions(
        workspace,
        [
          fauxAssistantMessage([fauxToolCall("read", { path: "main.c" })]),
          fauxAssistantMessage([fauxText("还没说完")]),
        ],
        { shouldStop: () => "token 预算耗尽" },
      ),
    )

    expect(result.stopReason).toBe("token 预算耗尽")
  })

  test("provider 抽风时轮次不会提前结束 —— 内核重试完才算跑完", async () => {
    // 这是 bench 最贵的一种静默错误:失败那一轮结束时若状态落回 idle,settle 计时器
    // 会在 2s 退避窗口里认定"跑完了",runner 随即去跑判据 —— 而 agent 正要重试,
    // 两边同时动板子。host 侧把整段重试保持为一个连续的 busy,这条测试钉住它。
    const workspace = tempDir("bench-ws-")
    const result = await runTurn(
      turnOptions(workspace, [retryableError("503 Service Unavailable"), fauxAssistantMessage([fauxText("重试之后成了")])]),
    )

    expect(result.text).toContain("重试之后成了")
    expect(result.stopReason).toBeUndefined()
    // 失败那一次仍然进 errors,报告里看得到"这一轮抽过风"。
    expect(result.errors.join()).toContain("503")
  }, 30_000)

  test("续跑同一会话:第二轮拿到同一个 sessionID", async () => {
    const workspace = tempDir("bench-ws-")
    const sessionsRoot = tempDir("bench-sessions-")
    const stateDir = tempDir("bench-state-")
    const base = {
      job: job(workspace),
      workspace,
      sessionsRoot,
      stateDir,
      settleMs: 120,
    }

    const first = await runTurn({
      ...base,
      prompt: "第一轮",
      resolveModels: models([fauxAssistantMessage([fauxText("一")])]),
    })
    const second = await runTurn({
      ...base,
      prompt: "第二轮",
      sessionID: first.sessionID,
      resolveModels: models([fauxAssistantMessage([fauxText("二")])]),
    })

    expect(second.sessionID).toBe(first.sessionID)
    expect(second.text).toContain("二")
  })
})
