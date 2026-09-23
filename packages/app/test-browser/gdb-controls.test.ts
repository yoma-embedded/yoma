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
/** 工具条是图标按钮:按 aria-label 找(测试里的 t 只回键名的最后一段)。 */
const button = (label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
/** 状态行上那个词(halted / running / connection-lost …)。 */
const stateWord = () => root.querySelector('[data-slot="where"] strong')?.textContent ?? ""
/** 调试控制台里的一行。 */
const entries = (kind?: string) =>
  [...root.querySelectorAll(`[data-slot="entry"]${kind ? `[data-kind="${kind}"]` : ""}`)].map((e) => e.textContent)
const typeConsole = (line: string) => {
  fill('form[data-slot="prompt"] input', line)
  root
    .querySelector('form[data-slot="prompt"]')!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
}
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
    // 缺省「连接后运行到 main」:连上之后跟着一个临时断点 + continue,整串占一次 pending。
    await vi.waitFor(() => expect(mock.run).toHaveBeenCalledTimes(3))
    expect(mock.run).toHaveBeenNthCalledWith(2, "gdb", { action: "break", at: "main", temporary: true })
    expect(mock.run).toHaveBeenNthCalledWith(3, "gdb", { action: "exec", op: "continue", waitMs: 10_000 })
    await vi.waitFor(() => expect(stateWord()).toBe("halted"))
    // 按钮做的事照 gdb 的写法记进控制台
    expect(entries("cmd")).toContain("(gdb) tbreak main")
  })

  test("continue leaves the target running after a short response window; the console still answers", async () => {
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
    // 人亲手敲的一行原样交给 gdb(带 write:手动这条路没有确认门,敲 set var 就是要改)。
    await vi.waitFor(() => expect(button("continue").disabled).toBe(false))
    typeConsole("info registers")
    await vi.waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith("gdb", { action: "eval", command: "info registers", write: true }),
    )
    expect(entries("cmd")).toContain("(gdb) info registers")
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

  test("background connection changes replace the state without erasing a manual command error", async () => {
    vi.useFakeTimers()
    mock.params = { id: "session-status" }
    mock.execute.mockResolvedValue(result("running", "Target running"))
    mount()
    await vi.advanceTimersByTimeAsync(0)
    expect(stateWord()).toBe("running")
    mock.execute.mockResolvedValue(result("connection-lost", "Connection lost"))
    await vi.advanceTimersByTimeAsync(2500)
    expect(stateWord()).toBe("connection-lost")
    // 掉线之后运行控制全灰,「断开」还按得动(gdb 与 server 要 stop 才放手)
    expect(button("continue").disabled).toBe(true)
    expect(button("disconnect").disabled).toBe(false)
    mock.run.mockRejectedValueOnce(new Error("Disconnect failed"))
    button("disconnect").click()
    await vi.advanceTimersByTimeAsync(100)
    expect(entries("err").join("\n")).toContain("Disconnect failed")
    // 之后的后台轮询只换状态,不冲掉那条错误
    await vi.advanceTimersByTimeAsync(2600)
    expect(entries("err").join("\n")).toContain("Disconnect failed")
    expect(root.querySelector('[role="log"]')).not.toBeNull()
  })
})
