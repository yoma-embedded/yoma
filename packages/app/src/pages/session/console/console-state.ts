/**
 * 底部控制台与右栏仪器页的界面状态(v2-console 这个布局自己的)。
 *
 * **不走 app 的 `persisted()`**:那一套要 `usePlatform()`,只能在 provider 底下调,而这里要的是
 * 一个模块级单例 —— 命令(`Mod+J`)、状态栏、控制台本体、右栏三处都读同一份,而命令注册的时机
 * 早于面板挂载。所以直接落 localStorage,键遵循 `yoma.*` 的命名,读写一律 try/catch
 * (无痕窗口 / 清过站点数据时 `localStorage` 会抛,而"控制台开着没开"不值得把会话页炸掉)。
 * 这与 `bench/instruments.ts` 的 `benchPins` 是同一个形态,理由也一样。
 *
 * 落盘的只有"下次打开还该是这样"的那几位:开合、高度、当前页签,以及**你点过的**
 * 右栏仪器。没点过就不要记:从前右栏会自己落到示波器上,再把这个选择存下来,
 * 下次只打开日志,示波器也跟着占住右栏。
 * **最大化不落盘** —— 它是一次性的动作(同右栏的 `fullscreen`),下次进来还顶着一屏控制台
 * 只会让人以为界面坏了。
 */
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { InstrumentId } from "../bench/bench-status"
import { INSTRUMENT_IDS } from "../bench/bench-status"

const KEY = "yoma.console.v2"

/** 最矮:两三行日志 + 页签行。再矮就只剩一条缝,不如收起来。 */
export const CONSOLE_MIN_HEIGHT = 140
/** 最高按可用高度的六成算 —— 聊天栏永远留得下时间线尾巴和输入框。 */
export const CONSOLE_MAX_FRACTION = 0.6
const DEFAULT_HEIGHT = 280

export interface ConsoleStored {
  open: boolean
  height: number
  /** 当前页签(文本流仪器的 id)。 */
  tab: InstrumentId
  /** 右栏按需仪器页当前显示的那一台(波形仪器的 id)。 */
  rail?: InstrumentId
}

const DEFAULTS: ConsoleStored = { open: true, height: DEFAULT_HEIGHT, tab: "log" }

function isInstrumentId(value: unknown): value is InstrumentId {
  return typeof value === "string" && (INSTRUMENT_IDS as readonly string[]).includes(value)
}

/** 读一份落盘状态。任何一处不对就用默认值补上,绝不抛。 */
export function readConsoleState(raw: string | null | undefined): ConsoleStored {
  if (!raw) return { ...DEFAULTS }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS }
    const value = parsed as Record<string, unknown>
    return {
      open: typeof value.open === "boolean" ? value.open : DEFAULTS.open,
      // 高度只钳下限:上限跟窗口走,存一个大数不是坏数据(换个大屏就合法了)。
      height:
        typeof value.height === "number" && Number.isFinite(value.height)
          ? Math.max(CONSOLE_MIN_HEIGHT, Math.round(value.height))
          : DEFAULTS.height,
      tab: isInstrumentId(value.tab) ? value.tab : DEFAULTS.tab,
      // railChosen 把「用户点过」和「界面自己落到第一台」分开。旧档只有 rail、没有这个标记,
      // 那是自动选中示波器写进去的,读出来就丢掉。
      rail: value.railChosen === true && isInstrumentId(value.rail) ? value.rail : undefined,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function load(): ConsoleStored {
  try {
    return readConsoleState(globalThis.localStorage?.getItem(KEY))
  } catch {
    return { ...DEFAULTS }
  }
}

function save(state: ConsoleStored) {
  try {
    const payload = state.rail
      ? { open: state.open, height: state.height, tab: state.tab, rail: state.rail, railChosen: true }
      : { open: state.open, height: state.height, tab: state.tab }
    globalThis.localStorage?.setItem(KEY, JSON.stringify(payload))
  } catch {
    // 存不下就只在本次会话里生效,不报错。
  }
}

export const CONSOLE_STATE_KEY = KEY

export const consoleUI = createRoot(() => {
  const [store, setStore] = createStore<ConsoleStored>(load())
  /** 最大化:不落盘,同右栏的 fullscreen。 */
  const [transient, setTransient] = createStore({ maximized: false, seenErrors: 0 })
  /**
   * 已经看过的 error 行数。控制台开着并停在日志页时由面板不断推平;
   * 收着的时候不动,于是"新来的 error"= 当前 error 数 - 这个水位。
   */

  const commit = (patch: Partial<ConsoleStored>) => {
    setStore(patch)
    save({ open: store.open, height: store.height, tab: store.tab, rail: store.rail })
  }

  return {
    opened: () => store.open,
    height: () => store.height,
    tab: () => store.tab,
    rail: () => store.rail,
    maximized: () => transient.maximized,

    open(tab?: InstrumentId) {
      commit(tab ? { open: true, tab } : { open: true })
    },
    close() {
      setTransient("maximized", false)
      commit({ open: false })
    },
    toggle() {
      if (store.open) this.close()
      else this.open()
    },
    /** 页签只选择仪器。收起由独立的关闭按钮或快捷键完成。 */
    select(tab: InstrumentId) {
      commit({ open: true, tab })
    },
    setTab(tab: InstrumentId) {
      commit({ tab })
    },
    resize(height: number) {
      commit({ height: Math.max(CONSOLE_MIN_HEIGHT, Math.round(height)) })
    },
    setRail(rail: InstrumentId) {
      commit({ rail })
    },
    toggleMaximized() {
      setTransient("maximized", (value) => !value)
    },

    seenErrors: () => transient.seenErrors,
    markErrorsSeen(count: number) {
      setTransient("seenErrors", count)
    },

    /** 测试与截图工装用:回到出厂状态。 */
    reset() {
      setTransient("maximized", false)
      setTransient("seenErrors", 0)
      setStore({ ...DEFAULTS, rail: undefined })
      save({ ...DEFAULTS })
    },
  }
})
