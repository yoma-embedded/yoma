import { describe, expect, test } from "vitest"
import { fixture } from "./fixtures/hw-parts"
import { describeScope, isDemoWarning, scopeConclusion } from "./scope-card"

describe("describeScope · 真实形状(demo 驱动)", () => {
  test("connect:型号 / 序列号 / 通道 / 时基 / 触发", () => {
    const part = fixture("scope", "connect")
    const card = describeScope(part.input, part.metadata, part.output)!
    expect(card.model).toBe("DEMO")
    expect(card.serial).toBe("DEMO-0001")
    expect(card.driver).toBe("demo")
    expect(card.channels.length).toBe(4)
    expect(card.on.map((channel) => channel.ch)).toEqual([1, 2])
    expect(card.timebase).toEqual({ scale: 0.0002, delay: 0 })
    expect(card.trigger).toMatchObject({ source: "C2", slope: "RISING", mode: "AUTO", level: 1.65 })
  })

  test("DEMO 警告留着 —— 它说的是'这不是硬件证据'", () => {
    const part = fixture("scope", "connect")
    const card = describeScope(part.input, part.metadata, part.output)!
    expect(card.warnings.length).toBe(1)
    expect(isDemoWarning(card.warnings[0])).toBe(true)
  })

  test("setup:通道标签与探头倍率读回来", () => {
    const part = fixture("scope", "setup")
    const card = describeScope(part.input, part.metadata, part.output)!
    expect(card.channels[0]).toMatchObject({ ch: 1, label: "SDA", probe: 10, coupling: "DC" })
    expect(card.channels[2]).toMatchObject({ ch: 3, on: false })
  })

  test("capture:采集元数据 + 保存目录", () => {
    const part = fixture("scope", "capture")
    const card = describeScope(part.input, part.metadata, part.output)!
    expect(card.captureId).toBe("scope-db1616d6-a262-4a1c-bf6e-19800e006294")
    expect(card.points).toBe(100_000)
    expect(card.interval).toBe(2e-8)
    expect(card.quality).toBe("exact")
    expect(card.stride).toBe(1)
    expect(card.dir).toContain("/.yoma/scope/")
  })

  test("measure:量出来的与量不出来的分得开", () => {
    const part = fixture("scope", "measure")
    const card = describeScope(part.input, part.metadata, part.output)!
    expect(card.measurements.length).toBe(5)
    const rise = card.measurements.find((item) => item.type === "rise")!
    expect(rise.source).toBe("C2")
    expect(rise.unit).toBe("s")
    expect(rise.value).toBeCloseTo(5.9456e-7, 10)
    // frequency 这一条 value 是 null:**量不出来**,不是 0Hz
    const frequency = card.measurements.find((item) => item.type === "frequency")!
    expect(frequency.value).toBe(null)
    expect(frequency.n).toBe(0)
  })
})

describe("scopeConclusion", () => {
  test("capture:通道 + 点数 + 每点间隔", () => {
    const part = fixture("scope", "capture")
    const text = scopeConclusion(describeScope(part.input, part.metadata, part.output)!)!
    expect(text).toContain("C1 C2")
    expect(text).toContain("100k pts")
    expect(text).toContain("20 ns/pt")
    expect(text).toContain("exact")
  })

  test("measure:第一条量测 + 还有几条", () => {
    const part = fixture("scope", "measure")
    const text = scopeConclusion(describeScope(part.input, part.metadata, part.output)!)!
    expect(text).toBe("rise C2 594.6 ns · +4")
  })

  test("measure 第一条量不出来时说的是 —,不是 0", () => {
    const text = scopeConclusion(
      describeScope(
        { action: "measure" },
        { action: "measure", measurements: [{ type: "frequency", source: "C1", value: null, unit: "Hz", n: 0 }] },
        "",
      )!,
    )!
    expect(text).toBe("frequency C1 —")
  })

  test("connect:型号 + 开着的通道 + 时基", () => {
    const part = fixture("scope", "connect")
    const text = scopeConclusion(describeScope(part.input, part.metadata, part.output)!)!
    expect(text).toBe("DEMO · C1 C2 · 200 µs/div")
  })
})

describe("describeScope · 边界", () => {
  test("形状不对 → undefined(回落通用卡)", () => {
    expect(describeScope({}, {}, "Disconnected")).toBeUndefined()
    expect(describeScope(undefined, undefined, undefined)).toBeUndefined()
    expect(describeScope({ action: "nope" }, { action: {} }, "")).toBeUndefined()
  })

  test("量测数组里混了垃圾条目:丢掉那一条,不抛", () => {
    const card = describeScope(
      { action: "measure" },
      { action: "measure", measurements: [null, { source: "C1" }, { type: "pkpk", source: "C1", value: "3.3" }] },
      "",
    )!
    // 缺 type 的丢掉;value 不是数字的按"量不出来"算(toFixed 会把整张卡炸成裸 TypeError)
    expect(card.measurements).toEqual([{ type: "pkpk", source: "C1", value: null, unit: undefined, n: undefined }])
  })

  test("metadata 里塞垃圾也不抛", () => {
    expect(() =>
      describeScope({ action: "status" }, { action: "status", timebase: 5, trigger: "edge", channels: 1 } as never, ""),
    ).not.toThrow()
    const card = describeScope({ action: "status" }, { action: "status", timebase: 5, channels: 1 } as never, "")!
    expect(card.timebase).toBeUndefined()
    expect(card.channels).toEqual([])
  })
})
