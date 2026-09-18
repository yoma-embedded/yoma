/**
 * 目标卡"按住不放"这一位。
 *
 * 缺省它是一张**悬停卡**:鼠标停 200ms 弹出来、移开就没。点一下格子把它按住 —— 给键盘 / 触屏
 * 一条路,也给"我想多看两眼"一个不用悬着鼠标的办法。按住的卡在点别处、按 Esc、或再点一下格子时收起。
 *
 * **刻意不落盘**(复审 D1):卡是从状态栏往上长的,而输入框就在状态栏正上方 —— 一张跨会话
 * 常驻的卡等于永久盖住 app 唯一的输入口的左下角(附件 `+`、模型那一行)。要长期盯着三行读数,
 * 状态栏那三格本来就一直在;卡片给的新信息只有芯片 · 内核 · 探针那一行,看一眼就够。
 *
 * 形态与 `console-state.ts` 一样是模块级 `createRoot`,只是没有 localStorage 那一半。
 */
import { createRoot, createSignal } from "solid-js"

export const targetCardPin = createRoot(() => {
  const [pinned, setPinned] = createSignal(false)
  return {
    pinned,
    set: setPinned,
    toggle() {
      setPinned(!pinned())
    },
    /** 测试与截图工装用:回到出厂状态。 */
    reset() {
      setPinned(false)
    },
  }
})
