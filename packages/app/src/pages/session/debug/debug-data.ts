/**
 * 嵌入式调试面板 —— 模拟数据层（capability-driven）
 *
 * 设计要点：面板不写死任何具体仪器/视图。
 *  - 每台仪器是统一的 Instrument 模型（名称 / 传输 / 状态 / 实时读数 / 能产出的视图种类）。
 *  - 每个视图声明它的 kind，面板用「渲染器注册表」按 kind 挑组件（见 debug-content.tsx 的 renderView）。
 *  - 加一种新仪器 = 往 instruments 里加一条 + 注册它 provides 的 viewKind，排版一行不用动。
 *
 * 当前全部为 mock 静态数据，后续把 store 里的 signal 换成来自 SDK 的实时事件流即可。
 */
import { createRoot, createSignal } from "solid-js"

export type Transport = "usb" | "scpi" | "lan" | "gdb" | "serial" | "api"
export type InstrumentStatus = "online" | "capturing" | "warn" | "offline"

/** 视图种类 —— 决定用哪个渲染器。加新仪器类别时在这里扩展。 */
export type ViewKind =
  | "waveform" // 时域波形 / 协议解码（示波器、逻辑分析仪）
  | "timeseries" // 时序曲线（功耗仪、电源、温度）
  | "scalar" // 单值读数（万用表、计数器、LCR）
  | "registers" // 寄存器 / 外设表（调试探针）
  | "spectrum" // 频谱 / FFT（频谱仪）
  | "log" // 文本流（RTT / 串口）

export interface Instrument {
  id: string
  name: string
  detail: string
  transport: Transport
  status: InstrumentStatus
  readout?: { value: string; sub?: string }
  /** 能力：这台仪器能贡献哪些视图种类 */
  provides: ViewKind[]
}

export type Tone = "pass" | "warn" | "fail" | "run" | "muted"

export interface DebugView {
  id: string
  kind: ViewKind
  /** 子标签短标题 */
  title: string
  instrumentId: string
  badge?: { text: string; tone: Tone }
  data: unknown
}

export interface WaveformData {
  bus: string
  meta: string
  lanes: { name: string; note?: string; kind: "clock" | "data"; anomalyFrom?: number }[]
  decode: { text: string; bad?: boolean; faint?: boolean }[]
  analysis?: string
}
export interface TimeseriesData {
  unit: string
  points: number[]
  stats: { label: string; value: string }[]
  note?: string
}
export interface ScalarData {
  value: string
  unit: string
  label: string
  sub?: string
}
export interface RegistersData {
  rows: { name: string; addr: string; value: string; note?: string; bad?: boolean }[]
}
export interface SpectrumData {
  bins: number[]
  peak: string
}

export interface HilStep {
  id: string
  label: string
  state: "done" | "run" | "fail" | "idle"
}
export interface TestCase {
  name: string
  state: "pass" | "fail" | "run"
  ms?: number
  evidence?: string // 关联的 DebugView id
  note?: string
}
export interface ConsoleLine {
  t: string
  level: "rtt" | "warn" | "err" | "ok"
  text: string
}

// ---------------------------------------------------------------- mock content

const INSTRUMENTS: Instrument[] = [
  {
    id: "mcu",
    name: "STM32H743ZI",
    detail: "Nucleo-144 · SWD",
    transport: "gdb",
    status: "online",
    readout: { value: "已连接", sub: "3.28 V" },
    provides: ["registers"],
  },
  {
    id: "jlink",
    name: "SEGGER J-Link",
    detail: "4000 kHz · SWD",
    transport: "gdb",
    status: "online",
    readout: { value: "在线", sub: "V7.94" },
    provides: ["registers", "log"],
  },
  {
    id: "saleae",
    name: "Saleae Logic Pro 8",
    detail: "I2C 解码 · 25 MS/s",
    transport: "usb",
    status: "capturing",
    readout: { value: "抓取中", sub: "PB8/PB9" },
    provides: ["waveform"],
  },
  {
    id: "ppk2",
    name: "Nordic PPK2",
    detail: "功耗剖析",
    transport: "usb",
    status: "warn",
    readout: { value: "12.4 mA", sub: "峰值 38 mA" },
    provides: ["timeseries"],
  },
  {
    id: "dmm",
    name: "Keysight 34465A",
    detail: "SCPI · LAN",
    transport: "scpi",
    status: "online",
    readout: { value: "3.281 V", sub: "6½ 位" },
    provides: ["scalar"],
  },
  {
    id: "rigol",
    name: "Rigol DS1054Z",
    detail: "SCPI · LAN",
    transport: "lan",
    status: "offline",
    readout: { value: "离线", sub: "未连接" },
    provides: ["waveform", "spectrum"],
  },
]

const VIEWS: DebugView[] = [
  {
    id: "v-i2c",
    kind: "waveform",
    title: "I2C 波形",
    instrumentId: "saleae",
    badge: { text: "NACK + tSU", tone: "warn" },
    data: {
      bus: "I2C1",
      meta: "0x76 · 400 kHz",
      lanes: [
        { name: "SCL", kind: "clock" },
        { name: "SDA", kind: "data", note: "第 9 个时钟应被从机拉低 (ACK)，实际保持高", anomalyFrom: 0.77 },
      ],
      decode: [
        { text: "START" },
        { text: "0x76 W" },
        { text: "NACK ✕", bad: true },
        { text: "0xD0 ?", faint: true },
        { text: "STOP", faint: true },
      ],
      analysis:
        "SDA 上升时间 ~380 ns，tSU;DAT≈42 ns（RM0433 要求 >100 ns）。上拉偏弱 → 从机采样到亚稳态。建议 R=2.2 kΩ（当前 10 kΩ），或降到 100 kHz 标准模式复测。",
    } satisfies WaveformData,
  },
  {
    id: "v-power",
    kind: "timeseries",
    title: "功耗",
    instrumentId: "ppk2",
    data: {
      unit: "mA",
      points: [2, 2, 3, 12, 12, 11, 12, 38, 30, 14, 12, 12, 13, 36, 28, 12, 11, 12, 12, 12],
      stats: [
        { label: "平均", value: "12.4 mA" },
        { label: "峰值", value: "38 mA" },
        { label: "睡眠", value: "2.1 µA" },
      ],
      note: "唤醒→I2C 重试造成两次电流尖峰",
    } satisfies TimeseriesData,
  },
  {
    id: "v-dmm",
    kind: "scalar",
    title: "电压",
    instrumentId: "dmm",
    data: { value: "3.281", unit: "V", label: "VDD (34465A)", sub: "标称 3.30 V · −0.6%" } satisfies ScalarData,
  },
  {
    id: "v-reg",
    kind: "registers",
    title: "寄存器",
    instrumentId: "mcu",
    data: {
      rows: [
        { name: "I2C1_CR1", addr: "0x40005400", value: "0x00000001", note: "PE=1 使能" },
        { name: "I2C1_ISR", addr: "0x40005418", value: "0x00000110", note: "NACKF=1 · TXE=1", bad: true },
        { name: "I2C1_TIMINGR", addr: "0x40005410", value: "0x00303D5B" },
        { name: "RCC_D2CCIP2R", addr: "0x58024550", value: "0x00000000", note: "I2C1SEL=PCLK1" },
      ],
    } satisfies RegistersData,
  },
]

const HIL: HilStep[] = [
  { id: "build", label: "Build", state: "done" },
  { id: "flash", label: "Flash", state: "done" },
  { id: "test", label: "Test", state: "run" },
  { id: "fix", label: "Fix", state: "idle" },
]

const TESTS: TestCase[] = [
  { name: "test_i2c1_init", state: "pass", ms: 18 },
  { name: "test_uart3_echo", state: "pass", ms: 42 },
  { name: "test_gpio_led_toggle", state: "pass", ms: 9 },
  { name: "test_bme280_read_id", state: "fail", evidence: "v-i2c", note: "期望 chip-id 0x60，实际总线 NACK" },
  { name: "test_bme280_calib", state: "run" },
]

const CONSOLE: ConsoleLine[] = [
  { t: "00.412", level: "rtt", text: "I2C1 init @ 400kHz, SDA=PB9 SCL=PB8" },
  { t: "00.418", level: "rtt", text: "BME280 probe addr=0x76 ..." },
  { t: "00.421", level: "warn", text: "I2C AF flag set, NACKF=1" },
  { t: "00.421", level: "err", text: "HAL_I2C_Master_Transmit → HAL_TIMEOUT" },
  { t: "00.425", level: "rtt", text: "retry 1/3 addr=0x76 ..." },
  { t: "00.431", level: "err", text: "NACK on address phase (no ACK)" },
  { t: "00.902", level: "ok", text: "Saleae capture armed on falling SCL" },
  { t: "00.914", level: "warn", text: "tSU;DAT=42ns below 100ns min (RM0433 §52.4.9)" },
  { t: "12.40", level: "ok", text: "proposing fix: pull-up 10k→2.2k, re-run" },
]

// ---------------------------------------------------------------- reactive store (mock)

/** 右栏顶部四个模式：changes(审查) / debug(仪器调试) / cmd(终端) / file(文件) */
export type DockMode = "changes" | "debug" | "cmd" | "file"

export const debug = createRoot(() => {
  const [opened, setOpened] = createSignal(true)
  const [width, setWidth] = createSignal(360)
  const [fullscreen, setFullscreen] = createSignal(false)
  const [mode, setMode] = createSignal<DockMode>("debug")
  const [subtab, setSubtab] = createSignal<string>("v-i2c")
  const [cmdList, setCmdList] = createSignal(false)
  const [hil, setHil] = createSignal<HilStep[]>(HIL)
  const [running, setRunning] = createSignal(false)

  const setStep = (id: string, state: HilStep["state"]) =>
    setHil((steps) => steps.map((s) => (s.id === id ? { ...s, state } : s)))

  /** 模拟一次 HIL 闭环：Test 失败 → 暴露 Fix，并跳到测试证据 */
  const runHil = () => {
    if (running()) return
    setRunning(true)
    setStep("test", "run")
    setMode("debug")
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        setStep("test", "fail")
        setStep("fix", "idle")
        setSubtab("tests")
        setRunning(false)
      }, 900)
    } else {
      setStep("test", "fail")
      setSubtab("tests")
      setRunning(false)
    }
  }

  return {
    // ui state
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
    subtab,
    setSubtab,
    /** cmd 模式：终端列表栏是否展开 */
    cmdList,
    toggleCmdList: () => setCmdList((v) => !v),
    // data (mock)
    instruments: INSTRUMENTS,
    views: VIEWS,
    console: CONSOLE,
    tests: TESTS,
    hil,
    running,
    runHil,
    // helpers
    viewById: (id: string) => VIEWS.find((v) => v.id === id),
    warnings: () => TESTS.filter((t) => t.state === "fail").length,
  }
})
