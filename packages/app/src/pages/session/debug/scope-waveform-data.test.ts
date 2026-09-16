import { describe, expect, test } from "vitest"
import { scopeCursor, scopeTicks, scopeValue, scopeVoltageRange, scopeWindow, type ScopeTrace } from "./scope-waveform-data"

const trace: ScopeTrace = { ch: 1, unit: "V", exact: false, points: [{ t: -1, min: -0.02, max: 0.01 }, { t: 0, min: -0.1, max: 3.8 }, { t: 1, min: 3.2, max: 3.3 }] }

describe("saved oscilloscope view", () => {
  test("pre-trigger pan and zoom stay inside the saved window", () => {
    expect(scopeWindow(-9, -8, -2, 2, 0.1)).toEqual({ from: -2, to: -1 })
    expect(scopeWindow(1.5, 3.5, -2, 2, 0.1)).toEqual({ from: 0, to: 2 })
    expect(scopeWindow(-9, 9, -2, 2, 0.1)).toEqual({ from: -2, to: 2 })
  })
  test("envelope cursors retain narrow glitches instead of reporting an invented midpoint", () => {
    expect(scopeCursor(trace, 0.01, -1, 1)).toEqual({ t: 0, min: -0.1, max: 3.8 })
    expect(scopeCursor(trace, 2, -1, 1)).toBeUndefined()
    expect(scopeCursor({ ...trace, points: [] }, 0, -1, 1)).toBeUndefined()
  })
  test("exact cursors snap to an actual stored sample, including before trigger", () => {
    expect(scopeCursor({ ...trace, exact: true }, -0.8, -1, 1)?.t).toBe(-1)
  })
  test("shared vertical scale includes peaks and constant or negative signals", () => {
    expect(scopeVoltageRange([trace]).max).toBeGreaterThan(3.8)
    expect(scopeVoltageRange([trace]).min).toBeLessThan(-0.1)
    expect(scopeVoltageRange([{ ...trace, points: [{ t: 0, min: -3.3, max: -3.3 }] }]).max).toBeGreaterThan(-3.3)
    expect(scopeVoltageRange([])).toEqual({ min: -1, max: 1 })
  })
  test("seconds and voltages retain useful engineering units", () => {
    expect(scopeValue(-0.000002, "s")).toBe("-2 µs")
    expect(scopeValue(0.024)).toBe("24 mV")
    expect(scopeValue(Number.NaN)).toBe("—")
    expect(scopeTicks(-2e-6, 2e-6, 4)).toContain(0)
  })
})
