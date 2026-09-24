/**
 * 记住窗口的位置、大小、最大化 / 全屏,下次启动摆回去。顶替 electron-window-state(外加它带的 jsonfile、mkdirp)。
 *
 * 文件还是 userData 下的 `window-state.json`,字段也原样,老档案直接接着用。行为照它的:窗口在普通状态时才记
 * 位置大小(最大化之后再还原,回到的是最大化之前的大小);记下的位置要整个落在**现在某一块屏幕**里才信 ——
 * 外接显示器拔了、分辨率变了,就回到主屏上的缺省大小,不把窗口开到看不见的地方去。关窗时写盘。
 */

import { readFileSync } from "node:fs"
import type { BrowserWindow, Rectangle } from "electron"

import { writeFileAtomic } from "./json-store"

export type WindowState = {
  x?: number
  y?: number
  width: number
  height: number
  displayBounds?: Rectangle
  isMaximized?: boolean
  isFullScreen?: boolean
}

/** electron 的 screen 在这里要用到的三样;测试里换成假的屏幕。 */
export type Displays = {
  all: () => Rectangle[]
  primary: () => Rectangle
  matching: (bounds: Rectangle) => Rectangle
}

const hasBounds = (state: WindowState): state is WindowState & { x: number; y: number } =>
  Number.isInteger(state.x) &&
  Number.isInteger(state.y) &&
  Number.isInteger(state.width) &&
  state.width > 0 &&
  Number.isInteger(state.height) &&
  state.height > 0

const within = (state: WindowState & { x: number; y: number }, bounds: Rectangle) =>
  state.x >= bounds.x &&
  state.y >= bounds.y &&
  state.x + state.width <= bounds.x + bounds.width &&
  state.y + state.height <= bounds.y + bounds.height

export function resolveWindowState(
  saved: unknown,
  defaults: { width: number; height: number },
  displays: Displays,
): WindowState {
  const fresh = { width: defaults.width, height: defaults.height }
  if (typeof saved !== "object" || saved === null) return fresh
  const state = saved as WindowState
  // 没有位置、但记着"是最大化 / 全屏的":留着这两个标记;记下的大小还像样就接着用(还原时回到它),否则用缺省的。
  if (!hasBounds(state)) {
    if (!state.isMaximized && !state.isFullScreen) return fresh
    const sized = [state.width, state.height].every((value) => Number.isInteger(value) && value > 0)
    return sized ? state : { ...state, ...fresh }
  }
  if (!state.displayBounds) return state
  if (displays.all().some((bounds) => within(state, bounds))) return state
  return { ...fresh, x: 0, y: 0, displayBounds: displays.primary() }
}

export function readWindowState(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

/** 跟着这个窗口直到它关掉,关掉时写盘。 */
export function manageWindowState(win: BrowserWindow, file: string, initial: WindowState, displays: Displays) {
  const state = { ...initial }
  if (state.isMaximized) win.maximize()
  if (state.isFullScreen) win.setFullScreen(true)
  let timer: ReturnType<typeof setTimeout> | undefined
  const update = () => {
    if (win.isDestroyed()) return
    const bounds = win.getBounds()
    if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
      state.x = bounds.x
      state.y = bounds.y
      state.width = bounds.width
      state.height = bounds.height
    }
    state.isMaximized = win.isMaximized()
    state.isFullScreen = win.isFullScreen()
    state.displayBounds = displays.matching(bounds)
  }
  // resize / move 拖的时候一秒几十次,只在停下来之后读一次窗口。
  const changed = () => {
    clearTimeout(timer)
    timer = setTimeout(update, 100)
  }
  const closed = () => {
    clearTimeout(timer)
    win.off("resize", changed)
    win.off("move", changed)
    win.off("close", update)
    win.off("closed", closed)
    try {
      writeFileAtomic(file, JSON.stringify(state))
    } catch {
      // 记不下来只是下次回到缺省位置,不值得在退出的路上抛。
    }
  }
  win.on("resize", changed)
  win.on("move", changed)
  win.on("close", update)
  win.on("closed", closed)
}
