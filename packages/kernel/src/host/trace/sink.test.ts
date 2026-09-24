/**
 * 轨迹落盘:一行一个 JSON、攒批、轮转、关的时候冲干净、写失败不抛、环境变量开关。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createTrace, NOOP_TRACE, rotatedName, traceFileFromEnv } from "./sink.ts"

const dirs: string[] = []
function tempFile(name = "trace.jsonl") {
  const dir = mkdtempSync(path.join(tmpdir(), "yoma-trace-"))
  dirs.push(dir)
  return path.join(dir, "logs", name)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function lines(file: string) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("createTrace", () => {
  it("一行一个 JSON:t 与 ev 在前、字段跟着;undefined 的字段不写;超长字符串截断;父目录自己建", async () => {
    let now = 100
    const file = tempFile()
    const trace = createTrace({ file, now: () => now++ })
    expect(trace.enabled).toBe(true)
    trace.write("run.start", { s: "S1", run: "R1", skipped: undefined })
    trace.write("tool.start", { summary: "x".repeat(2000) })
    await trace.flush()
    const [first, second] = lines(file)
    expect(first).toEqual({ t: 100, ev: "run.start", s: "S1", run: "R1" })
    expect(Object.keys(first!)).toEqual(["t", "ev", "s", "run"])
    expect((second!.summary as string).length).toBe(501)
    expect((second!.summary as string).endsWith("…")).toBe(true)
  })

  it("攒批:间隔内的多行一次写出、顺序不乱;计时器到了自己写", async () => {
    vi.useFakeTimers()
    try {
      const file = tempFile()
      const trace = createTrace({ file, flushMs: 250 })
      for (let i = 0; i < 5; i++) trace.write("e", { i })
      expect(existsSync(file)).toBe(false)
      await vi.advanceTimersByTimeAsync(250)
      await trace.flush()
      expect(lines(file).map((line) => line.i)).toEqual([0, 1, 2, 3, 4])
    } finally {
      vi.useRealTimers()
    }
  })

  it("超过 maxBytes:当前文件改名成 .1.jsonl,新的接着写", async () => {
    const file = tempFile()
    const trace = createTrace({ file, maxBytes: 200 })
    for (let i = 0; i < 4; i++) trace.write("pad", { i, text: "y".repeat(40) })
    await trace.flush()
    for (let i = 4; i < 8; i++) trace.write("pad", { i, text: "y".repeat(40) })
    await trace.flush()
    const old = rotatedName(file)
    expect(old.endsWith(`${path.sep}trace.1.jsonl`)).toBe(true)
    expect(lines(old).map((line) => line.i)).toEqual([0, 1, 2, 3])
    expect(lines(file).map((line) => line.i)).toEqual([4, 5, 6, 7])
  })

  it("close:等在飞的写完、剩下的同步冲掉;之后的 write 不再落盘", async () => {
    const file = tempFile()
    const trace = createTrace({ file, flushMs: 60_000 })
    trace.write("a")
    void trace.flush()
    trace.write("b")
    await trace.close()
    expect(lines(file).map((line) => line.ev)).toEqual(["a", "b"])
    trace.write("c")
    await trace.flush()
    expect(lines(file).map((line) => line.ev)).toEqual(["a", "b"])
  })

  it("写不了(父路径是个文件)时停写、stderr 说一句,绝不抛回调用方", async () => {
    const file = tempFile()
    const blocker = path.dirname(file)
    writeFileSync(path.join(path.dirname(blocker), "block"), "x")
    const blocked = path.join(path.dirname(blocker), "block", "trace.jsonl")
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const trace = createTrace({ file: blocked })
    trace.write("a")
    await expect(trace.flush()).resolves.toBeUndefined()
    trace.write("b")
    await expect(trace.close()).resolves.toBeUndefined()
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0]![0])).toContain("yoma trace disabled")
  })

  it("没给文件就是关着的轨迹", async () => {
    const trace = createTrace({})
    expect(trace).toBe(NOOP_TRACE)
    expect(trace.enabled).toBe(false)
    trace.write("anything")
    await trace.close()
  })
})

describe("traceFileFromEnv", () => {
  it("YOMA_TRACE 关掉 > YOMA_TRACE_FILE > 宿主给的缺省", () => {
    expect(traceFileFromEnv({}, "/logs/trace.jsonl")).toBe("/logs/trace.jsonl")
    expect(traceFileFromEnv({ YOMA_TRACE_FILE: "/x/t.jsonl" }, "/logs/trace.jsonl")).toBe("/x/t.jsonl")
    for (const off of ["off", "0", "false", "no", "OFF"]) {
      expect(traceFileFromEnv({ YOMA_TRACE: off, YOMA_TRACE_FILE: "/x/t.jsonl" }, "/logs/trace.jsonl")).toBeUndefined()
    }
    expect(traceFileFromEnv({})).toBeUndefined()
  })
})
