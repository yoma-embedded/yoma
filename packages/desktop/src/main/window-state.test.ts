import { afterEach, describe, expect, test, vi } from "vitest"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow, Rectangle } from "electron"
import { manageWindowState, readWindowState, resolveWindowState, type Displays } from "./window-state"

const LAPTOP: Rectangle = { x: 0, y: 0, width: 1440, height: 932 }
const EXTERNAL: Rectangle = { x: 1440, y: 0, width: 2560, height: 1440 }
const displays = (...all: Rectangle[]): Displays => ({
  all: () => all,
  primary: () => all[0]!,
  matching: (bounds) => all.find((item) => bounds.x >= item.x && bounds.x < item.x + item.width) ?? all[0]!,
})
const DEFAULTS = { width: 1280, height: 800 }

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "yoma-window-state-"))
  dirs.push(dir)
  return join(dir, "window-state.json")
}

describe("resolveWindowState", () => {
  // electron-window-state 实际写出来的文件(本机 com.yoma.desktop 档里的那一份)
  const SAVED = {
    width: 1280,
    height: 800,
    x: 80,
    y: 29,
    isMaximized: false,
    isFullScreen: false,
    displayBounds: LAPTOP,
  }

  test("老文件原样接着用", () => {
    expect(resolveWindowState(SAVED, DEFAULTS, displays(LAPTOP))).toEqual(SAVED)
  })

  test("没有文件 / 不是对象:缺省大小,位置交给系统", () => {
    expect(resolveWindowState(undefined, DEFAULTS, displays(LAPTOP))).toEqual(DEFAULTS)
    expect(resolveWindowState("oops", DEFAULTS, displays(LAPTOP))).toEqual(DEFAULTS)
  })

  test("记下的位置在外接显示器上、而它现在拔了:回到主屏的缺省大小,不开到看不见的地方", () => {
    const onExternal = { ...SAVED, x: 2000, y: 100, displayBounds: EXTERNAL }
    expect(resolveWindowState(onExternal, DEFAULTS, displays(LAPTOP, EXTERNAL))).toEqual(onExternal)
    expect(resolveWindowState(onExternal, DEFAULTS, displays(LAPTOP))).toEqual({
      ...DEFAULTS,
      x: 0,
      y: 0,
      displayBounds: LAPTOP,
    })
  })

  test("分辨率变小、窗口放不下了:同样回缺省", () => {
    const small: Rectangle = { x: 0, y: 0, width: 1280, height: 720 }
    expect(resolveWindowState(SAVED, DEFAULTS, displays(small))).toMatchObject({ x: 0, y: 0, ...DEFAULTS })
  })

  test("位置坏了但记着是最大化的:留着最大化,大小用缺省的", () => {
    expect(resolveWindowState({ isMaximized: true, width: 0, height: 0 }, DEFAULTS, displays(LAPTOP))).toEqual({
      isMaximized: true,
      ...DEFAULTS,
    })
    expect(resolveWindowState({ width: -5, height: 10 }, DEFAULTS, displays(LAPTOP))).toEqual(DEFAULTS)
  })
})

describe("readWindowState", () => {
  test("读不了 / 不是 JSON 就当没有", () => {
    const file = tempFile()
    expect(readWindowState(file)).toBeUndefined()
    writeFileSync(file, "{not json")
    expect(readWindowState(file)).toBeUndefined()
    writeFileSync(file, '{"width":1000}')
    expect(readWindowState(file)).toEqual({ width: 1000 })
  })
})

/** BrowserWindow 的替身:能发事件、能改位置和最大化状态。 */
function fakeWindow(bounds: Rectangle) {
  const win = Object.assign(new EventEmitter(), {
    bounds,
    maximized: false,
    fullScreen: false,
    destroyed: false,
    maximize: vi.fn(() => (win.maximized = true)),
    setFullScreen: vi.fn((value: boolean) => (win.fullScreen = value)),
    getBounds: () => win.bounds,
    isMaximized: () => win.maximized,
    isMinimized: () => false,
    isFullScreen: () => win.fullScreen,
    isDestroyed: () => win.destroyed,
  })
  return win
}
const asWindow = (win: ReturnType<typeof fakeWindow>) => win as unknown as BrowserWindow

describe("manageWindowState", () => {
  test("上次是最大化 / 全屏的,摆回去", () => {
    const win = fakeWindow({ x: 0, y: 0, width: 1280, height: 800 })
    manageWindowState(asWindow(win), tempFile(), { ...DEFAULTS, isMaximized: true }, displays(LAPTOP))
    expect(win.maximize).toHaveBeenCalledTimes(1)
    expect(win.setFullScreen).not.toHaveBeenCalled()
  })

  test("拖动时不读窗口,停下来才读;关窗时写盘,格式和 electron-window-state 一样", () => {
    vi.useFakeTimers()
    const file = tempFile()
    const win = fakeWindow({ x: 80, y: 29, width: 1280, height: 800 })
    const getBounds = vi.spyOn(win, "getBounds")
    manageWindowState(asWindow(win), file, { ...DEFAULTS, x: 80, y: 29 }, displays(LAPTOP))
    for (let x = 81; x <= 140; x += 1) {
      win.bounds = { ...win.bounds, x }
      win.emit("move")
    }
    expect(getBounds).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(getBounds).toHaveBeenCalledTimes(1)
    win.emit("close")
    win.emit("closed")
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      width: 1280,
      height: 800,
      x: 140,
      y: 29,
      isMaximized: false,
      isFullScreen: false,
      displayBounds: LAPTOP,
    })
  })

  test("最大化之后记的还是最大化之前的大小 —— 下次还原时回到那个大小", () => {
    const file = tempFile()
    const win = fakeWindow({ x: 100, y: 50, width: 1000, height: 700 })
    manageWindowState(asWindow(win), file, { ...DEFAULTS, x: 100, y: 50 }, displays(LAPTOP))
    win.emit("close")
    win.maximized = true
    win.bounds = { ...LAPTOP }
    win.emit("close")
    win.emit("closed")
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      x: 100,
      y: 50,
      width: 1000,
      height: 700,
      isMaximized: true,
    })
  })

  test("关掉之后不再听事件,挂着的定时器也不再读一个已经销毁的窗口", () => {
    vi.useFakeTimers()
    const win = fakeWindow({ x: 0, y: 0, width: 1280, height: 800 })
    const getBounds = vi.spyOn(win, "getBounds")
    manageWindowState(asWindow(win), tempFile(), DEFAULTS, displays(LAPTOP))
    win.emit("resize")
    win.emit("close")
    win.emit("closed")
    win.destroyed = true
    const calls = getBounds.mock.calls.length
    vi.advanceTimersByTime(500)
    expect(getBounds.mock.calls.length).toBe(calls)
    expect(win.listenerCount("resize") + win.listenerCount("move") + win.listenerCount("closed")).toBe(0)
  })
})
