/**
 * 评测入口的端到端:真 kernel host、真 harness、真工具装配、真会话落盘,只把模型换成
 * pi-ai 的 faux(不联网、不要 key)。守的是"跑批器调过来的一轮能不能干净地跑完并如实记账"。
 *
 * 与 turn.test.ts 的分工:那边守轮次结束判定,这边守 **胶水层** —— instruction 进得去、
 * result 出得来、事件流落得下、配置错误在开跑前就报。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { FauxScript } from "../faux.ts"
import { EvalConfigError, runEval, type EvalOptions } from "./run.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function options(overrides: Partial<EvalOptions> = {}): EvalOptions {
  const cwd = overrides.cwd ?? tempDir("yoma-eval-ws-")
  const configDir = tempDir("yoma-eval-config-")
  return {
    cwd,
    instruction: "看一眼工作目录,说说这是什么工程",
    providerID: "deepseek",
    modelID: "deepseek-v4-flash-vision-exp",
    configDir,
    sessionsRoot: path.join(configDir, "sessions"),
    stateDir: path.join(configDir, "state"),
    ...overrides,
  }
}

/** faux 的一段脚本:一个元素 = 一次 provider 响应。 */
const SAY_HELLO: FauxScript = [[{ text: "这是一个空工程,没有源码文件。" }]]

describe("runEval · faux", () => {
  test("跑完一轮,产出正文、用量与耗时", async () => {
    const opts = options({ faux: SAY_HELLO })
    const output = await runEval(opts)

    expect(output.faux).toBe(true)
    expect(output.providerID).toBe("deepseek")
    expect(output.modelID).toBe("deepseek-v4-flash-vision-exp")
    // 档位不填 → 落到 kernel 的 DEFAULT_THINKING_LEVEL(max),不是关掉。
    expect(output.thinking).toBe("max")
    expect(output.result.text).toContain("空工程")
    expect(output.result.errors).toEqual([])
    expect(output.result.stopReason).toBeUndefined()
    expect(output.wallMs).toBeGreaterThan(0)
    // 会话真的落盘了 —— 跑批器把 sessionsRoot 收走就能在桌面端回放。
    expect(output.result.sessionID).toMatch(/^[0-9a-f-]{36}$/)
    expect(existsSync(opts.sessionsRoot)).toBe(true)
  }, 60_000)

  test("工具真的会被执行(write 落到工作目录)", async () => {
    const cwd = tempDir("yoma-eval-ws-")
    const script: FauxScript = [
      [{ tool: "write", input: { path: path.join(cwd, "hello.txt"), content: "from eval\n" } }],
      [{ text: "写好了。" }],
    ]
    const output = await runEval(options({ cwd, faux: script }))

    expect(readFileSync(path.join(cwd, "hello.txt"), "utf8")).toBe("from eval\n")
    expect(output.result.toolCalls.map((c) => c.tool)).toContain("write")
    expect(output.result.toolCalls.every((c) => c.status !== "error")).toBe(true)
  }, 60_000)

  test("事件流落成 JSONL,含工具事件、不含逐 token 的 delta", async () => {
    const cwd = tempDir("yoma-eval-ws-")
    const eventsPath = path.join(cwd, "logs", "events.jsonl")
    const script: FauxScript = [[{ tool: "read", input: { path: path.join(cwd, "nope.txt") } }], [{ text: "读不到。" }]]

    await runEval(options({ cwd, faux: script, eventsPath }))

    const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    const events = lines.map((line) => JSON.parse(line) as { type: string })
    // delta 是逐 token 的增量流,不落 —— 落了会把文件撑爆。
    expect(events.some((e) => e.type === "message.part.delta")).toBe(false)
    expect(events.some((e) => e.type === "message.updated")).toBe(true)
    expect(events.some((e) => e.type === "message.part.updated")).toBe(true)
  }, 60_000)

  test("事件流的目录不存在时自动建", async () => {
    const cwd = tempDir("yoma-eval-ws-")
    const eventsPath = path.join(cwd, "a", "b", "c", "events.jsonl")
    await runEval(options({ cwd, faux: SAY_HELLO, eventsPath }))
    expect(existsSync(eventsPath)).toBe(true)
  }, 60_000)
})

describe("runEval · 配置错误", () => {
  test("instruction 为空当场报,不进内核", async () => {
    await expect(runEval(options({ instruction: "   ", faux: SAY_HELLO }))).rejects.toThrow(EvalConfigError)
  })

  test("没有凭据时报 EvalConfigError(而不是跑到一半炸)", async () => {
    const configDir = tempDir("yoma-eval-config-")
    // 空 auth.json:pi-ai 的 provider 仍可能从环境变量拿到 key(开发机上常有),
    // 所以这里只断言"要么成功解析、要么给的是可诊断的配置错误",不断言一定失败。
    writeFileSync(path.join(configDir, "auth.json"), "{}")
    const promise = runEval(
      options({
        configDir,
        sessionsRoot: path.join(configDir, "sessions"),
        stateDir: path.join(configDir, "state"),
        modelID: "definitely-not-a-model",
      }),
    )
    await expect(promise).rejects.toThrow(EvalConfigError)
  }, 60_000)
})

describe("faux 的定位", () => {
  test("faux 的 cost 恒为 0 —— 所以它只能冒烟,不能当评测夹具", async () => {
    const output = await runEval(options({ faux: SAY_HELLO }))
    // pi-ai 的 faux provider 把 cost 硬写成 0、token 按 length/4 估。真实评测必须走真模型,
    // 这条断言是把"别拿 faux 的数字当成绩"钉在测试里。
    expect(output.result.usage.cost).toBe(0)
  }, 60_000)
})
