/**
 * 一次 trial 的端到端 —— 真子进程、真 harness、真工具、真会话落盘,只把模型换成
 * pi-ai 的 faux provider(不要网络、不要 key)。
 *
 * 这一条守的是 evals 最容易静默坏掉的接缝:**证据是从会话 JSONL 里读回来的**。
 * `TurnResult.toolCalls` 只有工具的输入,grounded 要的输出只在文件里 —— 那条路一断,
 * grounded 会变成"永远判不过",而报告上看起来像 agent 从来不查资料。
 *
 * 反向那一刀在同一条测试里:同一道题、同一套 grader,坏解必须红,而且要红在
 * `answer` 与 `grounded` 两处。
 */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { loadTasks, parseTask, type Task } from "./task.ts"
import { runEvals } from "./run.ts"
import { runTrial } from "./trial.ts"

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const fence = (answer: string) => `\`\`\`json\n{"answer": "${answer}"}\n\`\`\``

/**
 * 一道只用 `read` 工具的合成题 —— 不碰 engines、不碰硬件、不联网。
 *
 * 夹具用中性文件名(`note.txt`),题面也不提它从哪儿来:README 出题纪律第 5 条。
 * `read` 的参数名是 `path`(coding-agent/src/core/tools/read.ts),写错的话工具会报错,
 * 而症状是 grounded 判不过 —— 看起来像"它没查",实际是我们调错了。
 */
async function makeTask(): Promise<{ task: Task; repoRoot: string }> {
  const repoRoot = await tempDir("yoma-evals-fixture-")
  await writeFile(path.join(repoRoot, "note.txt"), "板上主控是 U3(RP2040),晶振接在 Y1。\n")
  const tasksDir = await tempDir("yoma-evals-tasks-")
  const dir = path.join(tasksDir, "note-probe")
  await mkdir(dir, { recursive: true })
  const raw = {
    id: "note-probe",
    title: "从记录里读出主控位号",
    tags: ["synthetic", "L1"],
    env: { kind: "none" },
    setup: { files: [{ from: "note.txt", to: "note.txt" }] },
    prompt: '看一眼工作目录里的 note.txt,最后一条消息用 ```json 围栏给出 {"answer": "<位号>"}',
    reference: { answer: "U3", note: "夹具里写死的" },
    graders: [{ type: "answer", equals: "U3" }, { type: "grounded" }],
    faux: {
      good: [[{ tool: "read", input: { path: "note.txt" } }], [{ text: fence("U3") }]],
      bad: [[{ text: fence("U1") }]],
    },
  }
  const file = path.join(dir, "task.json")
  await writeFile(file, JSON.stringify(raw, null, 2))
  return { task: parseTask(raw, file), repoRoot }
}

describe("runTrial · 端到端", () => {
  test("参考解通过,坏解在 answer 与 grounded 两处都红", async () => {
    const { task, repoRoot } = await makeTask()
    const runDir = await tempDir("yoma-evals-run-")
    const sessionsRoot = path.join(runDir, "sessions")
    // 隔离开发机真实的 ~/.yoma:否则结果取决于跑测试的人装了什么技能。
    const configDir = await tempDir("yoma-evals-config-")
    const shared = { task, runID: "test", runDir, sessionsRoot, configDir, repoRoot, settleMs: 150 }

    const good = await runTrial({ ...shared, index: 0, faux: task.faux!.good })

    expect([good.status, good.error]).toEqual(["pass", undefined])
    expect(good.score).toBe(1)
    expect(good.graders.map((verdict) => [verdict.type, verdict.pass])).toEqual([
      ["answer", true],
      ["grounded", true],
    ])
    expect(good.answer.parsed).toEqual({ answer: "U3" })

    // 指标真的有值 —— 全零说明 transcript 那条路断了,而 pass/fail 照样是对的。
    expect(good.metrics.turns).toBeGreaterThan(0)
    expect(good.metrics.toolCalls).toBe(1)
    expect(good.metrics.toolsUsed.read).toBe(1)
    expect(good.metrics.toolErrors).toBe(0)
    expect(good.metrics.elapsedMs).toBeGreaterThan(0)
    expect(good.metrics.stopReason).toBeUndefined()

    // 会话文件在,而且是内核铸的 uuid —— 报告里的回放路径按它拼。
    expect(good.sessionID).toMatch(/^[0-9a-f-]{36}$/)
    expect(existsSync(good.sessionFile!)).toBe(true)
    // 出了事可以直接拿 input.json 重放一轮(路径与 bench 的 stamp 公式一致)。
    expect(existsSync(good.inputFile!)).toBe(true)
    expect(existsSync(path.join(good.workspace!, "note.txt"))).toBe(true)

    const bad = await runTrial({ ...shared, index: 1, faux: task.faux!.bad })

    expect(bad.status).toBe("fail")
    expect(bad.score).toBe(0)
    expect(bad.graders.map((verdict) => [verdict.type, verdict.pass])).toEqual([
      ["answer", false],
      ["grounded", false],
    ])
    expect(bad.graders[0]!.detail).toContain("应为 U3")
    expect(bad.graders[1]!.detail).toContain("没有任何已完成的工具调用")
    expect(bad.metrics.toolCalls).toBe(0)
  }, 180_000)
})

describe("requires 门控", () => {
  test("需要板子的题整题 skip —— 一次模型花费都不发生", async () => {
    const tasksDir = await tempDir("yoma-evals-tasks-")
    const dir = path.join(tasksDir, "needs-board")
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, "task.json"),
      JSON.stringify({
        id: "needs-board",
        title: "要板子才能做的题",
        tags: ["synthetic", "L3"],
        requires: ["board"],
        env: { kind: "none" },
        prompt: '上板测一下,最后一条消息用 ```json 围栏给出 {"answer": "<结果>"}',
        reference: { answer: "ok" },
        graders: [{ type: "answer", equals: "ok" }],
      }),
    )

    const runDir = await tempDir("yoma-evals-run-")
    const outcome = await runEvals({ tasksDir, runDir, k: 2 })

    expect(outcome.taskErrors).toEqual([])
    expect(outcome.records).toHaveLength(2)
    for (const record of outcome.records) {
      expect(record.status).toBe("skip")
      expect(record.error).toContain("board")
      // skip 不该有任何执行痕迹:没有会话、没有 workspace。
      expect(record.sessionID).toBeUndefined()
    }
    expect(outcome.meta.totals).toEqual({ pass: 0, fail: 0, error: 0, skip: 2 })
    expect(existsSync(path.join(runDir, "summary.md"))).toBe(true)
    expect(existsSync(path.join(runDir, "results.jsonl"))).toBe(true)

    // 题本身是好的(能被解析出来),跳过的理由来自本机能力,不是题写坏了。
    const loaded = await loadTasks(tasksDir)
    expect(loaded.errors).toEqual([])
    expect(loaded.tasks[0]!.requires).toEqual(["board"])
  }, 60_000)
})
