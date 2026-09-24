/**
 * 右栏 dock 的界面状态。
 *
 * 2026-09-18 起这里**只剩界面状态** —— 从前那份写死的仪器清单(`INSTRUMENTS` 模拟数据)
 * 搬进了 `pages/session/bench/instruments.ts` 的注册表,由会话里的工具卡片与磁盘上的
 * 证据决定露出哪几台。要加一台仪器去改那份注册表,不要改这里。
 *
 * `debug` 这个名字与它的三个字段(opened / fullscreen / mode)是 `session-side-panel.tsx`
 * 与 `session.tsx` 直接读的,勿改名。
 */
import { createRoot, createSignal } from "solid-js"

/** 右栏顶部三个模式:tabs(打开的文件标签) / debug(仪器调试) / file(文件树) */
export type DockMode = "tabs" | "debug" | "file"

export const debug = createRoot(() => {
  // 缺省收着。打开日志 / 调试器只该展开底部控制台;波形页要等用户点示波器或逻辑分析仪。
  const [opened, setOpened] = createSignal(false)
  const [fullscreen, setFullscreen] = createSignal(false)
  const [mode, setMode] = createSignal<DockMode>("debug")

  return {
    opened,
    open: () => setOpened(true),
    close: () => {
      // 收起时必须退出全屏,否则中间栏和右栏同时消失
      setFullscreen(false)
      setOpened(false)
    },
    toggle: () => setOpened((v) => !v),
    // 宽度不在这儿:右栏三页共用 layout.dock.width(持久化,切页不变)
    fullscreen,
    toggleFullscreen: () => setFullscreen((v) => !v),
    mode,
    setMode,
  }
})
