import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import type { KernelEvent, ScopeCaptureInfo, ScopeViewResult } from "@yoma-desktop/kernel"

const mock = vi.hoisted(() => ({
  captures: vi.fn(), view: vi.fn(), screenshot: vi.fn(), dialog: vi.fn(),
  listen: vi.fn(), handler: undefined as ((event: KernelEvent) => void) | undefined,
  locale: "zh", resize: undefined as (() => void) | undefined,
}))
vi.mock("@/utils/kernel", () => ({ kernel: { scope: { captures: mock.captures, view: mock.view, screenshot: mock.screenshot } } }))
vi.mock("@/context/sdk", () => ({ useSDK: () => () => ({ directory: "/project" }) }))
vi.mock("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ event: { listen: mock.listen } }) }))
vi.mock("@/context/language", () => ({ useLanguage: () => ({ locale: () => mock.locale }) }))
vi.mock("@yoma-desktop/ui/context/dialog", () => ({ useDialog: () => ({ show: mock.dialog }) }))
vi.mock("@solid-primitives/resize-observer", () => ({ createResizeObserver: (_target: unknown, callback: () => void) => { mock.resize = callback } }))

import { ScopeBody } from "@/pages/session/debug/scope-body"

const capture = (id: string): ScopeCaptureInfo => ({
  id, dir: `/project/.yoma/scope/${id}`, createdAt: 1000, address: "usb:TEST", model: "SDS824X HD", serial: "TEST",
  mode: "single", quality: "exact", from: -1, to: 1, screenshot: { createdAt: 1001 },
  trigger: { status: "Stop" },
  channels: [{ ch: 1, unit: "V", probe: 10, vdiv: 1, offset: 0, points: 3, recordPoints: 3, stride: 1, interval: 1, t0: -1 }],
})
const view = (c: ScopeCaptureInfo, from = -1, to = 1): ScopeViewResult => ({
  capture: c, from, to, columns: 16,
  channels: [{ ch: 1, unit: "V", exact: true, points: [{ t: -1, min: 0, max: 0 }, { t: 0, min: 3.3, max: 3.3 }, { t: 1, min: 0, max: 0 }] }],
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
let dispose: (() => void) | undefined
let root: HTMLDivElement
const button = (label: string) => [...root.querySelectorAll("button")].find((entry) => entry.textContent === label)!
const select = () => root.querySelector<HTMLSelectElement>('select[aria-label="选择示波器历史采集"]')!

const prepareWaveform = async (locale = "zh", width = 720) => {
  dispose?.()
  mock.locale = locale
  const recorded = capture("interactive")
  recorded.channels[0] = { ...recorded.channels[0], points: 2001, recordPoints: 2001, interval: 0.001 }
  mock.captures.mockResolvedValue([recorded])
  mock.view.mockReset().mockImplementation(({ from, to }: { from: number; to: number }) => Promise.resolve(view(recorded, from, to)))
  const ctx = {
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillText: vi.fn(), save: vi.fn(), rect: vi.fn(), clip: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), fillRect: vi.fn(),
  }
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  dispose = render(() => createComponent(ScopeBody, {}), root)
  await vi.waitFor(() => expect(mock.view).toHaveBeenCalledTimes(1))
  const waveform = root.querySelector<HTMLElement>('[data-component="scope-waveform"]')!
  Object.defineProperty(waveform, "clientWidth", { value: width })
  mock.resize?.()
  await vi.waitFor(() => expect(mock.view).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(ctx.lineTo).toHaveBeenCalled())
  const canvas = waveform.querySelector("canvas")!
  Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() })
  mock.view.mockClear()
  ctx.clearRect.mockClear()
  return { waveform, canvas, ctx }
}

beforeEach(() => {
  vi.clearAllMocks()
  mock.handler = undefined
  mock.locale = "zh"
  mock.resize = undefined
  mock.listen.mockImplementation((handler: (event: KernelEvent) => void) => { mock.handler = handler; return () => { mock.handler = undefined } })
  mock.captures.mockResolvedValue([capture("first")])
  mock.view.mockResolvedValue(view(capture("first")))
  mock.screenshot.mockResolvedValue({ url: "data:image/png;base64,AAAA", createdAt: 1001 })
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
  root = document.createElement("div")
  document.body.append(root)
  dispose = render(() => createComponent(ScopeBody, {}), root)
})
afterEach(() => { dispose?.(); root.remove(); vi.restoreAllMocks() })

describe("saved oscilloscope panel", () => {
  test("reads a historical waveform and screenshot without any instrument command", async () => {
    await vi.waitFor(() => expect(mock.view).toHaveBeenCalled())
    expect(root.textContent).toContain("历史采集")
    expect(root.textContent).toContain("触发状态（采集时）Stop")
    expect(root.textContent).toContain("单次触发采集")
    expect(root.textContent).toContain("未抽样")
    expect(root.textContent).not.toContain("stride")
    button("查看仪器截图").click()
    await vi.waitFor(() => expect(root.querySelector('img[alt="示波器仪器截图"]')).not.toBeNull())
    expect(mock.screenshot).toHaveBeenCalledWith(capture("first").dir)
    root.querySelector<HTMLButtonElement>('button[aria-label="放大波形"]')!.click()
    await vi.waitFor(() => expect(mock.view).toHaveBeenCalledTimes(2))
    expect(mock.captures).toHaveBeenCalledWith("/project")
  })

  test("completion refresh keeps a selected capture; a missing file is never replaced by the newest capture", async () => {
    await vi.waitFor(() => expect(select().value).toBe(capture("first").dir))
    mock.captures.mockResolvedValue([capture("second"), capture("first")])
    mock.handler?.({ type: "message.part.updated", part: { id: "scope-call", sessionID: "s", messageID: "m", type: "tool", tool: "scope", callID: "c", state: { status: "completed", input: { action: "capture" }, output: "saved", title: "scope", metadata: { directory: "/project" }, time: { start: 1, end: 2 } } } })
    await vi.waitFor(() => expect(select().options).toHaveLength(2))
    expect(select().value).toBe(capture("first").dir)
    mock.captures.mockResolvedValue([capture("second")])
    button("刷新历史").click()
    await vi.waitFor(() => expect(root.textContent).toContain("这份历史采集的文件已缺失或损坏"))
    expect(select().value).toBe(capture("first").dir)
    expect(root.querySelector('[data-component="scope-waveform"]')).toBeNull()
  })

  test("late viewport and screenshot replies from a previous capture cannot overwrite the selected capture", async () => {
    const oldView = deferred<ScopeViewResult>()
    const oldImage = deferred<{ url: string; createdAt: number }>()
    mock.view.mockReturnValueOnce(oldView.promise).mockResolvedValue(view(capture("second"), -0.25, 0.25))
    mock.captures.mockResolvedValue([capture("first"), capture("second")])
    button("刷新历史").click()
    await vi.waitFor(() => expect(mock.view).toHaveBeenCalledTimes(1))
    mock.screenshot.mockReturnValueOnce(oldImage.promise)
    button("查看仪器截图").click()
    select().value = capture("second").dir
    select().dispatchEvent(new Event("change", { bubbles: true }))
    await vi.waitFor(() => expect(root.textContent).toContain("-250 ms … 250 ms"))
    oldView.resolve(view(capture("first"), -99, 99))
    oldImage.resolve({ url: "data:image/png;base64,T0xE", createdAt: 999 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.textContent).toContain("-250 ms … 250 ms")
    expect(root.textContent).not.toContain("-99 s")
    expect(root.querySelector('img[alt="示波器仪器截图"]')).toBeNull()
  })

  test("wheel gestures update and paint immediately, accumulate zoom, and read samples once after settling", async () => {
    const { waveform, canvas, ctx } = await prepareWaveform("en")
    const viewport = waveform.querySelector('[data-slot="view-range"]')!
    const before = viewport.textContent
    for (let index = 0; index < 20; index++) {
      // happy-dom's WheelEvent inherits UIEvent and omits the browser's MouseEvent coordinates.
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -5 })
      Object.defineProperty(event, "clientX", { value: 400 })
      canvas.dispatchEvent(event)
    }
    expect(viewport.textContent).not.toBe(before)
    expect(mock.view).not.toHaveBeenCalled()
    expect(ctx.clearRect).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(ctx.clearRect).toHaveBeenCalledTimes(1), { interval: 5, timeout: 100 })
    expect(mock.view).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(mock.view).toHaveBeenCalledTimes(1))
    const request = mock.view.mock.calls[0][0]
    expect(request.to - request.from).toBeCloseTo(2 * Math.exp(-0.3))
    expect(root.textContent).toContain("Read-only replay")
    expect(root.textContent).toContain("Timebase")
    expect(root.textContent).not.toContain("游标")
    expect(ctx.fillText).toHaveBeenCalledWith("T=0", expect.any(Number), expect.any(Number))
    expect(canvas.width).toBe(720 * (window.devicePixelRatio || 1))
  })

  test("dragging paints the preview without repeated reads, then refines on pointer release", async () => {
    const { waveform, canvas } = await prepareWaveform()
    root.querySelector<HTMLButtonElement>('button[aria-label="放大波形"]')!.click()
    await vi.waitFor(() => expect(mock.view).toHaveBeenCalledTimes(1))
    mock.view.mockClear()
    const window = waveform.querySelector('[data-slot="view-range"]')!
    const before = window.textContent
    canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 350 }))
    for (const clientX of [370, 390, 420]) canvas.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX }))
    expect(window.textContent).not.toBe(before)
    expect(mock.view).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(mock.view).not.toHaveBeenCalled()
    canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 420 }))
    await vi.waitFor(() => expect(mock.view).toHaveBeenCalledTimes(1))
    expect(mock.view.mock.calls[0][0].to - mock.view.mock.calls[0][0].from).toBeCloseTo(1)
    expect(mock.view.mock.calls[0][0].from).toBeLessThan(-0.5)
    expect(waveform.querySelector('[data-slot="plot"]')?.getAttribute("data-dragging")).toBe("false")
  })

  test("a short scroll viewport keeps the full canvas visible and grows it back without rereading samples", async () => {
    const { canvas } = await prepareWaveform("zh", 460)
    root.style.overflowY = "auto"
    let viewportHeight = 278
    Object.defineProperty(root, "clientHeight", { get: () => viewportHeight })
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ top: 200 } as DOMRect)
    vi.spyOn(canvas, "getBoundingClientRect").mockImplementation(() => ({ top: 294 - root.scrollTop } as DOMRect))
    mock.resize?.()
    expect(canvas.style.height).toBe("174px")
    await vi.waitFor(() => expect(canvas.height).toBe(174 * (window.devicePixelRatio || 1)))
    // A scrolled panel uses the same content origin and must not enlarge under the pointer.
    root.scrollTop = 60
    mock.resize?.()
    expect(canvas.style.height).toBe("174px")
    viewportHeight = 378
    mock.resize?.()
    expect(canvas.style.height).toBe("250px")
    await vi.waitFor(() => expect(canvas.height).toBe(250 * (window.devicePixelRatio || 1)))
    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(mock.view).not.toHaveBeenCalled()
  })
})
