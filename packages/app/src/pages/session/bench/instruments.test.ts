import { beforeEach, describe, expect, test } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { EMPTY_BENCH_STATUS, type BenchStatus, type InstrumentId } from "./bench-status"
import {
  BENCH_PIN_KEY,
  EMPTY_BENCH_DISK,
  INSTRUMENTS,
  hiddenInstruments,
  instrumentById,
  isVisible,
  visibleInstruments,
  type BenchDisk,
  type InstrumentContext,
} from "./instruments"
import { BENCH_CHANNEL_COLORS, BENCH_CHANNEL_VARS, benchChannelColor } from "./bench-theme"
import { SCOPE_COLORS } from "../debug/scope-waveform-data"

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

describe("注册表", () => {
  test("登记顺序就是堆叠顺序:日志 → 调试器 → 示波器 → 逻辑分析仪", () => {
    expect(ids([...INSTRUMENTS])).toEqual(["log", "gdb", "scope", "la"])
  })

  test("每条记录都齐全,而且 i18n 键按 id 推得出来", () => {
    for (const instrument of INSTRUMENTS) {
      expect(instrument.labelKey).toBe(`session.bench.instrument.${instrument.id}`)
      expect(typeof instrument.component).toBe("function")
      expect(["core", "frequent", "occasional"]).toContain(instrument.tier)
    }
  })

  test("instrumentById 认得每一个 id,不认得瞎编的", () => {
    expect(instrumentById("gdb")?.tier).toBe("frequent")
    expect(instrumentById("power")).toBeUndefined()
  })
})

describe("可见性 = 核心 ∪ 用过 ∪ 有数据 ∪ 钉住", () => {
  test("什么都没有时只剩核心的日志", () => {
    expect(ids(visibleInstruments(ctx()))).toEqual(["log"])
    expect(ids(hiddenInstruments(ctx()))).toEqual(["gdb", "scope", "la"])
  })

  test("这次会话碰过就出现", () => {
    const status = { used: new Set<InstrumentId>(["la"]) }
    expect(ids(visibleInstruments(ctx({ status })))).toEqual(["log", "la"])
  })

  test("磁盘上有上一轮存的采集也出现(会话重开照样看得见)", () => {
    expect(ids(visibleInstruments(ctx({ disk: { scopeCaptures: 3 } })))).toEqual(["log", "scope"])
  })

  test("钉住的即使没数据也出现", () => {
    expect(ids(visibleInstruments(ctx({ pinned: ["la"] })))).toEqual(["log", "la"])
  })

  test("核心档不论如何都在", () => {
    expect(isVisible(INSTRUMENTS[0], ctx())).toBe(true)
  })
})

describe("状态灯", () => {
  const byId = (id: string) => INSTRUMENTS.find((instrument) => instrument.id === id)!

  test("日志:采集中是 active,来源非零退出是 attention,什么都没有是 offline", () => {
    const log = byId("log")
    expect(log.status(ctx())).toBe("offline")
    expect(log.status(ctx({ disk: { logFiles: 1 } }))).toBe("idle")
    expect(log.status(ctx({ status: { log: { capturing: true, totalLines: 0, dropped: 0, at: 0 } } }))).toBe("active")
    expect(
      log.status(ctx({ status: { log: { capturing: false, exitCode: 1, totalLines: 0, dropped: 0, at: 0 } } })),
    ).toBe("attention")
  })

  test("调试器:故障压过一切,运行中是 active,退出 / 掉线是 offline", () => {
    const gdb = byId("gdb")
    expect(gdb.status(ctx())).toBe("offline")
    expect(gdb.status(ctx({ status: { gdb: { state: "halted", epoch: 1, stops: [], at: 0 } } }))).toBe("idle")
    expect(gdb.status(ctx({ status: { gdb: { state: "running", epoch: 1, stops: [], at: 0 } } }))).toBe("active")
    expect(gdb.status(ctx({ status: { gdb: { state: "exited", epoch: 1, stops: [], at: 0 } } }))).toBe("offline")
    expect(
      gdb.status(
        ctx({ status: { gdb: { state: "running", fault: "故障(HardFault):…", epoch: 1, stops: [], at: 0 } } }),
      ),
    ).toBe("attention")
  })

  test("波形两台:有数据是 idle,正在跑是 active", () => {
    expect(byId("scope").status(ctx({ disk: { scopeCaptures: 1 } }))).toBe("idle")
    expect(byId("la").status(ctx({ status: { busy: new Set(["la"]) } }))).toBe("active")
  })
})

describe("钉住集合落盘", () => {
  beforeEach(() => localStorage.clear())

  test("键在 yoma.* 下", () => {
    expect(BENCH_PIN_KEY).toBe("yoma.bench.pins")
  })

  test("非法内容一律当作「没钉过」,绝不抛", async () => {
    const { PinsTesting } = await import("./instruments")
    for (const junk of ["", "not json", "{}", '["nope"]', "[1,2]"]) {
      localStorage.setItem(BENCH_PIN_KEY, junk)
      expect([...PinsTesting.readPins()]).toEqual([])
    }
    localStorage.setItem(BENCH_PIN_KEY, '["la","scope","bogus"]')
    expect([...PinsTesting.readPins()].sort()).toEqual(["la", "scope"])
  })
})

describe("通道色只有一份", () => {
  test("画布那份(SCOPE_COLORS)就是这份", () => {
    expect([...SCOPE_COLORS]).toEqual([...BENCH_CHANNEL_COLORS])
  })

  test("bench.css 里的 --bench-chN 与这份逐字相同 —— canvas 读不到 CSS 变量,两边必须手工同解", () => {
    // happy-dom 下 `import.meta.url` 是个 http 地址,不能拿去 fileURLToPath;
    // 从 cwd 找(根目录跑 `--project app` 与包目录里跑 `vitest run` 两种都要成立)。
    // bench.css 2026-09-18 搬到了 session-ui(卡片与面板共用),所以这里往上一层找。
    const rel = "packages/session-ui/src/components/bench.css"
    const file = [
      resolve(process.cwd(), rel),
      resolve(process.cwd(), "..", "..", rel),
      resolve(process.cwd(), "../session-ui/src/components/bench.css"),
    ].find((path) => existsSync(path))
    expect(file, "找不到 bench.css").toBeTruthy()
    const css = readFileSync(file!, "utf8")
    for (const [index, variable] of BENCH_CHANNEL_VARS.entries()) {
      const hit = new RegExp(`${variable}:\\s*light-dark\\((#[0-9a-f]{6})\\s*,`, "i").exec(css)
      expect(hit, `${variable} 不在 bench.css 里`).toBeTruthy()
      expect(hit![1].toLowerCase()).toBe(BENCH_CHANNEL_COLORS[index])
    }
  })

  test("超过四条通道就循环", () => {
    expect(benchChannelColor(1)).toBe(BENCH_CHANNEL_COLORS[0])
    expect(benchChannelColor(5)).toBe(BENCH_CHANNEL_COLORS[0])
    expect(benchChannelColor(0)).toBe(BENCH_CHANNEL_COLORS[0])
  })
})
