import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { scopeCaptures, scopeScreenshot, scopeView } from "./scope-view.ts"
import {
  readCaptureMeta,
  readScopeConfig,
  SCOPE_DIR,
  writeCapture,
  writeScopeConfig,
  type ScopeCaptureMeta,
} from "./domain/scope/store.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function capture(values: number[] = [0, 1, 2, 3], change?: (meta: ScopeCaptureMeta) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scope-view-"))
  roots.push(root)
  const dir = path.join(root, SCOPE_DIR, "capture-1")
  const meta: ScopeCaptureMeta = {
    id: "capture-1",
    createdAt: 1000,
    address: "usb:test",
    model: "SDS824X HD",
    mode: "single",
    quality: "exact",
    timebase: { scale: 0.00001, delay: 0 },
    sampleRate: 1e6,
    interval: 1e-6,
    stride: 1,
    recordPoints: values.length,
    trigger: { status: "Stop", source: "C1", level: 1 },
    channels: [
      {
        ch: 1,
        file: "c1.i16",
        points: values.length,
        probe: 10,
        vdiv: 10,
        offset: 2,
        unit: "V",
        gain: 1,
        codePerDiv: 1000,
        rawOffset: 0.2,
      },
    ],
  }
  change?.(meta)
  const samples = new Map(meta.channels.map((ch) => [ch.ch, Int16Array.from(values)]))
  await writeCapture(dir, meta, samples)
  return { root, dir, meta, samples }
}

describe("saved scope evidence", () => {
  it("keeps local USB addresses under ignored artifacts and reads legacy configuration", async () => {
    const { root } = await capture()
    await writeFile(path.join(root, ".yoma/scope.json"), JSON.stringify({ address: "usb:old" }))
    expect(await readScopeConfig(root)).toEqual({ address: "usb:old" })
    await writeScopeConfig(root, { address: "usb:new" })
    expect(await readScopeConfig(root)).toEqual({ address: "usb:new" })
    expect(await readFile(path.join(root, SCOPE_DIR, ".gitignore"), "utf8")).toBe("*\n")
    expect(await readFile(path.join(root, ".yoma/scope.json"), "utf8")).toContain("usb:old")
  })

  it("does not label legacy partial records as exact even without acquisition decimation", async () => {
    const { dir } = await capture([0, 1], (m) => {
      delete m.quality
      m.recordPoints = 100
    })
    expect((await scopeView({ dir, columns: 100 })).capture.quality).toBe("overview")
  })

  it("reads physical units and trigger-relative time after the device is gone", async () => {
    const { root, dir } = await capture([0, 100, 200, 300])
    const list = await scopeCaptures(root)
    expect(list).toHaveLength(1)
    const view = await scopeView({ dir, columns: 100 })
    expect(view.channels[0].exact).toBe(true)
    view.channels[0].points.forEach((point, i) => expect(point.min).toBeCloseTo([-2, -1, 0, 1][i], 10))
    expect(view.channels[0].points[0].t).toBeCloseTo(-50e-6, 12)
    expect(view.channels[0].points[3].t).toBeCloseTo(-47e-6, 12)
    expect(await scopeScreenshot(dir)).toBeUndefined()
  })

  it("preserves a one-sample glitch in a narrow preview and exposes actual samples when zoomed", async () => {
    const values = Array<number>(1000).fill(0)
    values[513] = 1200
    values[514] = -300
    const { dir } = await capture(values)
    const preview = await scopeView({ dir, columns: 12 })
    expect(preview.channels[0].exact).toBe(false)
    expect(preview.channels[0].points).toHaveLength(12)
    expect(Math.max(...preview.channels[0].points.map((p) => p.max))).toBe(10)
    expect(Math.min(...preview.channels[0].points.map((p) => p.min))).toBe(-5)
    const zoom = await scopeView({ dir, columns: 12, from: 463e-6, to: 465e-6 })
    expect(zoom.channels[0].exact).toBe(true)
    expect(zoom.channels[0].points.map((p) => p.min)).toEqual([10, -5])
  })

  it("retains each channel's own timing instead of using the first channel's rate", async () => {
    const { dir } = await capture([0, 1, 2, 3], (m) => {
      m.channels.push({
        ...m.channels[0],
        ch: 2,
        file: "c2.i16",
        time: { delay: 0.001, tdiv: 0.00001, grid: 10, interval: 2e-6 },
      })
    })
    const result = await scopeView({ dir, columns: 10, channels: [2] })
    expect(result.channels).toHaveLength(1)
    expect(result.channels[0].points[0].t).toBeCloseTo(0.00095, 12)
    expect(result.channels[0].points[1].t - result.channels[0].points[0].t).toBeCloseTo(2e-6, 12)
  })

  it("labels acquisition decimation even when the display shows individual stored points", async () => {
    const { dir } = await capture([0, 1, 2, 3], (m) => {
      m.quality = "overview"
      m.stride = 10
      m.interval = 1e-5
      m.recordPoints = 40
    })
    const view = await scopeView({ dir, columns: 100 })
    expect(view.capture.quality).toBe("overview")
    expect(view.capture.channels[0].stride).toBe(10)
    expect(view.channels[0].exact).toBe(true)
  })

  it("refuses to replace old evidence and does not list uncommitted partial captures", async () => {
    const { root, dir, meta, samples } = await capture()
    await expect(writeCapture(dir, meta, samples)).rejects.toThrow("already exists")
    await mkdir(path.join(root, SCOPE_DIR, "partial"))
    await writeFile(path.join(root, SCOPE_DIR, "partial", "c1.i16"), Buffer.alloc(8))
    expect(await scopeCaptures(root)).toHaveLength(1)
  })

  it("refuses truncated samples even after a previously successful cached read", async () => {
    const { dir } = await capture()
    await scopeView({ dir, columns: 10 })
    await writeFile(path.join(dir, "c1.i16"), Buffer.alloc(2))
    await expect(scopeView({ dir, columns: 10 })).rejects.toThrow("incomplete")
  })

  it("rejects malicious filenames, invalid scales, and false exact labels", async () => {
    const { dir, meta } = await capture()
    const file = path.join(dir, "capture.json")
    for (const bad of [
      { ...meta, channels: [{ ...meta.channels[0], file: "../secret" }] },
      { ...meta, interval: 0 },
      { ...meta, stride: 10 },
      { ...meta, recordPoints: 100 },
    ]) {
      await writeFile(file, JSON.stringify(bad))
      await expect(readCaptureMeta(dir)).rejects.toThrow("scope:")
    }
  })

  it("bounds views and rejects invalid or nonoverlapping requests", async () => {
    const { dir } = await capture()
    for (const params of [
      { columns: NaN },
      { columns: 0 },
      { columns: 10, from: Infinity },
      { columns: 10, from: 1 },
      { columns: 10, channels: [7] },
    ]) {
      await expect(scopeView({ dir, ...params })).rejects.toThrow("scope.view:")
    }
    expect((await scopeView({ dir, columns: 999999 })).columns).toBe(4096)
  })

  it("serves only the screenshot belonging to this capture, with its own timestamp", async () => {
    const { dir } = await capture([0], (m) => {
      m.screenshot = { file: "screen.png", createdAt: 1200 }
    })
    await writeFile(
      path.join(dir, "screen.png"),
      await readFile(path.resolve(import.meta.dirname, "../../test/fixtures/scope/screen.png")),
    )
    const screenshot = await scopeScreenshot(dir)
    expect(screenshot?.createdAt).toBe(1200)
    expect(screenshot?.url).toMatch(/^data:image\/png;base64,/)
    await writeFile(path.join(dir, "screen.png"), "not a png")
    await expect(scopeScreenshot(dir)).rejects.toThrow("PNG")
  })
})
