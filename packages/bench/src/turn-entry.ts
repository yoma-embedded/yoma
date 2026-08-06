#!/usr/bin/env bun
/**
 * agent 轮的子进程入口。
 *
 * `bun turn-entry.ts <input.json> <output.json>`
 *
 * 一轮一个进程是刻意的:my-pi 的探针租约、gdb 会话表、log 采集器都是模块级全局并挂着
 * 进程退出钩子,进程边界因此是免费且可靠的清理 —— 轮次结束时探针一定被放开,
 * grader 接着去烧录不会撞上"探针被占着"。
 *
 * 与父进程的协议(小而蠢,便于重放):
 *   - 输入:argv[0] 指向的 JSON 文件(TurnInput);
 *   - 输出:argv[1] 指向的 JSON 文件(TurnResult);
 *   - stdout `@@escalate {json}` 一行 = 请求人工裁决,父进程往 stdin 回一行 JSON;
 *   - stdout 其余行 = 给人看的进度;stderr 直通父进程。
 */

import { writeFile } from "node:fs/promises"

import type { PermissionRequest } from "@yoma-desktop/kernel"

import type { TurnInput } from "./runner.ts"
import { runTurn, type TurnResult } from "./turn.ts"

const [inputFile, outputFile] = process.argv.slice(2)
if (!inputFile || !outputFile) {
  console.error("用法: bun turn-entry.ts <input.json> <output.json>")
  process.exit(2)
}

const input = (await Bun.file(inputFile).json()) as TurnInput

/** 未决的人工裁决请求。父进程按 id 回话。 */
const waiting = new Map<string, (response: "once" | "always" | "reject") => void>()

// stdin 上一行一个 {id, response}。父进程不接的话就永远不回 —— 那正是"挂起等人"的语义。
const decoder = new TextDecoder()
let pending = ""
process.stdin.on("data", (chunk: Buffer) => {
  pending += decoder.decode(chunk, { stream: true })
  const lines = pending.split("\n")
  pending = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const message = JSON.parse(line) as { id: string; response: "once" | "always" | "reject" }
      waiting.get(message.id)?.(message.response)
      waiting.delete(message.id)
    } catch {
      // 父进程发了脏数据 —— 忽略,别把一轮弄崩。
    }
  }
})

function say(message: string): void {
  process.stdout.write(`${message}\n`)
}

const result: TurnResult = await runTurn({
  job: input.job,
  workspace: input.workspace,
  sessionsRoot: input.sessionsRoot,
  stateDir: input.stateDir,
  enginesDir: input.enginesDir,
  sessionID: input.sessionID,
  prompt: input.prompt,
  // 无人接管时**不装** handler:runTurn 会把策略的 escalate 转成 deny,
  // 审计因此记成 policy 而不是 human。装一个"注定回拒"的 handler 是在伪造裁决者。
  onEscalation: input.unattended
    ? undefined
    : (request: PermissionRequest) =>
        new Promise((resolve) => {
          waiting.set(request.id, resolve)
          say(`@@escalate ${JSON.stringify(request)}`)
        }),
  onEvent: (event) => {
    if (event.type === "message.part.updated" && event.part.type === "tool") {
      const part = event.part
      if (part.state.status === "running") say(`  → ${part.tool}`)
      if (part.state.status === "error") say(`  ✗ ${part.tool}:${part.state.error}`)
    }
  },
  shouldStop: (usage) => {
    const spent = input.spentTokens + usage.tokens.input + usage.tokens.output
    return spent >= input.maxTokens ? `token 预算 ${input.maxTokens} 耗尽` : undefined
  },
})

await writeFile(outputFile, JSON.stringify(result, null, 2))
say(`轮次结束:${result.toolCalls.length} 次工具调用,${(result.elapsedMs / 1000).toFixed(0)}s`)

// runTurn 已经 dispose 了 host,但 my-pi 的模块级采集器可能还挂着 stdin 监听。
process.exit(0)
