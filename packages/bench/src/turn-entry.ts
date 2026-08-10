#!/usr/bin/env bun
/**
 * agent 轮的子进程入口。
 *
 * `bun turn-entry.ts <input.json> <output.json>`
 *
 * 一轮一个进程是刻意的:my-pi 的探针租约、gdb 会话表、log 采集器都是模块级全局并挂着
 * 进程退出钩子,进程边界因此是免费且可靠的清理 —— 轮次结束时探针一定被放开,
 * 下一轮不会撞上"探针被占着"。
 *
 * 与父进程的协议(小而蠢,便于重放):
 *   - 输入:argv[0] 指向的 JSON 文件(TurnInput);
 *   - 输出:argv[1] 指向的 JSON 文件(TurnResult);
 *   - stdout = 给人看的进度;stderr 直通父进程。单向,没有回话通道。
 */

import { writeFile } from "node:fs/promises"

import { fauxResolveModels } from "./faux.ts"
import { readJsonFile } from "./fsx.ts"
import type { TurnInput } from "./runner.ts"
import { runTurn, type TurnResult } from "./turn.ts"

const [inputFile, outputFile] = process.argv.slice(2)
if (!inputFile || !outputFile) {
  console.error("用法: bun turn-entry.ts <input.json> <output.json>")
  process.exit(2)
}

const input = await readJsonFile<TurnInput>(inputFile)

function say(message: string): void {
  process.stdout.write(`${message}\n`)
}

const result: TurnResult = await runTurn({
  job: input.job,
  workspace: input.workspace,
  sessionsRoot: input.sessionsRoot,
  stateDir: input.stateDir,
  enginesDir: input.enginesDir,
  configDir: input.configDir,
  // 假模型脚本以数据形态穿进来(本机演练/打包冒烟)—— 不联网、不要 key,其余全真。
  resolveModels: input.faux ? fauxResolveModels(input.faux) : undefined,
  sessionID: input.sessionID,
  prompt: input.prompt,
  onEvent: (event) => {
    if (event.type === "message.part.updated" && event.part.type === "tool") {
      const part = event.part
      if (part.state.status === "running") say(`  → ${part.tool}`)
      if (part.state.status === "error") say(`  ✗ ${part.tool}:${part.state.error}`)
    }
  },
})

await writeFile(outputFile, JSON.stringify(result, null, 2))
say(`轮次结束:${result.toolCalls.length} 次工具调用,${(result.elapsedMs / 1000).toFixed(0)}s`)

// runTurn 已经 dispose 了 host,但 my-pi 的模块级采集器可能还挂着监听。
process.exit(0)
