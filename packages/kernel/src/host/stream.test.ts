import { describe, expect, test } from "bun:test"
import { StreamSink } from "./stream.ts"
import type { KernelEvent } from "../protocol.ts"
import type { Part } from "../types.ts"

function textPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: "ses_1", messageID, type: "text", text }
}

function delta(partID: string, messageID: string, d: string): KernelEvent {
  return { type: "message.part.delta", sessionID: "ses_1", messageID, partID, field: "text", delta: d }
}

function progress(id: string, bytes: number): KernelEvent {
  return { type: "toolchain.install", id, packageId: `${id}-pkg`, version: "1.0.0", phase: "download", bytes, total: 100 }
}

function sink(intervalMs = 0) {
  const batches: KernelEvent[][] = []
  return { sink: new StreamSink({ flush: (events) => batches.push(events), intervalMs }), batches }
}

describe("StreamSink", () => {
  test("连续 delta 拼成一条", () => {
    const { sink: s, batches } = sink()
    s.push([delta("p1", "m1", "从"), delta("p1", "m1", "前"), delta("p1", "m1", "有")])
    s.flushNow()
    expect(batches[0]!.length).toBe(1)
    expect((batches[0]![0] as { delta: string }).delta).toBe("从前有")
  })

  test("不同 part 的 delta 不会被合并", () => {
    const { sink: s, batches } = sink()
    s.push([delta("p1", "m1", "a"), delta("p2", "m1", "b"), delta("p1", "m1", "c")])
    s.flushNow()
    expect(batches[0]!.length).toBe(3)
  })

  test("同一 part 的连续快照只留最后一条", () => {
    const { sink: s, batches } = sink()
    s.push([
      { type: "message.part.updated", part: textPart("p1", "m1", "a") },
      { type: "message.part.updated", part: textPart("p1", "m1", "ab") },
      { type: "message.part.updated", part: textPart("p1", "m1", "abc") },
    ])
    s.flushNow()
    expect(batches[0]!.length).toBe(1)
    expect((batches[0]![0] as { part: { text: string } }).part.text).toBe("abc")
  })

  test("合并不会把 part 快照排到它的 delta 后面", () => {
    // 这条是重点:一旦按 key 分桶再拼接,顺序就毁了,而前端会静默丢弃未知 part 的 delta。
    const { sink: s, batches } = sink()
    s.push([
      { type: "message.part.updated", part: textPart("p1", "m1", "") },
      delta("p1", "m1", "a"),
      { type: "message.part.updated", part: textPart("p2", "m1", "") },
      delta("p1", "m1", "b"),
    ])
    s.flushNow()
    const types = batches[0]!.map((e) => e.type)
    expect(types).toEqual([
      "message.part.updated",
      "message.part.delta",
      "message.part.updated",
      "message.part.delta",
    ])
  })

  test("父 message.updated 始终排在它的 part 之前", () => {
    const { sink: s, batches } = sink()
    const message = { id: "m1", sessionID: "ses_1", role: "user" as const, time: { created: 1 }, model: { providerID: "p", modelID: "m" } }
    s.push([
      { type: "message.updated", message },
      { type: "message.part.updated", part: textPart("p1", "m1", "hi") },
    ])
    s.flushNow()
    expect(batches[0]!.map((e) => e.type)).toEqual(["message.updated", "message.part.updated"])
  })

  test("超过上限立刻推,不攒成一个巨批", () => {
    const batches: KernelEvent[][] = []
    const s = new StreamSink({ flush: (e) => batches.push(e), intervalMs: 10_000, maxBatch: 4 })
    for (let i = 0; i < 4; i += 1) s.push(delta(`p${i}`, "m1", "x"))
    expect(batches.length).toBe(1)
    expect(batches[0]!.length).toBe(4)
  })

  // ─── 工具链安装进度 ────────────────────────────────────────────────────────
  //
  // download 阶段每个 chunk 一条,一次 300 MB 的下载能发出上万条;折叠规则与 part
  // 快照同一条:只看队尾、只折叠同一个 id 的相邻两条,绝不跨类型重排。

  test("同一个工具的相邻安装进度只留最后一条", () => {
    const { sink: s, batches } = sink()
    s.push([progress("arm-gcc", 10), progress("arm-gcc", 20), progress("arm-gcc", 30)])
    s.flushNow()
    expect(batches[0]!.length).toBe(1)
    expect(batches[0]![0]).toMatchObject({ type: "toolchain.install", id: "arm-gcc", bytes: 30 })
  })

  test("不同工具的进度不会被合并(并行装两个时两条进度行各走各的)", () => {
    const { sink: s, batches } = sink()
    s.push([progress("arm-gcc", 10), progress("cmake", 5), progress("arm-gcc", 20)])
    s.flushNow()
    expect(batches[0]!.length).toBe(3)
    expect(batches[0]!.map((e) => (e as { bytes?: number }).bytes)).toEqual([10, 5, 20])
  })

  test("中间隔了别的事件就不折叠,顺序原样保留", () => {
    const { sink: s, batches } = sink()
    const message = {
      id: "m1",
      sessionID: "ses_1",
      role: "user" as const,
      time: { created: 1 },
      model: { providerID: "p", modelID: "m" },
    }
    s.push([progress("arm-gcc", 10), { type: "message.updated", message }, progress("arm-gcc", 20)])
    s.flushNow()
    expect(batches[0]!.map((e) => e.type)).toEqual(["toolchain.install", "message.updated", "toolchain.install"])
    expect((batches[0]![0] as { bytes?: number }).bytes).toBe(10)
    expect((batches[0]![2] as { bytes?: number }).bytes).toBe(20)
  })

  test("close 之后不再接收事件", () => {
    const { sink: s, batches } = sink()
    s.push(delta("p1", "m1", "a"))
    s.close()
    s.push(delta("p1", "m1", "b"))
    s.flushNow()
    expect(batches.length).toBe(1)
  })
})
