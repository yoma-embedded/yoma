import { beforeEach, describe, expect, test } from "vitest"
import { CONSOLE_MIN_HEIGHT, CONSOLE_STATE_KEY, consoleUI, readConsoleState } from "./console-state"
import { EMPTY_BENCH_STATUS, type BenchStatus, type InstrumentId } from "../bench/bench-status"
import {
  EMPTY_BENCH_DISK,
  INSTRUMENTS,
  hiddenOnSurface,
  visibleOnSurface,
  type BenchDisk,
  type InstrumentContext,
} from "../bench/instruments"

function ctx(
  input: { status?: Partial<BenchStatus>; disk?: Partial<BenchDisk>; pinned?: InstrumentId[] } = {},
): InstrumentContext {
  return {
    status: { ...EMPTY_BENCH_STATUS, ...input.status } as BenchStatus,
    disk: { ...EMPTY_BENCH_DISK, ...input.disk },
    pinned: new Set(input.pinned ?? []),
  }
}
const ids = (list: { id: string }[]) => list.map((item) => item.id)

describe("按数据的形状分家", () => {
  test("每台仪器都表了态,文本流两台在前、波形两台在后", () => {
    expect(INSTRUMENTS.map((instrument) => [instrument.id, instrument.surface])).toEqual([
      ["log", "text"],
      ["gdb", "text"],
      ["scope", "wave"],
      ["la", "wave"],
    ])
  })

  test("底部控制台拿文本流,右栏拿波形 —— 两边都还守着「该不该露面」那条规则", () => {
    // 什么都没发生:控制台只有核心的日志,右栏一台都没有(= 空态)。
    expect(ids(visibleOnSurface("text", ctx()))).toEqual(["log"])
    expect(ids(visibleOnSurface("wave", ctx()))).toEqual([])
    expect(ids(hiddenOnSurface("text", ctx()))).toEqual(["gdb"])
    expect(ids(hiddenOnSurface("wave", ctx()))).toEqual(["scope", "la"])
  })

  test("碰过 / 有数据 / 钉住,各自把仪器送进它该去的那一边", () => {
    const used = ctx({ status: { gdb: { state: "halted", epoch: 1, stops: [], at: 0 } } })
    expect(ids(visibleOnSurface("text", used))).toEqual(["log", "gdb"])
    expect(ids(visibleOnSurface("wave", used))).toEqual([])

    const onDisk = ctx({ disk: { scopeCaptures: 2 } })
    expect(ids(visibleOnSurface("wave", onDisk))).toEqual(["scope"])

    const pinned = ctx({ pinned: ["la"] })
    expect(ids(visibleOnSurface("wave", pinned))).toEqual(["la"])
    // 钉住波形那台不会把它塞进底部控制台。
    expect(ids(visibleOnSurface("text", pinned))).toEqual(["log"])
  })

  test("紧凑装配只给文本流那两台配了正文,波形那两台退回完整面板", () => {
    for (const instrument of INSTRUMENTS) {
      if (instrument.surface === "text") expect(typeof instrument.compact).toBe("function")
      else expect(instrument.compact).toBeUndefined()
    }
    // 过滤框 / 跟随开关只有日志有 —— 页签行上那一格不该给没有控件的仪器留空位。
    expect(typeof INSTRUMENTS.find((x) => x.id === "log")!.controls).toBe("function")
    expect(INSTRUMENTS.find((x) => x.id === "gdb")!.controls).toBeUndefined()
  })

  test("页签行的读数按仪器各说各的,而且是翻译过的", () => {
    const t = (key: string) => `«${key}»`
    const log = INSTRUMENTS.find((x) => x.id === "log")!
    expect(log.headline!(ctx(), t)).toBeUndefined()
    expect(
      log.headline!(
        ctx({
          status: {
            log: {
              capturing: true,
              source: "serial /dev/cu.usbmodem1103 @ 115200 8N1",
              kind: "serial",
              port: "/dev/cu.usbmodem1103",
              baud: 115200,
              totalLines: 0,
              dropped: 0,
              at: 0,
            },
          },
        }),
        t,
      ),
    ).toBe("«session.bench.state.capturing» cu.usbmodem1103 115200")

    const gdb = INSTRUMENTS.find((x) => x.id === "gdb")!
    expect(
      gdb.headline!(
        ctx({
          status: {
            gdb: {
              state: "halted",
              location: "Core/Src/main.c:136",
              connection: "localhost:62169",
              epoch: 1,
              stops: [],
              at: 0,
            },
          },
        }),
        t,
      ),
    ).toBe("«session.bench.gdb.state.halted» · Core/Src/main.c:136 · localhost:62169")
  })
})

describe("控制台的落盘状态", () => {
  beforeEach(() => {
    localStorage.clear()
    consoleUI.reset()
  })

  test("键在 yoma.* 下", () => {
    expect(CONSOLE_STATE_KEY).toBe("yoma.console.v1")
  })

  test("缺省是收着的 —— 它是一步可达,不是一直占地方", () => {
    expect(consoleUI.opened()).toBe(false)
    expect(consoleUI.tab()).toBe("log")
  })

  test("非法内容一律当作默认,绝不抛", () => {
    for (const junk of ["", "not json", "null", "[]", '{"open":"yes","height":"tall","tab":"nope"}']) {
      const state = readConsoleState(junk)
      expect(state.open).toBe(false)
      expect(state.tab).toBe("log")
      expect(state.height).toBeGreaterThanOrEqual(CONSOLE_MIN_HEIGHT)
      expect(state.rail).toBeUndefined()
    }
  })

  test("高度只钳下限 —— 存一个大数不是坏数据,换个大屏它就合法了", () => {
    expect(readConsoleState('{"height":12}').height).toBe(CONSOLE_MIN_HEIGHT)
    expect(readConsoleState('{"height":4000}').height).toBe(4000)
  })

  test("开合 / 页签 / 高度 / 右栏选择都落盘,最大化不落盘", () => {
    consoleUI.open("gdb")
    consoleUI.resize(321)
    consoleUI.setRail("la")
    consoleUI.toggleMaximized()
    expect(consoleUI.maximized()).toBe(true)

    const stored = readConsoleState(localStorage.getItem(CONSOLE_STATE_KEY))
    expect(stored).toEqual({ open: true, height: 321, tab: "gdb", rail: "la" })
    // 最大化是一次性的动作(同右栏的全屏):下次进来还顶着一屏控制台只会让人以为界面坏了。
    expect(JSON.parse(localStorage.getItem(CONSOLE_STATE_KEY)!)).not.toHaveProperty("maximized")
  })

  test("点当前页签 = 收起(同 VS Code 的底栏),点另一个页签只换页", () => {
    consoleUI.open("log")
    consoleUI.select("log")
    expect(consoleUI.opened()).toBe(false)

    consoleUI.select("gdb")
    expect(consoleUI.opened()).toBe(true)
    expect(consoleUI.tab()).toBe("gdb")
    consoleUI.select("log")
    expect(consoleUI.opened()).toBe(true)
    expect(consoleUI.tab()).toBe("log")
  })

  test("关掉时顺手退出最大化 —— 否则下次开出来是一屏满的,而没人按过最大化", () => {
    consoleUI.open()
    consoleUI.toggleMaximized()
    consoleUI.close()
    expect(consoleUI.maximized()).toBe(false)
    consoleUI.open()
    expect(consoleUI.maximized()).toBe(false)
  })

  test("error 水位:看过多少就是多少,收着的时候不动", () => {
    expect(consoleUI.seenErrors()).toBe(0)
    consoleUI.markErrorsSeen(3)
    expect(consoleUI.seenErrors()).toBe(3)
    consoleUI.close()
    expect(consoleUI.seenErrors()).toBe(3)
  })
})
