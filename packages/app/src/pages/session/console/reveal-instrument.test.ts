import { beforeEach, describe, expect, test } from "vitest"
import { EMPTY_BENCH_STATUS, type BenchStatus, type InstrumentId } from "../bench/bench-status"
import { benchPins, EMPTY_BENCH_DISK, type BenchDisk, type InstrumentContext } from "../bench/instruments"
import { debug as dock } from "../debug/debug-data"
import { consoleUI } from "./console-state"
import { openWorkbenchInstrument, toggleInstrument } from "./reveal-instrument"

function ctx(
  input: { status?: Partial<BenchStatus>; disk?: Partial<BenchDisk>; pinned?: InstrumentId[] } = {},
): InstrumentContext {
  return {
    status: { ...EMPTY_BENCH_STATUS, ...input.status } as BenchStatus,
    disk: { ...EMPTY_BENCH_DISK, ...input.disk },
    pinned: new Set(input.pinned ?? []),
  }
}

describe("点一次展开,再点一次收起", () => {
  beforeEach(() => {
    localStorage.clear()
    benchPins.reset()
    consoleUI.reset()
    consoleUI.close()
    dock.close()
    dock.setMode("debug")
  })

  test("串口与日志只开底部控制台,空着的波形页收掉", () => {
    dock.open()
    toggleInstrument("log", ctx())
    expect(consoleUI.opened()).toBe(true)
    expect(consoleUI.tab()).toBe("log")
    expect(dock.opened()).toBe(false)
    expect(consoleUI.rail()).toBeUndefined()
  })

  test("日志已经开着时再点一次,控制台收回去", () => {
    toggleInstrument("log", ctx())
    toggleInstrument("log", ctx())
    expect(consoleUI.opened()).toBe(false)
    expect(dock.opened()).toBe(false)
  })

  test("已经点开的示波器不跟着日志一起收", () => {
    const scope = ctx({ pinned: ["scope"] })
    toggleInstrument("scope", scope)
    expect(dock.opened()).toBe(true)
    expect(consoleUI.rail()).toBe("scope")
    toggleInstrument("log", scope)
    expect(consoleUI.opened()).toBe(true)
    expect(consoleUI.tab()).toBe("log")
    expect(dock.opened()).toBe(true)
    expect(consoleUI.rail()).toBe("scope")
  })

  test("示波器开着再点一次,右栏收起", () => {
    const scope = ctx({ pinned: ["scope"] })
    toggleInstrument("scope", scope)
    toggleInstrument("scope", scope)
    expect(dock.opened()).toBe(false)
    expect(consoleUI.opened()).toBe(false)
  })

  test("首页卡片进串口与日志,连上一回的示波器也不带进来", () => {
    const scope = ctx({ pinned: ["scope"] })
    toggleInstrument("scope", scope)
    openWorkbenchInstrument("log")
    expect(consoleUI.opened()).toBe(true)
    expect(consoleUI.tab()).toBe("log")
    expect(dock.opened()).toBe(false)
  })
})
