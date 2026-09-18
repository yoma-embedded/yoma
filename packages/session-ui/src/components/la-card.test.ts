import { describe, expect, test } from "vitest"
import { fixture } from "./fixtures/hw-parts"
import { describeLa, laConclusion } from "./la-card"
import { decodeColumns, foldColumns, foldedPreviewRows, LA_COLUMN_EDGE } from "./la-preview"

describe("describeLa · 真实形状(DSView 的 demo 波形)", () => {
  const part = fixture("la", "import")
  const card = describeLa(part.input, part.metadata, part.output)!

  test("采集元数据", () => {
    expect(card.action).toBe("import")
    expect(card.captureId).toBe("la-20260918-011558793-import")
    expect(card.samplerate).toBe(25_000_000)
    expect(card.samples).toBe(131_072)
    expect(card.durationMs).toBeCloseTo(5.24288, 5)
    expect(card.channels.length).toBe(16)
  })

  test("有名字的通道与自动序号名分得开", () => {
    expect(card.named.map((channel) => channel.name)).toEqual([
      "SDA",
      "SCL",
      "UART",
      "CAN-FD",
      "CLK",
      "CS#",
      "MOSI",
      "MISO",
    ])
    // D2 的名字就是 "2",那是自动生成的,不算"有名字"
    expect(card.channels[2].name).toBe("2")
  })

  test("预览按 1024 列 × 每通道一条 base64 读进来", () => {
    expect(card.preview?.columns).toBe(1024)
    expect(Object.keys(card.preview!.rows).length).toBe(16)
  })

  test("画之前那一步走的是共用读法,而且真的有边沿", () => {
    // 与右栏面板同一个函数(la-preview.ts)—— 读法有第二份就会画出一张合理的假波形
    const rows = foldedPreviewRows(card.preview, card.channels, 200)
    expect(rows.length).toBe(16)
    expect(rows[0].length).toBe(200)
    // SCL(D1)在这段波形里跳得最凶,折到 200 像素后必然有翻转列
    expect(rows[1].some((mask) => mask === LA_COLUMN_EDGE)).toBe(true)
    // 同一份 base64 直接解也是同一批列
    const direct = foldColumns(decodeColumns(card.preview!.rows["1"], 1024), 200)
    expect([...rows[1]]).toEqual([...direct])
  })

  test("summary 带上每通道的边沿数", () => {
    const summary = fixture("la", "summary")
    const hit = describeLa(summary.input, summary.metadata, summary.output)!
    expect(hit.channels[1]).toMatchObject({ index: 1, name: "SCL", edges: 510 })
  })

  test("timing 有查询窗口", () => {
    const timing = fixture("la", "timing")
    const hit = describeLa(timing.input, timing.metadata, timing.output)!
    expect(hit.window).toEqual({ from: 0, to: 131072 })
  })
})

describe("laConclusion", () => {
  test("折叠态一句:采样数 @ 采样率 · 时长 · 通道数", () => {
    const part = fixture("la", "import")
    const text = laConclusion(describeLa(part.input, part.metadata, part.output)!)!
    expect(text).toContain("131.072k @ 25 MHz")
    expect(text).toContain("16 ch")
  })

  test("触发超时要说出来 —— 它证明不了总线上的任何事", () => {
    const text = laConclusion(describeLa({ action: "collect" }, { action: "collect", timedOut: true }, "")!)!
    expect(text).toContain("timed out")
  })
})

describe("describeLa · 边界", () => {
  test("形状不对 → undefined(回落通用卡)", () => {
    expect(describeLa({}, {}, "imported something")).toBeUndefined()
    expect(describeLa(undefined, undefined, undefined)).toBeUndefined()
    expect(describeLa({ action: "nope" }, { action: [] }, "")).toBeUndefined()
  })

  test("预览缺列数 / rows 不是字符串 → 不画,但卡片还在", () => {
    const card = describeLa(
      { action: "summary" },
      { action: "summary", preview: { columns: 0, rows: { "0": "AAAA" } }, channels: [{ index: 0, name: "SDA" }] },
      "",
    )!
    expect(card.preview).toBeUndefined()
    expect(card.channels.length).toBe(1)
    expect(describeLa({ action: "summary" }, { action: "summary", preview: { columns: 8, rows: { "0": 3 } } }, "")!.preview).toBeUndefined()
  })

  test("通道数组里混了垃圾条目:丢掉那一条,不抛", () => {
    const card = describeLa(
      { action: "summary" },
      { action: "summary", channels: [{ index: 0, name: "SDA" }, null, { name: "no index" }, 7] },
      "",
    )!
    expect(card.channels).toEqual([{ index: 0, name: "SDA", edges: undefined }])
  })

  test("metadata 里塞垃圾也不抛", () => {
    expect(() =>
      describeLa({ action: "capture" }, { action: "capture", samplerate: "25M", device: 3 } as never, undefined),
    ).not.toThrow()
  })
})
