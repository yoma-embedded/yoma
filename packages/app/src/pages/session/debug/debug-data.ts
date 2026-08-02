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

export interface WaveformDisplay {
  kind: "waveform"
  /** 总线/通道说明，显示在窗口内容顶部 */
  meta: string
  /** 异常徽标（可选），如 NACK / 时序违例 */
  flag?: string
  /** 图下方的一行简短说明（可选） */
  caption?: string
}
export interface TimeseriesDisplay {
  kind: "timeseries"
  unit: string
  points: number[]
  /** 一行汇总，如 平均/峰值/睡眠 */
  summary: string
}
export interface ScalarDisplay {
  kind: "scalar"
  value: string
  unit: string
  sub?: string
}
export interface StatusDisplay {
  kind: "status"
  primary: string
  secondary?: string
}
export interface OfflineDisplay {
  kind: "offline"
  hint?: string
}
export type InstrumentDisplay =
  | WaveformDisplay
  | TimeseriesDisplay
  | ScalarDisplay
  | StatusDisplay
  | OfflineDisplay

export interface Instrument {
  id: string
  name: string
  /** 连接/配置摘要，显示在窗口标题右侧 */
  detail: string
  transport: Transport
  status: InstrumentStatus
  display: InstrumentDisplay
}

/** 右栏顶部三个模式：changes(审查) / debug(仪器调试) / file(文件) */
export type DockMode = "changes" | "debug" | "file"

// ---------------------------------------------------------------- mock content

const INSTRUMENTS: Instrument[] = [
  {
    id: "saleae",
    name: "Saleae Logic Pro 8",
    detail: "25 MS/s · PB8/PB9",
    transport: "usb",
    status: "capturing",
    display: {
      kind: "waveform",
      meta: "I2C1 · 0x76 · 400 kHz",
      flag: "NACK",
      caption: "SDA 第 9 个时钟未被从机拉低（NACK），tSU;DAT ≈ 42 ns 低于 100 ns 下限",
    },
  },
  {
    id: "ppk2",
    name: "Nordic PPK2",
    detail: "功耗剖析",
    transport: "usb",
    status: "warn",
    display: {
      kind: "timeseries",
      unit: "mA",
      points: [2, 2, 3, 12, 12, 11, 12, 38, 30, 14, 12, 12, 13, 36, 28, 12, 11, 12, 12, 12],
      summary: "平均 12.4 mA · 峰值 38 mA · 睡眠 2.1 µA",
    },
  },
  {
    id: "dmm",
    name: "Keysight 34465A",
    detail: "SCPI · LAN",
    transport: "scpi",
    status: "online",
    display: { kind: "scalar", value: "3.281", unit: "V", sub: "VDD · 6½ 位" },
  },
  {
    id: "mcu",
    name: "STM32H743ZI",
    detail: "Nucleo-144",
    transport: "gdb",
    status: "online",
    display: { kind: "status", primary: "3.28 V", secondary: "SWD 已连接" },
  },
  {
    id: "jlink",
    name: "SEGGER J-Link",
    detail: "V7.94",
    transport: "gdb",
    status: "online",
    display: { kind: "status", primary: "在线", secondary: "SWD · 4000 kHz" },
  },
  {
    id: "rigol",
    name: "Rigol DS1054Z",
    detail: "SCPI · LAN",
    transport: "lan",
    status: "offline",
    display: { kind: "offline", hint: "未连接" },
  },
]

// ---------------------------------------------------------------- reactive store (mock)

export const debug = createRoot(() => {
  const [opened, setOpened] = createSignal(true)
  const [width, setWidth] = createSignal(360)
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
    width,
    setWidth,
    fullscreen,
    toggleFullscreen: () => setFullscreen((v) => !v),
    mode,
    setMode,
    // data (mock)
    instruments: INSTRUMENTS,
  }
})
