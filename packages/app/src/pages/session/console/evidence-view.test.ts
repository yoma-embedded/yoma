/**
 * 提示点在 v2-console 这个布局里的那半句:**"开着"等于什么。**
 *
 * 这一条错了的表现最讨厌:面板明明开着、用户正看着,格子上却挂着一个永远熄不掉的点
 * (或者反过来 —— 控制台收着时证据不积累,提示点永远不亮)。两种都不报错。
 */
import { beforeEach, describe, expect, test } from "vitest"
import { EMPTY_BENCH_STATUS, type BenchStatus, type InstrumentId } from "../bench/bench-status"
import { EMPTY_BENCH_DISK, type BenchDisk, type InstrumentContext } from "../bench/instruments"
import { debug as dock } from "../debug/debug-data"
import { consoleUI } from "./console-state"
import { activeOnSurface, dotsBesideAttention, openInstruments } from "./evidence-view"

function ctx(
  input: { status?: Partial<BenchStatus>; disk?: Partial<BenchDisk>; pinned?: InstrumentId[] } = {},
): InstrumentContext {
  return {
    status: { ...EMPTY_BENCH_STATUS, ...input.status } as BenchStatus,
    disk: { ...EMPTY_BENCH_DISK, ...input.disk },
    pinned: new Set(input.pinned ?? []),
  }
}

/** 演示会话的形状:日志与调试器都碰过,磁盘上示波器与 LA 各有一份采集。 */
const busy = () =>
  ctx({
    status: {
      used: new Set<InstrumentId>(["log", "gdb"]),
      gdb: { state: "halted", epoch: 1, stops: [], at: 1 },
    },
    disk: { scopeCaptures: 1, laCaptures: 1 },
  })

describe("回落规则只有一份", () => {
  test("记着的那台还在就用它", () => {
    expect(activeOnSurface("wave", busy(), "la")).toBe("la")
    expect(activeOnSurface("wave", busy(), "gdb")).toBe("gdb")
    expect(activeOnSurface("text", busy(), "log")).toBe("log")
  })

  test("文本流回落到日志;波形没有记录就不打开示波器", () => {
    // 这个会话没连过 gdb:文本流只剩日志。
    expect(activeOnSurface("text", ctx(), "gdb")).toBe("log")
    // 一台都没有时谁都不是。有示波器数据、但没人点过它,同样不打开。
    expect(activeOnSurface("wave", ctx(), "la")).toBeUndefined()
    expect(activeOnSurface("wave", busy(), undefined)).toBeUndefined()
  })
})

describe("此刻用户正看着哪几台", () => {
  beforeEach(() => {
    localStorage.clear()
    consoleUI.reset()
    consoleUI.close()
    dock.close()
    dock.setMode("debug")
  })

  test("控制台收着、右栏收着 = 一台都没开着,于是证据一直积累", () => {
    expect([...openInstruments(busy())]).toEqual([])
  })

  test("控制台开着 = 它停着的那一页算开着,另一页不算", () => {
    consoleUI.open("log")
    expect([...openInstruments(busy())]).toEqual(["log"])
    consoleUI.setTab("log")
    expect([...openInstruments(busy())]).toEqual(["log"])
  })

  test("调试器在右栏:展开调试档并选中它才算开着", () => {
    dock.open()
    consoleUI.setRail("gdb")
    expect([...openInstruments(busy())]).toEqual(["gdb"])
  })

  test("右栏展开且停在「调试」档 = 页签选中的那一台算开着", () => {
    dock.open()
    consoleUI.setRail("la")
    expect([...openInstruments(busy())]).toEqual(["la"])
  })

  test("右栏展开但切去了文件树 —— 波形那台没在屏幕上,不算开着", () => {
    dock.open()
    dock.setMode("file")
    consoleUI.setRail("la")
    expect([...openInstruments(busy())]).toEqual([])
  })

  test("两边都开着 = 两台(底部一台、右栏一台),这是这个布局的上限", () => {
    consoleUI.open("log")
    dock.open()
    consoleUI.setRail("scope")
    expect([...openInstruments(busy())].sort()).toEqual(["log", "scope"])
  })

  test("右栏记着的那台在这个会话里不露面时,不拿另一台顶上", () => {
    dock.open()
    consoleUI.setRail("scope")
    // 只有 LA 有采集。示波器不在场,右栏是空态,不改画逻辑分析仪。
    expect([...openInstruments(ctx({ disk: { laCaptures: 1 } }))]).toEqual([])
  })

  test("右栏没记过谁时波形一台都没开 —— 打开日志不把示波器算成正在看", () => {
    dock.open()
    expect([...openInstruments(busy())]).toEqual([])
  })
})

describe("黄灯与提示点撞在一格上", () => {
  const set = (...ids: InstrumentId[]) => new Set<InstrumentId>(ids)

  test("那一格让给黄灯:黄灯还带着条数,两个记号挤一起没人分得清", () => {
    expect([...dotsBesideAttention(set("log", "gdb"), set("log"))]).toEqual(["gdb"])
  })

  test("没有黄灯时原样给出去,而且不白造一个新集合", () => {
    const unseen = set("log", "gdb")
    expect(dotsBesideAttention(unseen, undefined)).toBe(unseen)
    expect(dotsBesideAttention(unseen, set())).toBe(unseen)
    // 黄灯那一格本来就没有点 —— 没东西要删,也不必复制。
    expect(dotsBesideAttention(unseen, set("scope"))).toBe(unseen)
  })

  test("不写死 `log`:哪一格挂了黄灯,哪一格就让位", () => {
    expect([...dotsBesideAttention(set("scope", "la"), set("scope"))]).toEqual(["la"])
  })

  test("不改调用方传进来的那一份 —— 它是 memo 的返回值,别人还在读", () => {
    const unseen = set("log", "gdb")
    dotsBesideAttention(unseen, set("log"))
    expect([...unseen].sort()).toEqual(["gdb", "log"])
  })
})
