/**
 * 嵌入式调试面板 —— 模拟数据层（简化版）
 *
 * 设计：调试页 = 仪器大窗口的纵向堆叠。每台仪器只有一个主显示（display），
 * 不再有硬件列表 / HIL 步进条 / 子标签 / 测试列表 / 寄存器表。
 *
 * 扩展方式：新增仪器 = 往 INSTRUMENTS 加一条记录；若它的 display.kind 是新类型，
 * 在 debug-content.tsx 的渲染注册表（InstrumentWindow 的 Switch）里补一个渲染器。
 * 接真实数据时，把 display 内的静态数据换成实时信号即可，窗口壳与排版不变。
 */
import { createRoot, createSignal } from "solid-js"

export type Transport = "usb" | "scpi" | "lan" | "gdb" | "serial" | "api"
export type InstrumentStatus = "online" | "capturing" | "warn" | "offline"

/** 真仪器:逻辑分析仪(DSLogic)。数据来自内核 la.view,渲染在 la-waveform.tsx。 */
export interface LaDisplay {
  kind: "la"
}
export type InstrumentDisplay = LaDisplay | { kind: "scope" }

export interface Instrument {
  id: string
  name: string
  /** 连接/配置摘要，显示在窗口标题右侧 */
  detail: string
  transport: Transport
  status: InstrumentStatus | "history"
  display: InstrumentDisplay
}

/** 右栏顶部三个模式：tabs(打开的文件标签) / debug(仪器调试) / file(文件树) */
export type DockMode = "tabs" | "debug" | "file"

// ---------------------------------------------------------------- instruments

const INSTRUMENTS: Instrument[] = [
  {
    id: "scope",
    name: "示波器",
    detail: "历史采集 · 连接状态见 scope 工具结果",
    transport: "usb",
    status: "history",
    display: { kind: "scope" },
  },
  {
    id: "dslogic",
    name: "逻辑分析仪",
    detail: "DSLogic · la 工具",
    transport: "usb",
    status: "online",
    display: { kind: "la" },
  },
]

// ---------------------------------------------------------------- reactive store (mock)

export const debug = createRoot(() => {
  const [opened, setOpened] = createSignal(true)
  const [fullscreen, setFullscreen] = createSignal(false)
  const [mode, setMode] = createSignal<DockMode>("debug")

  return {
    // ui state（session-side-panel 依赖，勿改名）
    opened,
    open: () => setOpened(true),
    close: () => {
      // 收起时必须退出全屏，否则中间栏和右栏同时消失
      setFullscreen(false)
      setOpened(false)
    },
    toggle: () => setOpened((v) => !v),
    // 宽度不在这儿：右栏三页共用 layout.dock.width（持久化，切页不变）
    fullscreen,
    toggleFullscreen: () => setFullscreen((v) => !v),
    mode,
    setMode,
    // data (mock)
    instruments: INSTRUMENTS,
  }
})
