import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"

const mock = vi.hoisted(() => ({
  execute: vi.fn(),
  run: vi.fn(),
  params: {} as { id?: string },
  status: {} as Record<string, { type: string }>,
}))
vi.mock("@/utils/kernel", () => ({ kernel: { instrument: { execute: mock.execute } } }))
vi.mock("@/pages/session/bench/instrument-session", () => ({ createInstrumentSession: () => ({ run: mock.run }) }))
vi.mock("@/pages/session/bench/use-bench-status", () => ({ useBenchToolParts: () => () => [] }))
vi.mock("@/pages/session/session-layout", () => ({ useSessionKey: () => ({ params: mock.params }) }))
vi.mock("@/context/sync", () => ({ useSync: () => () => ({ data: { session_status: mock.status } }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key.split(".").at(-1) }) }))

import { GdbControls } from "@/pages/session/bench/gdb-controls"

let root: HTMLDivElement
let dispose: (() => void) | undefined
const mount = () => {
  dispose = render(() => createComponent(GdbControls, {}), root)
}
const fill = (selector: string, value: string) => {
  const input = root.querySelector<HTMLInputElement>(selector)!
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
const button = (text: string) =>
  [...root.querySelectorAll("button")].find((item) => item.textContent?.trim().endsWith(text))!
const result = (state: string, text = "stop report") => ({ text, details: { state, epoch: 1, stopId: 1 } })

beforeEach(() => {
  vi.clearAllMocks()
  mock.params = {}
  mock.status = {}
  mock.execute.mockResolvedValue(result("no-session"))
  mock.run.mockResolvedValue(result("halted"))
  root = document.createElement("div")
  document.body.append(root)
})
afterEach(() => {
  dispose?.()
  root.remove()
  vi.useRealTimers()
})

describe("manual GDB controls", () => {
  test("typing connection parameters never creates a session or runs a tool; explicit connect uses typed GDB input", async () => {
    mount()
    fill('[data-slot="elf"] input', "build/board.elf")
    await Promise.resolve()
    expect(mock.execute).not.toHaveBeenCalled()
    expect(mock.run).not.toHaveBeenCalled()
    root
      .querySelector('form[data-slot="connect"]')!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith("gdb", {
        action: "start",
        server: "external",
        connect: "localhost:3333",
        elfPath: "build/board.elf",
        allowUnverified: false,
      }),
    )
    expect(root.textContent).toContain("halted")
  })

  test("continue leaves the target running after a short response window; inspection remains read-only", async () => {
    mock.params = { id: "session-a" }
    mock.execute.mockResolvedValue(result("halted"))
    mount()
    await vi.waitFor(() => expect(button("continue").disabled).toBe(false))
    button("continue").click()
    await vi.waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith("gdb", {
        action: "exec",
        op: "continue",
        waitMs: 100,
        onTimeout: "leave-running",
        expectRunning: true,
      }),
    )
    await vi.waitFor(() => expect(button("evaluate").disabled).toBe(true))
    fill('input[aria-label="evaluate"]', "info registers")
    button("evaluate")
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(mock.run).toHaveBeenCalledWith("gdb", { action: "eval", command: "info registers" }))
  })

  test("a late status reply from the previous session cannot expose its target in the new session", async () => {
    let resolveOld!: (value: ReturnType<typeof result>) => void
    mock.execute.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve
      }),
    )
    const [params, setParams] = createStore({ id: "old" })
    mock.params = params
    mount()
    await vi.waitFor(() => expect(mock.execute).toHaveBeenCalled())
    setParams("id", "new")
    resolveOld(result("halted", "old secret report"))
    await Promise.resolve()
    await Promise.resolve()
    expect(root.textContent).not.toContain("old secret report")
    expect(root.querySelector('[data-slot="run-controls"]')).toBeNull()
  })

  test("background connection changes replace the report without erasing a manual command error", async () => {
    vi.useFakeTimers()
    mock.params = { id: "session-status" }
    mock.execute.mockResolvedValue(result("running", "Target running"))
    mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(root.querySelector('[data-slot="output"]')?.textContent).toContain("Target running")
    mock.execute.mockResolvedValue(result("connection-lost", "Connection lost"))
    await vi.advanceTimersByTimeAsync(2500)
    expect(root.querySelector('[data-slot="output"]')?.textContent).toContain("Connection lost")
    mock.run.mockRejectedValueOnce(new Error("Disconnect failed"))
    button("disconnect").click()
    await vi.advanceTimersByTimeAsync(100)
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Disconnect failed")
  })
})
