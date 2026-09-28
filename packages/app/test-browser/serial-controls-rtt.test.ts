import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { render } from "solid-js/web"

const mock = vi.hoisted(() => ({
  ports: vi.fn(),
  execute: vi.fn(),
  create: vi.fn(),
  prompt: vi.fn(),
  call: vi.fn(),
  navigate: vi.fn(),
  params: {} as { id?: string },
  directory: "D:/develop/motor_control/BK64_motor",
}))
vi.mock("@/utils/kernel", () => ({
  kernelAvailable: () => true,
  kernel: {
    instrument: { ports: mock.ports, execute: mock.execute },
    session: { create: mock.create, prompt: mock.prompt },
    call: mock.call,
  },
}))
vi.mock("@solidjs/router", () => ({ useNavigate: () => mock.navigate }))
vi.mock("@/context/sdk", () => ({ useSDK: () => () => ({ directory: mock.directory }) }))
vi.mock("@/pages/session/session-layout", () => ({ useSessionKey: () => ({ params: mock.params }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en" }) }))

import { SerialControls } from "@/pages/session/bench/serial-controls"

const PREFS = "yoma.serial.preferences.v1"
type Details = Record<string, unknown>
const reply = (details: Details = { running: false }) => ({ text: "", details })
const RTT_RUNNING: Details = {
  running: true,
  writable: true,
  source: "rtt STM32G473RC via J-Link SWD 4000 kHz",
  totalLines: 7,
  rtt: { device: "STM32G473RC", speed: 4000, port: 50123 },
}
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
const live = vi.fn()
const changed = vi.fn()
const mount = (props: { chip?: string } = {}) => {
  dispose = render(() => createComponent(SerialControls, { onChange: changed, onLive: live, ...props }), root)
}
const $ = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector)
const connect = () => $<HTMLButtonElement>('[data-slot="connect"]')!
const device = () => $<HTMLInputElement>('[data-slot="device-field"] input')
const source = (which: "serial" | "rtt") =>
  $<HTMLButtonElement>(`[data-slot="source-switch"] [data-source="${which}"]`)!
const fill = (element: HTMLInputElement, value: string) => {
  element.value = value
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
const submit = () => $("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
const prefs = () => JSON.parse(localStorage.getItem(PREFS) ?? "{}")[mock.directory]

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  const [params, update] = createStore<{ id?: string }>({})
  mock.params = params
  setParams = update
  mock.ports.mockResolvedValue([{ path: "COM5", description: "STLink Virtual COM Port" }])
  mock.create.mockResolvedValue({ id: "created-manual", directory: mock.directory })
  mock.execute.mockResolvedValue(reply())
  mock.call.mockResolvedValue({ profile: { chip: "" } })
  root = document.createElement("div")
  document.body.append(root)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  root.remove()
  vi.useRealTimers()
})

describe("source switch", () => {
  test("serial is the default; RTT swaps port/baud for device/speed and is remembered per project", async () => {
    mount()
    await flush()
    expect(source("serial").getAttribute("aria-pressed")).toBe("true")
    expect($('[data-slot="port-field"]')).not.toBeNull()
    expect(device()).toBeNull()
    source("rtt").click()
    await flush()
    expect(source("rtt").getAttribute("aria-pressed")).toBe("true")
    expect($('[data-slot="port-field"]')).toBeNull()
    expect($('[data-slot="baud-field"]')).toBeNull()
    expect(device()).not.toBeNull()
    expect($<HTMLInputElement>('[data-slot="speed-field"] input')!.value).toBe("4000")
    expect(prefs().mode).toBe("rtt")
    // 没填器件名时连接按不下去;什么都没往内核发
    expect(connect().disabled).toBe(true)
    expect(mock.execute).not.toHaveBeenCalled()
    dispose!()
    mount()
    await flush()
    expect(source("rtt").getAttribute("aria-pressed")).toBe("true")
  })

  test("the speed preset popup lists readable kHz options", async () => {
    mount()
    await flush()
    source("rtt").click()
    await flush()
    const picker = $<HTMLSelectElement>('[data-slot="speed-field"] select')!
    expect([...picker.options].map((option) => option.textContent)).toContain("4000 kHz")
    picker.value = "1000"
    picker.dispatchEvent(new Event("change", { bubbles: true }))
    expect($<HTMLInputElement>('[data-slot="speed-field"] input')!.value).toBe("1000")
    expect(picker.value).toBe("")
  })
})

describe("RTT device prefill", () => {
  test("an exact chip from the flash tool fills the field (J-Link spelling) without asking the project", async () => {
    mount({ chip: "STM32G473RCT6" })
    source("rtt").click()
    await flush()
    expect(device()!.value).toBe("STM32G473RC")
    expect(mock.call).not.toHaveBeenCalled()
  })

  test("otherwise the project profile is asked once and its CubeMX name is shortened", async () => {
    mock.call.mockResolvedValue({ profile: { chip: "STM32G473RCTx" } })
    mount({ chip: "stm32g4x" })
    source("rtt").click()
    await vi.waitFor(() => expect(device()!.value).toBe("STM32G473RC"))
    expect(mock.call).toHaveBeenCalledExactlyOnceWith("project.context", { directory: mock.directory })
    source("serial").click()
    source("rtt").click()
    await flush()
    expect(mock.call).toHaveBeenCalledOnce()
  })

  test("a CubeMX family name is only a placeholder hint; typing it anyway is refused locally", async () => {
    mock.call.mockResolvedValue({ profile: { chip: "STM32G473R(B-C-E)Tx" } })
    mount()
    source("rtt").click()
    await vi.waitFor(() => expect(device()!.placeholder).toContain("STM32G473R(B-C-E)Tx"))
    expect(device()!.value).toBe("")
    expect(connect().disabled).toBe(true)
    fill(device()!, "STM32G473R(B-C-E)Tx")
    submit()
    expect($('[role="alert"]')?.textContent).toContain("CubeMX family name")
    expect(mock.execute).not.toHaveBeenCalled()
    expect(mock.create).not.toHaveBeenCalled()
  })

  test("a saved device wins over the detected chip, and a cleared field is not refilled", async () => {
    localStorage.setItem(PREFS, JSON.stringify({ [mock.directory]: { mode: "rtt", device: "STM32G474RE" } }))
    mount({ chip: "STM32G473RC" })
    await flush()
    expect(device()!.value).toBe("STM32G474RE")
    fill(device()!, "")
    await flush()
    expect(device()!.value).toBe("")
  })
})

describe("RTT connection", () => {
  test("connect starts an rtt capture with the device and speed; the running capture is writable", async () => {
    let running = false
    mock.execute.mockImplementation(({ input }: { input: { action: string } }) => {
      if (input.action === "start") running = true
      if (input.action === "stop") running = false
      return Promise.resolve(reply(running ? RTT_RUNNING : { running: false }))
    })
    mount({ chip: "STM32G473RC" })
    source("rtt").click()
    await flush()
    fill($<HTMLInputElement>('[data-slot="speed-field"] input')!, "1000")
    submit()
    await vi.waitFor(() => expect(connect().textContent).toBe("Disconnect"))
    expect(mock.execute).toHaveBeenCalledWith({
      sessionID: "created-manual",
      tool: "log",
      input: { action: "start", rtt: "STM32G473RC", rttSpeed: 1000 },
    })
    expect($('[data-slot="readout"]')!.textContent).toContain("rtt STM32G473RC via J-Link SWD 4000 kHz")
    expect($('[data-slot="readout"]')!.textContent).toContain("RX 7 lines")
    expect($<HTMLInputElement>('[data-slot="send-input"]')!.placeholder).toContain("RTT channel 0")
    // 连着时换不了来源
    expect(source("serial").disabled).toBe(true)
    expect(live).toHaveBeenLastCalledWith("created-manual")
    submit()
    await vi.waitFor(() => expect(connect().textContent).toBe("Connect"))
    expect(mock.execute).toHaveBeenCalledWith({ sessionID: "created-manual", tool: "log", input: { action: "stop" } })
    expect(live).toHaveBeenLastCalledWith(undefined)
    expect(mock.prompt).not.toHaveBeenCalled()
  })

  test("an invalid SWD speed stays local", async () => {
    mount({ chip: "STM32G473RC" })
    source("rtt").click()
    await flush()
    fill($<HTMLInputElement>('[data-slot="speed-field"] input')!, "60000")
    submit()
    expect($('[role="alert"]')?.textContent).toContain("SWD speed")
    expect(mock.execute).not.toHaveBeenCalled()
  })

  test("a slow RTT start can be cancelled; the late start failure is not shown", async () => {
    const start = deferred<ReturnType<typeof reply>>()
    mock.execute.mockImplementation(({ input }: { input: { action: string } }) =>
      input.action === "start" ? start.promise : Promise.resolve(reply({ running: false, action: "stop" })),
    )
    mount({ chip: "STM32G473RC" })
    source("rtt").click()
    await flush()
    submit()
    await vi.waitFor(() => expect(connect().textContent).toBe("Cancel"))
    expect(connect().disabled).toBe(false)
    expect($('[data-slot="readout"]')!.textContent).toBe("Connecting…")
    submit()
    await vi.waitFor(() =>
      expect(mock.execute).toHaveBeenCalledWith({
        sessionID: "created-manual",
        tool: "log",
        input: { action: "stop" },
      }),
    )
    start.reject(new Error("log start: stopped while the J-Link GDB server was starting"))
    await vi.waitFor(() => expect(connect().textContent).toBe("Connect"))
    expect($('[role="alert"]')).toBeNull()
    expect(connect().disabled).toBe(false)
  })

  test("an RTT capture the agent started shows up: source switches to RTT and the device is filled", async () => {
    setParams("id", "agent-session")
    mock.execute.mockResolvedValue(reply({ ...RTT_RUNNING, rtt: { device: "STM32G473RC", speed: 2000, port: 19021 } }))
    mount()
    await vi.waitFor(() => expect(source("rtt").getAttribute("aria-pressed")).toBe("true"))
    expect(device()!.value).toBe("STM32G473RC")
    expect(device()!.disabled).toBe(true)
    expect($<HTMLInputElement>('[data-slot="speed-field"] input')!.value).toBe("2000")
    expect($('[data-slot="send-bar"]')).not.toBeNull()
    expect(live).toHaveBeenLastCalledWith("agent-session")
    // 卸载时把实时交回去
    dispose!()
    dispose = undefined
    expect(live).toHaveBeenLastCalledWith(undefined)
  })

  test("serial mode still starts a serial capture exactly as before", async () => {
    localStorage.setItem(PREFS, JSON.stringify({ [mock.directory]: { mode: "rtt", device: "STM32G473RC" } }))
    mount()
    await flush()
    source("serial").click()
    await vi.waitFor(() => expect(connect().disabled).toBe(false))
    submit()
    await vi.waitFor(() =>
      expect(mock.execute).toHaveBeenCalledWith({
        sessionID: "created-manual",
        tool: "log",
        input: { action: "start", port: "COM5", baud: 115200 },
      }),
    )
  })
})
