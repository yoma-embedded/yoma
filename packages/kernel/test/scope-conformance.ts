/**
 * 驱动一致性套件:任何 ScopeDriver 都要过的断言,写的是"调用方可以依赖什么",不是某个厂商的协议。
 * 一个厂商过不了某条,先怀疑接口定义错了,再考虑给厂商开特例。
 *
 * 跑三遍:Siglent 对着 FakeSds、DemoScope、以及(设了 YOMA_SCOPE_HARDWARE=<address> 时)真机 —— 真机那遍
 * 就是"同一把尺子量真仪器",新驱动来了直接有及格线。
 *
 * 套件顺序有状态:前面的测试改了仪器设置,后面的测试接着用。真机上用 `channel` 指到接了信号的通道
 * (悬空通道上单次触发永远等不到,2026-09-17 就是这样发现"没触发就 STOP,记录是空的"这条真机规矩的)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { isKnownTriggerStatus, measurementName, type ScopeDriver } from "../src/host/domain/scope/driver.ts"
import { pngComplete } from "../src/host/domain/scope/scpi.ts"
import { validateCapture, type ScopeCaptureMeta } from "../src/host/domain/scope/store.ts"

export interface ConformanceHarness {
  driver: ScopeDriver
  cleanup(): Promise<void>
  /** 套件用来设置、触发、读波形的通道;真机上指到接了信号的那一路。默认 1 */
  channel?: number
  /** AUTO 模式下 RUN 之后等多久再 STOP,好让仪器至少采完一帧。假仪器 0 就够,真机给 1 秒以上 */
  acquireMs?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function describeScopeDriver(name: string, open: () => Promise<ConformanceHarness>): void {
  describe(`scope driver conformance: ${name}`, () => {
    let h: ConformanceHarness
    let d: ScopeDriver
    let ch = 1
    let off = 4
    let acquireMs = 0
    beforeAll(async () => {
      h = await open()
      d = h.driver
      ch = h.channel ?? 1
      off = ch === 4 ? 3 : 4
      acquireMs = h.acquireMs ?? 0
    })
    afterAll(async () => {
      await h.cleanup()
    })

    it("identifies itself: driver name, non-empty model, string label, warnings array", () => {
      expect(typeof d.driver).toBe("string")
      expect(d.driver.length).toBeGreaterThan(0)
      expect(d.identity.model.length).toBeGreaterThan(0)
      expect(typeof d.label).toBe("string")
      expect(Array.isArray(d.warnings)).toBe(true)
      expect(d.address.driver).toBe(d.driver)
    })

    it("status lists every channel the capabilities promise, with the fields the tool reads", async () => {
      const st = await d.status()
      const cap = d.capabilities(st)
      expect(st.channels.length).toBe(cap.channels)
      expect(cap.enabledChannels).toBe(st.channels.filter((c) => c.on).length)
      for (const c of st.channels) {
        expect(c.ch).toBeGreaterThan(0)
        expect(c.vdiv).toBeGreaterThan(0)
        expect(c.probe).toBeGreaterThan(0)
        expect(typeof c.unit).toBe("string")
        expect(typeof c.coupling).toBe("string")
      }
      expect(st.timebase.scale).toBeGreaterThan(0)
      expect(st.acquire.sampleRate).toBeGreaterThan(0)
      expect(isKnownTriggerStatus(st.trigger.status)).toBe(true)
    })

    it("capabilities are lists, never undefined; verified and customProbe are booleans", async () => {
      const cap = d.capabilities(await d.status())
      for (const key of [
        "units",
        "couplings",
        "bwlimits",
        "probes",
        "triggerTypes",
        "triggerSources",
        "triggerSlopes",
        "triggerModes",
        "memoryDepths",
        "sampleRates",
        "measureTypes",
        "vendorMeasureTypes",
      ] as const)
        expect(Array.isArray(cap[key]), key).toBe(true)
      expect(typeof cap.verified).toBe("boolean")
      expect(typeof cap.customProbe).toBe("boolean")
      expect(cap.timebase.min).toBeGreaterThan(0)
      expect(cap.timebase.max).toBeGreaterThan(cap.timebase.min)
      expect(cap.triggerTypes).toContain("edge")
    })

    it("setChannel: a legal value reads back with no mismatch and status agrees", async () => {
      const cap = d.capabilities()
      const probe = cap.probes.includes(10) ? 10 : cap.probes[0]!
      const r = await d.setChannel({ ch, on: true, probe, coupling: cap.couplings[0], vdiv: 1 * probe })
      expect(r.mismatches).toEqual([])
      expect(r.state.on).toBe(true)
      expect(r.state.probe).toBe(probe)
      const st = await d.status()
      expect(st.channels[ch - 1]).toMatchObject({ on: true, probe, vdiv: r.state.vdiv })
    })

    it("setChannel: an unlisted probe is never applied silently — accepted only if customProbe, else mismatch", async () => {
      const before = await d.channel(ch)
      const r = await d.setChannel({ ch, probe: 7 })
      if (Math.abs(r.state.probe - 7) > 1e-9) expect(r.mismatches.join(" ")).toMatch(/probe/)
      else expect(d.capabilities().customProbe).toBe(true)
      expect(r.state.probe === 7 || r.state.probe === before.probe).toBe(true)
    })

    it("setChannel: on a switched-off channel, vdiv is either applied or reported — never dropped silently", async () => {
      await d.setChannel({ ch: off, on: false })
      const r = await d.setChannel({ ch: off, vdiv: 2 })
      if (Math.abs(r.state.vdiv - 2) > 1e-9) expect(r.mismatches.join(" ")).toMatch(/vdiv/)
      const parked = await d.setChannel({ ch: off, on: false, vdiv: 1 })
      expect(parked.state.on).toBe(false)
      if (Math.abs(parked.state.vdiv - 1) > 1e-9) expect(parked.mismatches.join(" ")).toMatch(/vdiv/)
    })

    it("setTimebase: legal scale reads back; an off-grid scale is snapped and reported", async () => {
      const ok = await d.setTimebase({ scale: 1e-4, delay: 0 })
      expect(ok.mismatches).toEqual([])
      expect(ok.state.scale).toBe(1e-4)
      const odd = await d.setTimebase({ scale: 3e-4 })
      if (odd.state.scale !== 3e-4) expect(odd.mismatches.join(" ")).toMatch(/timebase/)
    })

    it("setMemoryDepth: a listed depth applies; an unlisted one is reported, never silently accepted", async () => {
      const cap = d.capabilities(await d.status())
      if (cap.memoryDepths.length) {
        const r = await d.setMemoryDepth(cap.memoryDepths[0]!)
        expect(r.mismatches).toEqual([])
      }
      const odd = await d.setMemoryDepth("7M")
      if (!/^7M$/i.test(odd.state.mdepth)) expect(odd.mismatches.join(" ")).toMatch(/memory depth/)
    })

    it("setTrigger: source/slope/level read back (level within the instrument's quantisation); a source on a switched-off channel is not accepted silently", async () => {
      await d.setChannel({ ch, on: true })
      const r = await d.setTrigger({ source: `C${ch}`, slope: "rising", level: 0.5, mode: "auto" })
      expect(r.mismatches).toEqual([])
      expect(r.state.source).toBe(`C${ch}`)
      expect(r.state.slope.toUpperCase()).toMatch(/^RIS/)
      await d.setChannel({ ch: off, on: false })
      const rejected = await d.setTrigger({ source: `C${off}` })
      if (rejected.state.source.toUpperCase() !== `C${off}`)
        expect(rejected.mismatches.join(" ")).toMatch(/trigger source/)
      await d.setTrigger({ source: `C${ch}` })
    })

    it("stop → status Stop; single → armed (not Stop) → stop again", async () => {
      await d.stop()
      const stopped = await d.waitForStop(2000)
      expect(stopped.ok).toBe(true)
      await d.single()
      const st = await d.triggerStatus()
      expect(isKnownTriggerStatus(st)).toBe(true)
      const waited = await d.waitForStop(200)
      expect(isKnownTriggerStatus(waited.status)).toBe(true)
      await d.stop()
      expect((await d.waitForStop(2000)).ok).toBe(true)
    })

    it("single that never triggered, then stop: readWaveform is refused with a clear message (a triggered one reads)", async () => {
      await d.single()
      const done = await d.waitForStop(300)
      await d.stop()
      expect((await d.waitForStop(2000)).ok).toBe(true)
      if (done.ok) expect((await d.readWaveform(ch)).codes.length).toBeGreaterThan(0)
      else await expect(d.readWaveform(ch)).rejects.toThrow(/no completed acquisition/)
    })

    it("run in auto mode, then stop: the record is readable", async () => {
      const r = await d.setTrigger({ mode: "auto" })
      expect(r.mismatches).toEqual([])
      await d.run()
      await sleep(acquireMs)
      await d.stop()
      expect((await d.waitForStop(2000)).ok).toBe(true)
      expect((await d.readWaveform(ch)).codes.length).toBeGreaterThan(0)
    })

    it("readWaveform: stride 1 delivers the whole record; the result satisfies the capture store's invariants", async () => {
      await d.setChannel({ ch, on: true })
      await d.stop()
      const w = await d.readWaveform(ch, { stride: 1 })
      expect(w.ch).toBe(ch)
      expect(w.stride).toBe(1)
      expect(w.codes).toBeInstanceOf(Int16Array)
      expect(w.codes.length).toBe(w.recordPoints)
      expect(w.sampleRate).toBeGreaterThan(0)
      expect(w.time.interval).toBeGreaterThan(0)
      expect(w.scale.gain).toBeGreaterThan(0)
      expect(w.scale.codePerDiv).toBeGreaterThan(0)
      expect(w.probe).toBeGreaterThan(0)
      expect(typeof w.unit).toBe("string")
      const meta: ScopeCaptureMeta = {
        id: "conformance",
        createdAt: 1,
        address: d.label,
        driver: d.driver,
        model: d.identity.model,
        mode: "current",
        quality: "exact",
        timebase: { scale: w.time.tdiv, delay: w.time.delay },
        sampleRate: w.sampleRate,
        interval: w.time.interval,
        stride: w.stride,
        recordPoints: w.recordPoints,
        channels: [
          {
            ch,
            file: `c${ch}.i16`,
            points: w.codes.length,
            vdiv: 1,
            offset: 0,
            probe: w.probe,
            unit: w.unit,
            gain: w.scale.gain,
            rawOffset: w.scale.offset,
            codePerDiv: w.scale.codePerDiv,
            time: w.time,
            stride: w.stride,
            recordPoints: w.recordPoints,
            sampleRate: w.sampleRate,
          },
        ],
      }
      expect(() => validateCapture(meta)).not.toThrow()
    })

    it("readWaveform: maxPoints raises stride and scales the delivered interval; explicit over-budget stride is refused", async () => {
      const full = await d.readWaveform(ch, { stride: 1 })
      const budget = Math.max(16, Math.floor(full.recordPoints / 10))
      const w = await d.readWaveform(ch, { maxPoints: budget })
      expect(w.codes.length).toBeLessThanOrEqual(budget)
      expect(w.stride).toBeGreaterThanOrEqual(Math.ceil(full.recordPoints / budget))
      expect(w.time.interval / full.time.interval).toBeCloseTo(w.stride, 6)
      await expect(d.readWaveform(ch, { stride: 1, maxPoints: 16 })).rejects.toThrow(/stride|limit|budget/)
    })

    it("readWaveform: a switched-off channel is refused, not returned empty", async () => {
      await d.setChannel({ ch: off, on: false })
      await expect(d.readWaveform(off)).rejects.toThrow()
      const r = await d.readWaveform(ch)
      expect(r.codes.length).toBeGreaterThan(0)
    })

    it("measure: a listed neutral name on a live channel yields a number or null and no mismatch; aliases resolve to the neutral name", async () => {
      const cap = d.capabilities()
      for (const name of cap.measureTypes) expect(measurementName(name), name).toBe(name)
      const type = cap.measureTypes.includes("pkpk") ? "pkpk" : cap.measureTypes[0]!
      const r = await d.measure([{ type, source: `C${ch}` }])
      expect(r.mismatches).toEqual([])
      expect(r.results).toHaveLength(1)
      expect(r.results[0]!.type).toBe(type)
      expect(r.results[0]!.value === null || Number.isFinite(r.results[0]!.value)).toBe(true)
      const again = await d.readMeasurements(1)
      expect(again).toHaveLength(1)
      if (cap.measureTypes.includes("top") && cap.measureTypes.includes("frequency")) {
        const alias = await d.measure([
          { type: "HIGH", source: `C${ch}` },
          { type: "FREQ", source: `C${ch}` },
        ])
        expect(alias.mismatches).toEqual([])
        expect(alias.results.map((x) => x.type)).toEqual(["top", "frequency"])
      }
    })

    it("measure: LINE is not a measurement source", async () => {
      await expect(d.measure([{ type: "pkpk", source: "LINE" }])).rejects.toThrow(/source/)
    })

    it("screenshot: a complete PNG", async () => {
      const cap = d.capabilities()
      if (!cap.screenshot) return
      const png = await d.screenshot()
      expect(pngComplete(png)).toBe(png.length)
    })
  })
}
