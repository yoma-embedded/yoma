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

  test("close 之后不再接收事件", () => {
    const { sink: s, batches } = sink()
    s.push(delta("p1", "m1", "a"))
    s.close()
    s.push(delta("p1", "m1", "b"))
    s.flushNow()
    expect(batches.length).toBe(1)
  })
})
