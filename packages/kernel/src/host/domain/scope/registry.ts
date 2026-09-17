/**
 * 驱动注册表:一张手写的数组(ngscopeclient 的 DriverStaticInit 证明手写列表撑得起二十多个驱动),
 * 加"按地址打开"和"按 *IDN? 自动识别"两条路。加一个厂商 = 一个驱动文件 + 这里一行。
 */
import { DEMO_DRIVER } from "./demo.ts"
import {
  type ScopeAddress,
  type ScopeDriver,
  type ScopeDriverSpec,
  type ScopeOpenOptions,
  formatScopeAddress,
  parseScopeAddress,
  scopeAddressKey,
} from "./driver.ts"
import { SIGLENT_DRIVER } from "./siglent.ts"
import { type UsbScopeInfo, listUsbScopes, openScpi, parseIdn } from "./scpi.ts"

/** 这一版装配的驱动。demo 只在 `YOMA_SCOPE_DEMO` 打开时进表,普通用户的 agent 拿不到假波形。 */
export function scopeDrivers(env: NodeJS.ProcessEnv = process.env): ScopeDriverSpec[] {
  const drivers: ScopeDriverSpec[] = [SIGLENT_DRIVER]
  if (env.YOMA_SCOPE_DEMO && env.YOMA_SCOPE_DEMO !== "0" && env.YOMA_SCOPE_DEMO.toLowerCase() !== "false") drivers.push(DEMO_DRIVER)
  return drivers
}

export function scopeDriver(name: string, drivers: readonly ScopeDriverSpec[] = scopeDrivers()): ScopeDriverSpec | undefined {
  return drivers.find((d) => d.name === name.toLowerCase())
}

export function standaloneDriverNames(drivers: readonly ScopeDriverSpec[] = scopeDrivers()): string[] {
  return drivers.filter((d) => d.standalone).map((d) => d.name)
}

export function usbVendorIds(drivers: readonly ScopeDriverSpec[] = scopeDrivers()): number[] {
  return [...new Set(drivers.flatMap((d) => [...d.usbVendorIds]))]
}

/** 认得注册表里独立驱动名字的地址解析(`demo` 不会被当成主机名)。 */
export function parseRegisteredAddress(value: string, drivers: readonly ScopeDriverSpec[] = scopeDrivers()): ScopeAddress {
  return parseScopeAddress(value, standaloneDriverNames(drivers))
}

export interface OpenScopeOptions extends ScopeOpenOptions {
  drivers?: readonly ScopeDriverSpec[]
}

/**
 * 打开一台仪器。带 `driver@` 的地址直接交给那个驱动;裸地址先开传输问 *IDN?,再挑第一个 `supports()` 的驱动接管。
 * 任何一步失败都关掉连接:半开的 USB 句柄会吃掉下一条查询的答案。
 */
export async function openScope(address: ScopeAddress | string, options: OpenScopeOptions = {}): Promise<ScopeDriver> {
  const drivers = options.drivers ?? scopeDrivers()
  const addr = typeof address === "string" ? parseRegisteredAddress(address, drivers) : address
  if (addr.driver) {
    const spec = scopeDriver(addr.driver, drivers)
    if (!spec) throw new Error(`scope: unknown driver "${addr.driver}"; available: ${drivers.map((d) => d.name).join(", ")}`)
    return spec.open(addr, options)
  }
  if (addr.kind === "none") throw new Error("scope: an address without a transport needs a driver name, e.g. demo")
  const client = await openScpi(addr, { connectTimeoutMs: options.connectTimeoutMs, signal: options.signal, usbVendorIds: usbVendorIds(drivers) })
  try {
    // USB 的输出队列跨连接残留(上一个进程超时留下的截图会被当成 *IDN? 的答案),先清。
    await client.drain(200)
    const line = await client.query("*IDN?", { timeoutMs: 3000, signal: options.signal })
    const idn = parseIdn(line)
    const spec = drivers.find((d) => d.attach && d.supports(idn))
    if (!spec?.attach)
      throw new Error(
        `scope: ${scopeAddressKey(addr)} answered *IDN? with "${line}" — no driver for this instrument (drivers: ${drivers.map((d) => d.name).join(", ")}). Give an explicit driver@address if you know which one applies.`,
      )
    return await spec.attach(client, addr, idn)
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }
}

/** 总线上所有已注册厂商的仪器(不打开)。 */
export function discoverUsbScopes(drivers: readonly ScopeDriverSpec[] = scopeDrivers()): Promise<UsbScopeInfo[]> {
  return listUsbScopes(usbVendorIds(drivers))
}

/** 给模型看的目录:每个驱动一行,标明哪些型号真机验过。 */
export function scopeCatalog(drivers: readonly ScopeDriverSpec[] = scopeDrivers()): { name: string; description: string; models: ReturnType<ScopeDriverSpec["models"]> }[] {
  return drivers.map((d) => ({ name: d.name, description: d.description, models: d.models() }))
}

export { formatScopeAddress }
