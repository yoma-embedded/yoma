import { describe, expect, test } from "vitest"
import type { LogTailView } from "@yoma-desktop/kernel"
import { LOG_TAIL_LINES, type LogLine } from "./log-lines"
import { capLogLines, LIVE_HOLD_FACTOR, liveCursorStale, liveLogPath, mergeLiveTail, numberLogLines } from "./log-live"

const FILE = "D:\\fw\\BK64\\.yoma\\logs\\hw-20260924-101112345.log"
/** 一次回复:序号 [nextSeq - lines.length, nextSeq) 的那几行。 */
const view = (lines: string[], nextSeq: number, extra: Partial<LogTailView> = {}): LogTailView => ({
  running: true,
  source: "rtt STM32G473RC via J-Link SWD 4000 kHz",
  file: FILE,
  writable: true,
  nextSeq,
  lost: 0,
  lines,
  ...extra,
})
const texts = (lines: readonly LogLine[]) => lines.map((line) => `${line.no}:${line.text}`)

describe("numberLogLines", () => {
  test("行号 = 前面的行数 + 下标 + 1,级别照常认", () => {
    const lines = numberLogLines(["[+0.1] [4] E: [SAFETY] undervoltage", "[+0.2] ok"], 41)
    expect(lines).toEqual([
      { no: 42, text: "[+0.1] [4] E: [SAFETY] undervoltage", level: "error" },
      { no: 43, text: "[+0.2] ok", level: "info" },
    ])
  })
})

describe("mergeLiveTail", () => {
  test("没有在跑的采集:退回读盘", () => {
    expect(mergeLiveTail([], undefined, view(["a"], 1, { running: false }))).toEqual({ kind: "idle" })
    expect(mergeLiveTail([], undefined, { running: false, writable: false, nextSeq: 0, lost: 0, lines: [] })).toEqual({
      kind: "idle",
    })
  })

  test("不带游标:整窗替换,行号是文件里的行号,clipped 是窗口前面的行数", () => {
    const merged = mergeLiveTail([], undefined, view(["x", "y"], 10))
    expect(merged.kind).toBe("lines")
    if (merged.kind !== "lines") return
    expect(texts(merged.lines)).toEqual(["9:x", "10:y"])
    expect(merged.clipped).toBe(8)
    expect(merged.changed).toBe(true)
    expect(merged.cursor).toEqual({ file: FILE, since: 10 })
  })

  test("带着游标:新行接到后面;没有新行时原样返回同一个数组", () => {
    const first = mergeLiveTail([], undefined, view(["a", "b"], 2))
    if (first.kind !== "lines") throw new Error(first.kind)
    const second = mergeLiveTail(first.lines, first.cursor, view(["c"], 3))
    if (second.kind !== "lines") throw new Error(second.kind)
    expect(texts(second.lines)).toEqual(["1:a", "2:b", "3:c"])
    // 前面的行对象原样复用(`<Index>` 不重画它们)
    expect(second.lines[0]).toBe(first.lines[0])
    expect(second.cursor.since).toBe(3)

    const idle = mergeLiveTail(second.lines, second.cursor, view([], 3))
    if (idle.kind !== "lines") throw new Error(idle.kind)
    expect(idle.changed).toBe(false)
    expect(idle.lines).toBe(second.lines)
  })

  test("中间丢了行(环形缓冲溢出):不跨洞拼接,这一窗口从新来的行开始", () => {
    const first = mergeLiveTail([], undefined, view(["a", "b"], 2))
    if (first.kind !== "lines") throw new Error(first.kind)
    const gap = mergeLiveTail(first.lines, first.cursor, view(["z"], 900, { lost: 897 }))
    if (gap.kind !== "lines") throw new Error(gap.kind)
    expect(texts(gap.lines)).toEqual(["900:z"])
    expect(gap.clipped).toBe(899)
  })

  test("面板上的最后一行和新来的第一行对不上(读盘换过):也不硬接", () => {
    const shown = numberLogLines(["a", "b", "c"], 0)
    const merged = mergeLiveTail(shown, { file: FILE, since: 2 }, view(["d"], 5))
    if (merged.kind !== "lines") throw new Error(merged.kind)
    expect(texts(merged.lines)).toEqual(["5:d"])
  })

  test("换了一次采集(文件变了 / 序号倒退):要求不带 since 重拉", () => {
    expect(mergeLiveTail([], { file: FILE, since: 50 }, view(["n"], 51, { file: "D:\\other.log" }))).toEqual({
      kind: "reset",
    })
    expect(mergeLiveTail([], { file: FILE, since: 50 }, view(["n"], 3))).toEqual({ kind: "reset" })
    expect(liveCursorStale(undefined, view([], 0))).toBe(false)
    expect(liveCursorStale({ file: FILE, since: 3 }, view([], 3))).toBe(false)
  })

  test("整窗替换但内容与面板上的一行不差(刚从读盘切过来):留着旧数组", () => {
    const disk = numberLogLines(["a", "b", "c"], 0)
    const merged = mergeLiveTail(disk, undefined, view(["a", "b", "c"], 3))
    if (merged.kind !== "lines") throw new Error(merged.kind)
    expect(merged.changed).toBe(false)
    expect(merged.lines).toBe(disk)
    expect(merged.cursor).toEqual({ file: FILE, since: 3 })
  })

  test("最多留 LOG_TAIL_LINES 行,从头丢", () => {
    const first = mergeLiveTail(
      [],
      undefined,
      view(
        Array.from({ length: LOG_TAIL_LINES }, (_, i) => `l${i}`),
        LOG_TAIL_LINES,
      ),
    )
    if (first.kind !== "lines") throw new Error(first.kind)
    const more = mergeLiveTail(first.lines, first.cursor, view(["n1", "n2"], LOG_TAIL_LINES + 2))
    if (more.kind !== "lines") throw new Error(more.kind)
    expect(more.lines).toHaveLength(LOG_TAIL_LINES)
    expect(more.lines[0].no).toBe(3)
    expect(more.lines.at(-1)).toMatchObject({ no: LOG_TAIL_LINES + 2, text: "n2" })
    expect(more.clipped).toBe(2)
  })

  test("没在跟随(hold):窗口满了也只往后接,已有的行一个下标都不挪;跟随回来下一拍才砍回去", () => {
    const full = mergeLiveTail(
      [],
      undefined,
      view(
        Array.from({ length: LOG_TAIL_LINES }, (_, i) => `l${i}`),
        LOG_TAIL_LINES,
      ),
    )
    if (full.kind !== "lines") throw new Error(full.kind)
    const held = mergeLiveTail(full.lines, full.cursor, view(["n1", "n2"], LOG_TAIL_LINES + 2), { hold: true })
    if (held.kind !== "lines") throw new Error(held.kind)
    // `<Index>` 按下标复用节点:每个下标上还是同一个行对象,用户选中的那段不会被换成别的字
    expect(held.lines).toHaveLength(LOG_TAIL_LINES + 2)
    for (const i of [0, 1, 1000, LOG_TAIL_LINES - 1]) expect(held.lines[i]).toBe(full.lines[i])
    expect(held.lines.at(-1)).toMatchObject({ no: LOG_TAIL_LINES + 2, text: "n2" })
    expect(held.clipped).toBe(0)

    const resumed = mergeLiveTail(held.lines, held.cursor, view(["n3"], LOG_TAIL_LINES + 3))
    if (resumed.kind !== "lines") throw new Error(resumed.kind)
    expect(resumed.lines).toHaveLength(LOG_TAIL_LINES)
    expect(resumed.lines[0].no).toBe(4)
  })

  test("hold 也有上限:停在那儿翻太久,超过 LIVE_HOLD_FACTOR 倍才又开始从头丢", () => {
    const cap = LIVE_HOLD_FACTOR * LOG_TAIL_LINES
    const shown = numberLogLines(
      Array.from({ length: cap }, (_, i) => `l${i}`),
      0,
    )
    const merged = mergeLiveTail(shown, { file: FILE, since: cap }, view(["more"], cap + 1), { hold: true })
    if (merged.kind !== "lines") throw new Error(merged.kind)
    expect(merged.lines).toHaveLength(cap)
    expect(merged.lines[0].no).toBe(2)
  })

  test("采集停了:接得上游标的最后接一次(停的那一刻写下的原因),接不上的照旧 idle", () => {
    const first = mergeLiveTail([], undefined, view(["a", "b"], 2))
    if (first.kind !== "lines") throw new Error(first.kind)
    const stopped = mergeLiveTail(
      first.lines,
      first.cursor,
      view(["[+9.1] ! ERROR: RTT disconnected"], 3, { running: false, writable: false }),
    )
    if (stopped.kind !== "lines") throw new Error(stopped.kind)
    expect(texts(stopped.lines)).toEqual(["1:a", "2:b", "3:[+9.1] ! ERROR: RTT disconnected"])
    expect(stopped.lines[0]).toBe(first.lines[0])
    // 没有游标、或者换过一次采集(文件不同):没得接,退回读盘
    expect(mergeLiveTail(first.lines, undefined, view(["x"], 3, { running: false }))).toEqual({ kind: "idle" })
    expect(mergeLiveTail(first.lines, first.cursor, view(["x"], 3, { running: false, file: "D:\\other.log" }))).toEqual(
      { kind: "idle" },
    )
  })
})

describe("capLogLines", () => {
  test("按字节砍,但最后一行永远留着;什么都没砍时原样返回", () => {
    const lines = numberLogLines(["a".repeat(10), "b".repeat(10), "c".repeat(10)], 0)
    expect(capLogLines(lines, 10, 1000)).toBe(lines)
    expect(texts(capLogLines(lines, 2, 1000))).toEqual([`2:${"b".repeat(10)}`, `3:${"c".repeat(10)}`])
    expect(texts(capLogLines(lines, 10, 23))).toEqual([`2:${"b".repeat(10)}`, `3:${"c".repeat(10)}`])
    expect(texts(capLogLines(lines, 10, 3))).toEqual([`3:${"c".repeat(10)}`])
  })
})

describe("liveLogPath", () => {
  test("工程里的日志给相对路径(可以喂回 file.read),Windows 不分大小写", () => {
    expect(liveLogPath("D:\\fw\\BK64", FILE)).toEqual({
      name: "hw-20260924-101112345.log",
      path: ".yoma/logs/hw-20260924-101112345.log",
    })
    expect(liveLogPath("d:/FW/bk64/", FILE).path).toBe(".yoma/logs/hw-20260924-101112345.log")
    expect(liveLogPath("/work/a", "/work/a/.yoma/logs/hw-1.log")).toEqual({
      name: "hw-1.log",
      path: ".yoma/logs/hw-1.log",
    })
  })

  test("不在工程目录下时原样给绝对路径", () => {
    expect(liveLogPath("/work/a", "/work/ab/.yoma/logs/hw-1.log")).toEqual({
      name: "hw-1.log",
      path: "/work/ab/.yoma/logs/hw-1.log",
    })
  })
})
