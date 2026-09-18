import { describe, expect, test } from "vitest"
import { fixture } from "./fixtures/hw-parts"
import { describeLog, matchOffset, skippedLines } from "./log-card"

describe("describeLog · 真实形状", () => {
  test("start:采集器起来了,来源与落盘文件都读得到", () => {
    const part = fixture("log", "start")
    const card = describeLog(part.input, part.metadata, part.output)!
    expect(card.action).toBe("start")
    expect(card.capturing).toBe(true)
    expect(card.source).toBe("sh tools/uart-sim.sh")
    expect(card.file).toBe("/work/f405-motor-ctrl/.yoma/logs/hw-20260918-011554425.log")
    // start 的输出全是说明句,一行日志都没有
    expect(card.lines).toEqual([])
    expect(card.notes[0]).toContain("Capturing sh tools/uart-sim.sh")
  })

  test("wait:命中行被标出来,时间戳单独成一列", () => {
    const part = fixture("log", "wait")
    const card = describeLog(part.input, part.metadata, part.output)!
    expect(card.matched).toBe(true)
    expect(matchOffset(card.notes)).toBe("+1.710s")
    expect(skippedLines(card.notes)).toBe(5)

    const hit = card.lines.find((line) => line.hit)
    expect(hit).toBeTruthy()
    // 工具自己在文本里标的 `← match` 记号不该留在正文里
    expect(hit!.text).toBe("*** HARDFAULT (stage 6) ***")
    expect(hit!.lead).toBe("[+1.710]")
    // HardFault 是事故词:级别是 error(与 LogPanel 同一份 classifyLogLine)
    expect(hit!.level).toBe("error")
    // 其余行不是事故
    expect(card.lines.find((line) => line.text.includes("iq_ref"))?.level).toBe("info")
  })

  test("wait:汇总行进 footer 而不是当成一行日志", () => {
    const part = fixture("log", "wait")
    const card = describeLog(part.input, part.metadata, part.output)!
    expect(card.footer).toMatch(/^cursor: 9 \| source: running \|/)
    expect(card.lines.some((line) => line.text.startsWith("cursor:"))).toBe(false)
    expect(card.cursor).toBe(9)
    expect(card.totalLines).toBe(9)
  })

  test("read:没有新行时不假装有节选", () => {
    const part = fixture("log", "read")
    const card = describeLog(part.input, part.metadata, part.output)!
    expect(card.lines).toEqual([])
    expect(card.notes).toContain("no new lines since seq 18")
  })

  test("stop:采集停了,行数留着", () => {
    const part = fixture("log", "stop")
    const card = describeLog(part.input, part.metadata, part.output)!
    expect(card.capturing).toBe(false)
    expect(card.totalLines).toBe(18)
    expect(card.exitCode).toBe(null)
  })
})

describe("describeLog · 边界", () => {
  test("节选有上限:一次喷吐不许把整张卡撑开", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `[+${i}.000] line ${i}`).join("\n")
    const card = describeLog({ action: "read" }, { action: "read", running: true }, lines)!
    expect(card.lines.length).toBe(60)
    // 留的是**尾巴**:最新的那几行才是现状
    expect(card.lines[card.lines.length - 1].text).toBe("line 399")
  })

  test("ports 的表不当日志行上色", () => {
    const card = describeLog(
      { action: "ports" },
      { action: "ports" },
      "2 serial ports:\n/dev/cu.usbmodem1103  STLink VCP\n/dev/cu.Bluetooth-Incoming-Port",
    )!
    expect(card.lines).toEqual([])
    expect(card.notes.length).toBe(3)
  })

  test("形状不对 → undefined(回落通用卡)", () => {
    expect(describeLog({}, {}, "some text")).toBeUndefined()
    expect(describeLog(undefined, undefined, undefined)).toBeUndefined()
    expect(describeLog({ action: "nope" }, { action: 7 }, "")).toBeUndefined()
  })

  test("metadata 里塞垃圾也不抛", () => {
    expect(() =>
      describeLog({ action: "wait" }, { action: "wait", running: "yes", cursor: "9" } as never, undefined),
    ).not.toThrow()
    const card = describeLog({ action: "wait" }, { action: "wait", running: "yes" } as never, undefined)!
    expect(card.capturing).toBe(false)
    expect(card.cursor).toBeUndefined()
  })
})
