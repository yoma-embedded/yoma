import { describe, expect, test, vi } from "vitest"
const mock = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock("@/utils/kernel", () => ({ kernel: { instrument: { execute: mock.execute } } }))
import { executeInstrument, instrumentObservations } from "./instrument-state"
import { deriveBenchStatus, EMPTY_BENCH_STATUS } from "./bench-status"

describe("manual instrument observations", () => {
  test("live replies update the workbench without adding chat messages and stay scoped to their session", async () => {
    mock.execute.mockResolvedValue({
      text: "capturing",
      details: {
        action: "start",
        running: true,
        source: "serial /dev/test @ 921600 8N1",
        totalLines: 2,
        dropped: 0,
      },
    })
    await executeInstrument({
      sessionID: "live-serial",
      tool: "log",
      input: { action: "start", port: "/dev/test", baud: 921600 },
    })
    const observations = instrumentObservations("live-serial", EMPTY_BENCH_STATUS)
    const live = deriveBenchStatus(observations)
    expect(live.log).toMatchObject({ capturing: true, port: "/dev/test", baud: 921600 })
    expect(instrumentObservations("unrelated", EMPTY_BENCH_STATUS)).toEqual([])
    expect(instrumentObservations(undefined, EMPTY_BENCH_STATUS)).toEqual([])
    expect(instrumentObservations("live-serial", { ...live, log: { ...live.log!, at: Date.now() + 10000 } })).toEqual(
      [],
    )
  })

  test("disconnect replaces optional connection fields rather than merging a stale target into a new reply", async () => {
    mock.execute.mockResolvedValueOnce({
      text: "attached",
      details: { state: "halted", connection: "localhost:3333", epoch: 1, stopId: 1 },
    })
    await executeInstrument({ sessionID: "live-debug", tool: "gdb", input: { action: "start" } })
    mock.execute.mockResolvedValueOnce({ text: "closed", details: { state: "no-session", epoch: 0, stopId: 0 } })
    await executeInstrument({ sessionID: "live-debug", tool: "gdb", input: { action: "stop" } })
    const observations = instrumentObservations("live-debug", EMPTY_BENCH_STATUS)
    expect(observations).toHaveLength(1)
    expect(deriveBenchStatus(observations).gdb).toMatchObject({ state: "none" })
    expect(deriveBenchStatus(observations).gdb?.connection).toBeUndefined()
  })
})
