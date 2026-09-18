/**
 * 目标卡"钉住"这一位。
 *
 * 缺省它是一张**悬停卡**:鼠标停 200ms 弹出来、移开就没。钉住之后它一直挂在状态栏上方 ——
 * 一边读时间线一边盯着烧录 / GDB / 日志三行读数,那是长时间调一块板子时真正的用法。
 * 所以这一位要落盘:下次打开还该是这样(同 `console-state.ts` 的开合与高度)。
 *
 * 形态与 `console-state.ts` / `bench/instruments.ts` 的 `benchPins` 一样 —— 模块级 `createRoot`
 * 加直写 localStorage,读写一律 try/catch(无痕窗口里 `localStorage` 会抛,而"卡钉着没钉"
 * 不值得把会话页炸掉)。
 */
import { createRoot, createSignal } from "solid-js"

const KEY = "yoma.bench.targetCard"

export const TARGET_CARD_KEY = KEY

/** 读一份落盘状态。任何一处不对就当"没钉过",绝不抛。 */
export function readTargetCardPinned(raw: string | null | undefined): boolean {
  if (!raw) return false
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return false
    return (parsed as Record<string, unknown>).pinned === true
  } catch {
    return false
  }
}

function load(): boolean {
  try {
    return readTargetCardPinned(globalThis.localStorage?.getItem(KEY))
  } catch {
    return false
  }
}

function save(pinned: boolean) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ pinned }))
  } catch {
    // 存不下就只在本次会话里生效,不报错。
  }
}

export const targetCardPin = createRoot(() => {
  const [pinned, setPinned] = createSignal(load())
  const commit = (next: boolean) => {
    save(next)
    setPinned(next)
  }
  return {
    pinned,
    set: commit,
    toggle() {
      commit(!pinned())
    },
    /** 测试与截图工装用:回到出厂状态。 */
    reset() {
      commit(false)
    },
  }
})
