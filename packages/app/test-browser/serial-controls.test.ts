import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { render } from "solid-js/web"

const mock = vi.hoisted(() => ({
  ports: vi.fn(),
  execute: vi.fn(),
  create: vi.fn(),
  prompt: vi.fn(),
  navigate: vi.fn(),
  params: {} as { id?: string },
  directory: "/demo/serial-workbench",
}))
vi.mock("@/utils/kernel", () => ({
  kernelAvailable: () => true,
  kernel: {
    instrument: { ports: mock.ports, execute: mock.execute },
    session: { create: mock.create, prompt: mock.prompt },
  },
}))
vi.mock("@solidjs/router", () => ({ useNavigate: () => mock.navigate }))
vi.mock("@/context/sdk", () => ({ useSDK: () => () => ({ directory: mock.directory }) }))
vi.mock("@/pages/session/session-layout", () => ({ useSessionKey: () => ({ params: mock.params }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en" }) }))

import { SerialControls } from "@/pages/session/bench/serial-controls"

type Result = { text: string; details: { running: boolean; source: string; totalLines: number } }
const result = (running = false, source = "", totalLines = 0): Result => ({
  text: "",
  details: { running, source, totalLines },
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
let root: HTMLDivElement
let dispose: (() => void) | undefined
let setParams: SetStoreFunction<{ id?: string }>
const changed = vi.fn()
const mount = () => {
  dispose = render(() => createComponent(SerialControls, { onChange: changed }), root)
}
const fill = (selector: string, value: string) => {
  const input = root.querySelector<HTMLInputElement>(selector)!
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
const submit = () => root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
const connect = () => root.querySelector<HTMLButtonElement>('[data-slot="connect"]')!
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  const [params, update] = createStore<{ id?: string }>({})
  mock.params = params
  setParams = update
  mock.directory = "/demo/serial-workbench"
  mock.ports.mockResolvedValue([{ path: "/dev/tty-demo", description: "Simulated port" }])
  mock.create.mockResolvedValue({ id: "created-manual", directory: mock.directory })
  mock.execute.mockResolvedValue(result())
  root = document.createElement("div")
  document.body.append(root)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  root.remove()
  vi.useRealTimers()
})

describe("standalone serial controls", () => {
  test("preset pickers stay blank so the first baud is not painted as the current value", async () => {
    mount()
    await flush()
    const baud = root.querySelector<HTMLSelectElement>('[data-slot="baud-field"] select')!
    const port = root.querySelector<HTMLSelectElement>('[data-slot="port-field"] select')!
    expect(baud.value).toBe("")
    expect(port.value).toBe("")
    expect(baud.options[0]?.hidden).toBe(true)
    expect(port.options[0]?.hidden).toBe(true)
    expect(root.querySelector<HTMLInputElement>('[data-slot="baud-field"] input')!.value).toBe("115200")
    expect(baud.selectedOptions[0]?.textContent ?? "").toBe("")
  })

  test("typing port and baud in a draft only edits the form; it does not create a session, run a tool, or prompt a model", async () => {
    mount()
    await vi.waitFor(() => expect(mock.ports).toHaveBeenCalledOnce())
    fill('[data-slot="port-field"] input', "/dev/tty-custom")
    fill('[data-slot="baud-field"] input', "230400")
    await flush()
    expect(mock.create).not.toHaveBeenCalled()
    expect(mock.execute).not.toHaveBeenCalled()
    expect(mock.prompt).not.toHaveBeenCalled()
    expect(connect().textContent).toBe("Connect")
  })

  test("explicit connect and disconnect use typed log operations without any model setup", async () => {
    let running = false
    mock.execute.mockImplementation(({ input }: { input: { action: string } }) => {
      if (input.action === "start") running = true
      if (input.action === "stop") running = false
      return Promise.resolve(running ? result(true, "serial /dev/tty-demo @ 230400 8N1", 12) : result())
    })
    mount()
    await vi.waitFor(() => expect(connect().disabled).toBe(false))
    fill('[data-slot="baud-field"] input', "230400")
    submit()
    await vi.waitFor(() => expect(connect().textContent).toBe("Disconnect"))
    expect(mock.create).toHaveBeenCalledExactlyOnceWith({ directory: mock.directory })
    expect(mock.execute).toHaveBeenCalledWith({
      sessionID: "created-manual",
      tool: "log",
      input: { action: "start", port: "/dev/tty-demo", baud: 230400 },
    })
    expect(root.textContent).toContain("serial /dev/tty-demo @ 230400 8N1")
    expect(root.textContent).toContain("12 lines")
    expect(mock.navigate).toHaveBeenCalledWith("/session/created-manual")
    submit()
    await vi.waitFor(() =>
      expect(mock.execute).toHaveBeenCalledWith({
        sessionID: "created-manual",
        tool: "log",
        input: { action: "stop" },
      }),
    )
    expect(mock.create).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(connect().textContent).toBe("Connect"))
    expect(mock.prompt).not.toHaveBeenCalled()
  })

  test("invalid baud is rejected locally before any instrument or session request", async () => {
    mount()
    await vi.waitFor(() => expect(connect().disabled).toBe(false))
    fill('[data-slot="baud-field"] input', "115200.5")
    submit()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("integer baud rate")
    expect(mock.create).not.toHaveBeenCalled()
    expect(mock.execute).not.toHaveBeenCalled()
  })

  test("a late status reply cannot show the previous session's serial capture", async () => {
    vi.useFakeTimers()
    const old = deferred<Result>()
    setParams("id", "old-status")
    mock.execute.mockImplementation(({ sessionID }: { sessionID: string }) =>
      sessionID === "old-status" ? old.promise : Promise.resolve(result()),
    )
    mount()
    await flush()
    expect(mock.execute).toHaveBeenCalledWith({ sessionID: "old-status", tool: "log", input: { action: "status" } })
    setParams("id", "new-status")
    old.resolve(result(true, "OLD PRIVATE PORT", 99))
    await flush()
    expect(root.textContent).not.toContain("OLD PRIVATE PORT")
    expect(connect().textContent).toBe("Connect")
    await vi.advanceTimersByTimeAsync(2000)
    expect(mock.execute).toHaveBeenCalledWith({ sessionID: "new-status", tool: "log", input: { action: "status" } })
    expect(mock.prompt).not.toHaveBeenCalled()
  })

  test.each(["resolve", "reject"] as const)(
    "a late draft connection %s cannot change or navigate the newly selected session",
    async (outcome) => {
      const pending = deferred<Result>()
      mock.execute.mockImplementation(({ input }: { input: { action: string } }) =>
        input.action === "start" ? pending.promise : Promise.resolve(result()),
      )
      mount()
      await vi.waitFor(() => expect(connect().disabled).toBe(false))
      submit()
      await vi.waitFor(() =>
        expect(mock.execute).toHaveBeenCalledWith(
          expect.objectContaining({ input: expect.objectContaining({ action: "start" }) }),
        ),
      )
      setParams("id", "selected-while-connecting")
      if (outcome === "resolve") pending.resolve(result(true, "OLD CONNECTION", 100))
      else pending.reject(new Error("OLD CONNECTION ERROR"))
      await flush()
      expect(root.textContent).not.toContain("OLD CONNECTION")
      expect(root.querySelector('[role="alert"]')).toBeNull()
      expect(connect().textContent).toBe("Connect")
      expect(connect().disabled).toBe(false)
      expect(changed).not.toHaveBeenCalled()
      expect(mock.navigate).not.toHaveBeenCalled()
      expect(mock.prompt).not.toHaveBeenCalled()
    },
  )

  test("a connection that finishes after unmount cannot navigate back into its old workspace", async () => {
    const pending = deferred<Result>()
    mock.execute.mockImplementation(({ input }: { input: { action: string } }) =>
      input.action === "start" ? pending.promise : Promise.resolve(result()),
    )
    mount()
    await vi.waitFor(() => expect(connect().disabled).toBe(false))
    submit()
    await vi.waitFor(() =>
      expect(mock.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ action: "start" }),
        }),
      ),
    )
    dispose?.()
    dispose = undefined
    pending.resolve(result(true, "UNMOUNTED CONNECTION", 1))
    await flush()
    expect(mock.navigate).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(mock.prompt).not.toHaveBeenCalled()
  })
})

describe("serial send bar", () => {
  const send = () => root.querySelector<HTMLButtonElement>('[data-slot="send"]')!
  const tx = () => root.querySelector<HTMLInputElement>('[data-slot="send-input"]')!
  const transmit = () =>
    root
      .querySelector('[data-slot="send-form"]')!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  const select = (selector: string, value: string) => {
    const element = root.querySelector<HTMLSelectElement>(selector)!
    element.value = value
    element.dispatchEvent(new Event("change", { bubbles: true }))
  }
  const online = async () => {
    setParams("id", "serial-tx")
    mock.execute.mockResolvedValue({
      text: "",
      details: { running: true, writable: true, source: "serial fixture", totalLines: 0, bytesSent: 8 },
    })
    mount()
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[data-slot="ctrl-c"]')!.disabled).toBe(false))
  }

  test("typing alone sends nothing; presets and custom values are editable and persisted", async () => {
    mount()
    await flush()
    fill('[data-slot="send-input"]', "status")
    select('[data-slot="baud-field"] select', "74880")
    expect(root.querySelector<HTMLInputElement>('[data-slot="baud-field"] input')!.value).toBe("74880")
    fill('[data-slot="baud-field"] input', "123456")
    fill('[data-slot="port-field"] input', "/dev/custom")
    expect(send().disabled).toBe(true)
    transmit()
    expect(mock.execute).not.toHaveBeenCalled()
    expect(mock.create).not.toHaveBeenCalled()
    dispose!()
    mount()
    expect(root.querySelector<HTMLInputElement>('[data-slot="baud-field"] input')!.value).toBe("123456")
    expect(root.querySelector<HTMLInputElement>('[data-slot="port-field"] input')!.value).toBe("/dev/custom")
    expect(tx().value).toBe("")
  })

  test("text sends the selected line ending, clears only on success, and recalls command history", async () => {
    await online()
    select('[data-slot="ending-field"] select', "crlf")
    fill('[data-slot="send-input"]', "你好")
    transmit()
    await vi.waitFor(() => expect(tx().value).toBe(""))
    expect(mock.execute).toHaveBeenCalledWith({
      sessionID: "serial-tx",
      tool: "log",
      input: { action: "write", data: "你好", encoding: "text", lineEnding: "crlf" },
    })
    fill('[data-slot="send-input"]', "draft")
    tx().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))
    expect(tx().value).toBe("你好")
    tx().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    expect(tx().value).toBe("draft")
    expect(mock.prompt).not.toHaveBeenCalled()
  })

  test("invalid hex stays local, failed sends preserve input, and Ctrl+C sends exactly 03 without clearing the draft", async () => {
    await online()
    select('[data-slot="send-form"] select', "hex")
    fill('[data-slot="send-input"]', "F")
    transmit()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("byte pairs")
    expect(mock.execute.mock.calls.filter(([p]) => p.input.action === "write")).toHaveLength(0)
    fill('[data-slot="send-input"]', "00 FF")
    mock.execute.mockImplementation(({ input }) =>
      input.action === "write"
        ? Promise.reject(new Error("Device unplugged"))
        : Promise.resolve({ details: { running: true, writable: true } }),
    )
    transmit()
    await vi.waitFor(() => expect(root.textContent).toContain("Device unplugged"))
    expect(tx().value).toBe("00 FF")
    await vi.waitFor(() => expect(send().disabled).toBe(false))
    mock.execute.mockResolvedValue({ details: { running: true, writable: true, bytesSent: 1 } })
    select('[data-slot="ending-field"] select', "crlf")
    root.querySelector<HTMLButtonElement>('[data-slot="ctrl-c"]')!.click()
    await vi.waitFor(() =>
      expect(mock.execute).toHaveBeenCalledWith({
        sessionID: "serial-tx",
        tool: "log",
        input: { action: "write", data: "03", encoding: "hex", lineEnding: "none" },
      }),
    )
    expect(tx().value).toBe("00 FF")
    expect(mock.prompt).not.toHaveBeenCalled()
  })
})
