import { describe, expect, test } from "bun:test"
import {
  decodeColumns,
  foldColumns,
  foldedPreviewRows,
  formatFreq,
  formatSamples,
  formatTime,
  LA_LANE_HEIGHT,
  paintLanes,
  previewChannels,
  sizeCanvas,
  type LaChannel,
} from "./la-preview"

/**
 * 与内核 `columnBits`(coding-agent/src/core/la/dsl.ts)同一套算术的写入端 ——
 * 测试自己拼字节而不是 import 解码器的反函数,否则两边一起错就一起绿。
 */
function encode(levels: number[]) {
  const bytes = new Uint8Array(Math.ceil(levels.length / 4))
  levels.forEach((level, column) => {
    bytes[column >> 2]! |= (level & 3) << ((column & 3) * 2)
  })
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const HIGH = 1
const LOW = 2
const EDGE = 3

describe("decodeColumns", () => {
  test("unpacks 2 bits per column, 4 columns per byte", () => {
    const levels = [HIGH, LOW, EDGE, HIGH, LOW, EDGE, HIGH, 0]
    expect(Array.from(decodeColumns(encode(levels), levels.length))).toEqual(levels)
  })

  test("stops at the requested column count", () => {
    expect(Array.from(decodeColumns(encode([1, 2, 3, 1, 2, 3, 1, 2]), 3))).toEqual([1, 2, 3])
  })

  test("leaves columns past the end of the payload at zero", () => {
    expect(Array.from(decodeColumns(encode([3, 3, 3, 3]), 8))).toEqual([3, 3, 3, 3, 0, 0, 0, 0])
  })

  test("returns zeros for a missing row or a zero-width request", () => {
    expect(Array.from(decodeColumns("", 4))).toEqual([0, 0, 0, 0])
    expect(decodeColumns(encode([1, 1]), 0).length).toBe(0)
  })
})

describe("foldColumns", () => {
  test("ORs every column landing in the same pixel — 有高也有低就是这一像素里翻转过", () => {
    expect(Array.from(foldColumns(decodeColumns(encode([HIGH, LOW, LOW, LOW]), 4), 2))).toEqual([EDGE, LOW])
  })

  test("keeps one column per pixel when they already line up", () => {
    const masks = decodeColumns(encode([HIGH, EDGE, LOW, HIGH]), 4)
    expect(Array.from(foldColumns(masks, 4))).toEqual([HIGH, EDGE, LOW, HIGH])
  })
})

interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
  stroke: string
  width: number
}

/**
 * 画布的替身:只记下画了哪些线段。绘制是纯函数,所以这一层就够验几何与取色了。
 * 真 canvas 是在 `stroke()` 时用当时的 strokeStyle 描整条路径,而 `paintLanes` 在每条
 * 路径开头就把颜色定死,所以在 lineTo 时记当前颜色是等价的。
 */
function fakeCanvas() {
  const segments: Segment[] = []
  let cursor = { x: 0, y: 0 }
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    setTransform() {},
    clearRect() {},
    beginPath() {},
    stroke() {},
    moveTo(x: number, y: number) {
      cursor = { x, y }
    },
    lineTo(x: number, y: number) {
      segments.push({ x1: cursor.x, y1: cursor.y, x2: x, y2: y, stroke: ctx.strokeStyle, width: ctx.lineWidth })
      cursor = { x, y }
    },
  }
  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => ctx,
  }
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    raw: canvas,
    ctx: ctx as unknown as CanvasRenderingContext2D,
    segments,
  }
}

const TRACE = "#trace"
const SEPARATOR = "#separator"
const BOX = { x: 0, y: 0, laneHeight: LA_LANE_HEIGHT, pad: 3, trace: TRACE }
/** BOX 的高低电平线:pad 之后再让半像素,免得 1px 的线跨两行像素。 */
const HIGH_Y = 3.5
const LOW_Y = LA_LANE_HEIGHT - 3 - 0.5

function row(levels: number[]) {
  return decodeColumns(encode(levels), levels.length)
}

describe("paintLanes", () => {
  test("draws a steady level as one horizontal run, not one segment per pixel", () => {
    const { ctx, segments } = fakeCanvas()
    paintLanes(ctx, [row([HIGH, HIGH, HIGH, HIGH])], { ...BOX, width: 4 })
    expect(segments).toEqual([{ x1: 0, y1: HIGH_Y, x2: 4, y2: HIGH_Y, stroke: TRACE, width: 1 }])
  })

  test("draws a toggled column as a vertical line joining the two levels", () => {
    const { ctx, segments } = fakeCanvas()
    paintLanes(ctx, [row([HIGH, EDGE, EDGE, LOW])], { ...BOX, width: 4 })
    const verticals = segments.filter((s) => s.x1 === s.x2)
    expect(verticals.map((s) => s.x1)).toEqual([1.5, 2.5])
    expect(verticals.every((s) => s.y1 === HIGH_Y && s.y2 === LOW_Y)).toBe(true)
    // 翻转两侧的横线各一条,高低电平各自贴着泳道的上下沿。
    expect(segments.filter((s) => s.y1 === s.y2).map((s) => [s.x1, s.x2, s.y1])).toEqual([
      [0, 1, HIGH_Y],
      [3, 4, LOW_Y],
    ])
  })

  test("bridges a level change that falls on a pixel boundary", () => {
    const { ctx, segments } = fakeCanvas()
    paintLanes(ctx, [row([HIGH, LOW])], { ...BOX, width: 2 })
    expect(segments).toEqual([
      { x1: 0, y1: HIGH_Y, x2: 1, y2: HIGH_Y, stroke: TRACE, width: 1 },
      { x1: 1, y1: HIGH_Y, x2: 1, y2: LOW_Y, stroke: TRACE, width: 1 },
      { x1: 1, y1: LOW_Y, x2: 2, y2: LOW_Y, stroke: TRACE, width: 1 },
    ])
  })

  test("leaves a gap where the row has no samples at all", () => {
    const { ctx, segments } = fakeCanvas()
    paintLanes(ctx, [row([HIGH, 0, 0, HIGH])], { ...BOX, width: 4 })
    expect(segments.map((s) => [s.x1, s.x2])).toEqual([
      [0, 1],
      [3, 4],
    ])
  })

  test("offsets each lane by laneHeight and honours x/y", () => {
    const { ctx, segments } = fakeCanvas()
    paintLanes(ctx, [row([HIGH]), row([LOW])], { ...BOX, x: 10, y: 20, width: 1 })
    expect(segments.map((s) => [s.x1, s.y1])).toEqual([
      [10, 20 + HIGH_Y],
      [10, 20 + LA_LANE_HEIGHT + LOW_Y],
    ])
  })

  test("separates lanes but never trails a line under the last one", () => {
    const { ctx, segments } = fakeCanvas()
    paintLanes(ctx, [row([0]), row([0]), row([0])], { ...BOX, width: 32, separator: SEPARATOR })
    const lines = segments.filter((s) => s.stroke === SEPARATOR)
    expect(lines.map((s) => s.y1)).toEqual([LA_LANE_HEIGHT - 0.5, LA_LANE_HEIGHT * 2 - 0.5])
    expect(lines.every((s) => s.x1 === 0 && s.x2 === 32)).toBe(true)
  })

  test("draws nothing without rows or width", () => {
    const { ctx, segments } = fakeCanvas()
    paintLanes(ctx, [], { ...BOX, width: 32, separator: SEPARATOR })
    paintLanes(ctx, [row([HIGH])], { ...BOX, width: 0 })
    expect(segments).toEqual([])
  })
})

describe("sizeCanvas", () => {
  test("sizes the backing store by devicePixelRatio and the box by CSS px", () => {
    const { canvas, raw } = fakeCanvas()
    expect(sizeCanvas(canvas, 200, 32, 2)).toBeDefined()
    expect(raw.width).toBe(400)
    expect(raw.height).toBe(64)
    expect(raw.style.width).toBe("200px")
    expect(raw.style.height).toBe("32px")
  })
})

describe("foldedPreviewRows", () => {
  const channels: LaChannel[] = [
    { index: 0, name: "SCL" },
    { index: 3, name: "SDA" },
  ]
  const preview = {
    columns: 4,
    from: 0,
    to: 4,
    rows: { "0": encode([HIGH, HIGH, LOW, LOW]) },
  }

  test("decodes and folds one row per channel, in channel order", () => {
    const rows = foldedPreviewRows(preview, channels, 2)
    expect(rows.length).toBe(2)
    expect(Array.from(rows[0]!)).toEqual([HIGH, LOW])
    // 预览里没有这个通道的行 → 全 0,paintLanes 于是什么都不画(而不是画一条假的低电平)。
    expect(Array.from(rows[1]!)).toEqual([0, 0])
  })

  test("reuses the decode for the same preview + width", () => {
    const first = foldedPreviewRows(preview, channels, 8)
    expect(foldedPreviewRows(preview, channels, 8)).toBe(first)
    expect(foldedPreviewRows(preview, channels, 16)).not.toBe(first)
  })

  test("has nothing to fold without a preview or a width", () => {
    expect(foldedPreviewRows(undefined, channels, 8)).toEqual([])
    expect(foldedPreviewRows(preview, channels, 0)).toEqual([])
    expect(foldedPreviewRows(preview, [], 8)).toEqual([])
  })
})

describe("previewChannels", () => {
  test("prefers the declared channel table", () => {
    const channels = [{ index: 3, name: "SDA" }]
    expect(previewChannels({ channels, preview: { columns: 4, from: 0, to: 1, rows: { "0": "AA" } } })).toBe(channels)
  })

  test("falls back to the preview rows, numerically sorted", () => {
    const rows = { "10": "AA", "2": "AA", "0": "AA" }
    expect(previewChannels({ preview: { columns: 4, from: 0, to: 1, rows } })).toEqual([
      { index: 0, name: "D0" },
      { index: 2, name: "D2" },
      { index: 10, name: "D10" },
    ])
  })

  test("has nothing to draw without channels or rows", () => {
    expect(previewChannels({})).toEqual([])
  })
})

/** 格式化在内核的 la-codec 里(host 也要用),这里只钉住"卡片与面板拿到的就是它"。 */
describe("re-exported formatters", () => {
  test("frequency, time and sample counts", () => {
    expect(formatFreq(25_000_000)).toBe("25 MHz")
    expect(formatFreq(0)).toBe("—")
    expect(formatTime(0.04)).toBe("40.000 ms")
    expect(formatSamples(1_000_000)).toBe("1M")
  })
})
