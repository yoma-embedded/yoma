/**
 * 日志监视器连接行的纯函数:按工程记住的偏好,与 RTT 器件名的预填 / 校验。测试直接调。
 *
 * 偏好的键沿用 `yoma.serial.preferences.v1`(一个工程一条,最多留 16 个工程):旧记录没有
 * mode / device / speed,读出来按缺省补上 —— 升级之后串口那一半的设置原样还在。
 */
import {
  DEFAULT_BAUD,
  DEFAULT_RTT_SPEED_KHZ,
  jlinkDeviceName,
  MAX_RTT_SPEED_KHZ,
  MIN_RTT_SPEED_KHZ,
} from "@yoma-desktop/kernel/tools/log/contract"

export const MONITOR_PREFS_KEY = "yoma.serial.preferences.v1"
/** 最多记几个工程(之外的按插入先后丢掉最早的)。 */
const MAX_PROJECTS = 16

export type LogSourceMode = "serial" | "rtt"
export type SendEncoding = "text" | "hex"
export type LineEnding = "none" | "lf" | "cr" | "crlf"

export interface MonitorPrefs {
  mode: LogSourceMode
  port: string
  baud: string
  ending: LineEnding
  encoding: SendEncoding
  /** RTT:J-Link 器件名,按用户敲的原样存(归一交给内核)。 */
  device: string
  /** RTT:SWD 时钟 kHz,字符串(输入框里的原样)。 */
  speed: string
}

export const DEFAULT_MONITOR_PREFS: MonitorPrefs = {
  mode: "serial",
  port: "",
  baud: String(DEFAULT_BAUD),
  ending: "none",
  encoding: "text",
  device: "",
  speed: String(DEFAULT_RTT_SPEED_KHZ),
}

const ENDINGS: readonly string[] = ["none", "lf", "cr", "crlf"]

function records(raw: string | null | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    // 坏掉的记录当作没有:偏好永远不该挡住用设备。
    return {}
  }
}

/** 读某个工程的偏好。认不出的字段一律回落缺省,不抛。 */
export function parseMonitorPrefs(raw: string | null | undefined, directory: string): MonitorPrefs {
  const entry = records(raw)[directory]
  const prefs = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {}
  const text = (key: keyof MonitorPrefs) => (typeof prefs[key] === "string" ? (prefs[key] as string) : undefined)
  return {
    mode: prefs.mode === "rtt" ? "rtt" : "serial",
    port: text("port") ?? DEFAULT_MONITOR_PREFS.port,
    baud: text("baud") ?? DEFAULT_MONITOR_PREFS.baud,
    ending: ENDINGS.includes(String(prefs.ending)) ? (prefs.ending as LineEnding) : "none",
    encoding: prefs.encoding === "hex" ? "hex" : "text",
    device: text("device") ?? DEFAULT_MONITOR_PREFS.device,
    speed: text("speed") ?? DEFAULT_MONITOR_PREFS.speed,
  }
}

/** 把某个工程的偏好写回整份记录(它挪到最新的位置,最旧的工程被挤掉)。返回要存的字符串。 */
export function storeMonitorPrefs(raw: string | null | undefined, directory: string, prefs: MonitorPrefs): string {
  const others = Object.entries(records(raw))
    .filter(([key]) => key !== directory)
    .slice(-(MAX_PROJECTS - 1))
  return JSON.stringify({ ...Object.fromEntries(others), [directory]: { ...prefs } })
}

/** STM32 的确切型号:系列 + 产品线 + 引脚数字母 + Flash 容量码(`STM32G473RC`、`STM32WB55RG`、`STM32L4R5ZI`)。 */
/** W 系列的产品线码可以是字母打头(WLE5、WBA52),与内核 `jlinkDeviceName` 的订货号规则同形。 */
const STM32_EXACT = /^STM32(?:W[BL]A?[0-9A-Z]{2}|[A-Z]{1,2}[0-9][0-9A-Z]{1,3})[A-Z][0-9A-Z]$/

/**
 * 一个候选芯片名能不能直接交给 J-Link:能就给 J-Link 认的写法(CubeMX / 订货号缩短过),说不准是哪一颗就 undefined。
 *
 * 候选来自两处,都可能只是一个家族:烧录那边认出来的目标(openocd 的 `stm32g4x` 是 target 配置名,不是芯片),
 * 工程档案(.ioc 的 `Mcu.Name` 常常是 `STM32G473R(B-C-E)Tx`)。**猜错型号比空着更糟**:
 * 空着用户会去填,填错了 J-Link 报 "unknown device",看起来像探针没接好。所以只认说得出是哪一颗的:
 * - STM32:归一之后必须是完整的型号,容量码不能是通配的 X,保留下来的那一截里不能有小写 x(`STM32F103xB`);
 * - 别的厂:J-Link 的写法各家不同(`nRF52840_xxAA`、`ATSAMD21G18`),只要求像个型号 —— 有**通配 X 之外的**大写、
 *   有数字、够长、没有空白与括号。全小写的(`nrf52`、`esp32s3`)多半是 openocd 的配置名,不认;openocd 的
 *   配置名里大写的只有通配的 X(`at91samdXX`、`at91sam4XXX`),同样不认 —— 那几个 X 不能拿来凑"有大写"。
 */
export function exactRttDevice(candidate: string | undefined): string | undefined {
  const name = candidate?.trim()
  if (!name || /[\s()]/.test(name)) return undefined
  let device: string
  try {
    device = jlinkDeviceName(name)
  } catch {
    return undefined
  }
  if (/^STM32/i.test(device)) {
    if (!STM32_EXACT.test(device) || device.endsWith("X")) return undefined
    return /x/.test(name.slice(0, device.length)) ? undefined : device
  }
  return /^[A-Za-z0-9_.-]{6,}$/.test(device) && /[A-WYZ]/.test(device) && /\d/.test(device) ? device : undefined
}

/**
 * RTT 器件名的预填:**用户存过的** > 这次会话里烧录认出来的目标 > 工程档案里的芯片。
 * 后两样说不准是哪一颗时不填,只把它交回去当占位提示(`hint`),让人照着改成确切型号。
 */
export function rttDevicePrefill(input: { saved?: string; target?: string; project?: string }): {
  device: string
  hint?: string
} {
  const saved = input.saved?.trim()
  if (saved) return { device: saved }
  for (const candidate of [input.target, input.project]) {
    const device = exactRttDevice(candidate)
    if (device) return { device }
  }
  const hint = [input.target, input.project].map((candidate) => candidate?.trim()).find(Boolean)
  return hint ? { device: "", hint } : { device: "" }
}

/** 连接前的本地校验(与内核同一把尺,只是早一步、说中文)。 */
export function checkRttDevice(value: string): { device: string } | { error: "empty" | "family" } {
  const device = value.trim()
  if (!device) return { error: "empty" }
  try {
    jlinkDeviceName(device)
  } catch {
    return { error: "family" }
  }
  return { device }
}

/** SWD 时钟:整数 kHz,落在内核认的范围里;否则 undefined。 */
export function parseRttSpeed(value: string): number | undefined {
  const text = value.trim()
  if (!/^\d+$/.test(text)) return undefined
  const speed = Number(text)
  return speed >= MIN_RTT_SPEED_KHZ && speed <= MAX_RTT_SPEED_KHZ ? speed : undefined
}
