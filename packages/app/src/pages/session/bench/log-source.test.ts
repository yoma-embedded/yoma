import { describe, expect, test } from "vitest"
import {
  checkRttDevice,
  DEFAULT_MONITOR_PREFS,
  exactRttDevice,
  parseMonitorPrefs,
  parseRttSpeed,
  rttDevicePrefill,
  storeMonitorPrefs,
  type MonitorPrefs,
} from "./log-source"

describe("按工程记住的偏好", () => {
  test("旧版记录(只有串口那几项)照读,RTT 的几项补缺省", () => {
    const raw = JSON.stringify({ "/work/a": { port: "COM5", baud: "921600", ending: "crlf", encoding: "hex" } })
    expect(parseMonitorPrefs(raw, "/work/a")).toEqual({
      mode: "serial",
      port: "COM5",
      baud: "921600",
      ending: "crlf",
      encoding: "hex",
      device: "",
      speed: "4000",
    })
  })

  test("认不出的字段回落缺省;坏掉的 JSON、数组、别的工程都不抛", () => {
    const raw = JSON.stringify({
      "/work/a": { mode: "jtag", ending: "tab", encoding: "base64", port: 5, device: null },
    })
    expect(parseMonitorPrefs(raw, "/work/a")).toEqual(DEFAULT_MONITOR_PREFS)
    expect(parseMonitorPrefs("{not json", "/work/a")).toEqual(DEFAULT_MONITOR_PREFS)
    expect(parseMonitorPrefs("[1,2]", "/work/a")).toEqual(DEFAULT_MONITOR_PREFS)
    expect(parseMonitorPrefs(null, "/work/a")).toEqual(DEFAULT_MONITOR_PREFS)
    expect(parseMonitorPrefs(raw, "/work/other")).toEqual(DEFAULT_MONITOR_PREFS)
  })

  test("存 RTT 的来源、器件名与速率,读回来一样", () => {
    const prefs: MonitorPrefs = { ...DEFAULT_MONITOR_PREFS, mode: "rtt", device: "STM32G473RC", speed: "1000" }
    expect(parseMonitorPrefs(storeMonitorPrefs(null, "D:\\fw\\BK64", prefs), "D:\\fw\\BK64")).toEqual(prefs)
  })

  test("写回时别的工程留着,本工程挪到最新,最多记 16 个工程", () => {
    let raw: string | null = null
    for (let i = 0; i < 20; i++) raw = storeMonitorPrefs(raw, `/p${i}`, { ...DEFAULT_MONITOR_PREFS, port: `COM${i}` })
    raw = storeMonitorPrefs(raw, "/p10", { ...DEFAULT_MONITOR_PREFS, port: "COM99" })
    const keys = Object.keys(JSON.parse(raw!))
    expect(keys).toHaveLength(16)
    expect(keys.at(-1)).toBe("/p10")
    expect(keys).not.toContain("/p0")
    expect(keys).toContain("/p19")
    expect(parseMonitorPrefs(raw, "/p10").port).toBe("COM99")
    // 坏掉的旧记录不挡着写
    expect(parseMonitorPrefs(storeMonitorPrefs("{oops", "/x", DEFAULT_MONITOR_PREFS), "/x")).toEqual(
      DEFAULT_MONITOR_PREFS,
    )
  })
})

describe("RTT 器件名", () => {
  test("说得出是哪一颗的:CubeMX / 订货号缩短成 J-Link 的写法", () => {
    expect(exactRttDevice("STM32G473RCT6")).toBe("STM32G473RC")
    expect(exactRttDevice("STM32G473RCTx")).toBe("STM32G473RC")
    expect(exactRttDevice(" STM32G473RC ")).toBe("STM32G473RC")
    expect(exactRttDevice("STM32F103C8T6")).toBe("STM32F103C8")
    expect(exactRttDevice("STM32WB55RG")).toBe("STM32WB55RG")
    expect(exactRttDevice("STM32L4R5ZI")).toBe("STM32L4R5ZI")
    expect(exactRttDevice("STM32G0B1RET6")).toBe("STM32G0B1RE")
    expect(exactRttDevice("STM32H743XI")).toBe("STM32H743XI")
    // W 系列的产品线码字母打头:内核归一得出来,这里也得认,否则 WLE5 / WBA 的工程永远不预填。
    expect(exactRttDevice("STM32WLE5JCI6")).toBe("STM32WLE5JC")
    expect(exactRttDevice("STM32WBA52CGU6")).toBe("STM32WBA52CG")
    expect(exactRttDevice("STM32H7S7L8H6H")).toBe("STM32H7S7L8")
    expect(exactRttDevice("nRF52840_xxAA")).toBe("nRF52840_xxAA")
    expect(exactRttDevice("ATSAMD21G18")).toBe("ATSAMD21G18")
  })

  test("家族名、openocd 的配置名、CMSIS 的宏名都不当成确切型号", () => {
    expect(exactRttDevice("STM32G473R(B-C-E)Tx")).toBeUndefined()
    expect(exactRttDevice("stm32g4x")).toBeUndefined()
    expect(exactRttDevice("STM32F4xx")).toBeUndefined()
    expect(exactRttDevice("STM32G474xx")).toBeUndefined()
    expect(exactRttDevice("STM32F103xB")).toBeUndefined()
    expect(exactRttDevice("nrf52")).toBeUndefined()
    expect(exactRttDevice("esp32s3")).toBeUndefined()
    expect(exactRttDevice("STM32 G473")).toBeUndefined()
    // openocd 的 target 配置名:大写的只有通配的 X,不是 J-Link 认的型号(它要的是 ATSAMD21G18A 这种)
    for (const config of ["at91samdXX", "at91sam3XXX", "at91sam3nXX", "at91sam4XXX", "at91sam4cXXX", "at91sam4lXX"])
      expect(exactRttDevice(config)).toBeUndefined()
    expect(exactRttDevice("")).toBeUndefined()
    expect(exactRttDevice(undefined)).toBeUndefined()
  })

  test("预填:存过的 > 烧录认出来的目标 > 工程档案;说不准的只当占位提示", () => {
    expect(rttDevicePrefill({ saved: "STM32G474RE", target: "STM32G473RC", project: "STM32F103C8" })).toEqual({
      device: "STM32G474RE",
    })
    expect(rttDevicePrefill({ saved: "  ", target: "STM32G473RC", project: "STM32F103C8" })).toEqual({
      device: "STM32G473RC",
    })
    // 烧录那边只认出 openocd 的配置名:落到工程档案
    expect(rttDevicePrefill({ target: "stm32g4x", project: "STM32G473RCT6" })).toEqual({ device: "STM32G473RC" })
    // 两样都只是家族:不填,拿第一个当提示
    expect(rttDevicePrefill({ target: undefined, project: "STM32G473R(B-C-E)Tx" })).toEqual({
      device: "",
      hint: "STM32G473R(B-C-E)Tx",
    })
    expect(rttDevicePrefill({ target: "stm32g4x", project: "STM32G473R(B-C-E)Tx" })).toEqual({
      device: "",
      hint: "stm32g4x",
    })
    // 用 openocd 的 at91samdXX.cfg 烧过的 SAMD:配置名只当提示,不填进框里让 J-Link 报 unknown device
    expect(rttDevicePrefill({ target: "at91samdXX" })).toEqual({ device: "", hint: "at91samdXX" })
    expect(rttDevicePrefill({})).toEqual({ device: "" })
  })

  test("连接前的校验:空的、家族名各有说法;确切型号原样交给内核", () => {
    expect(checkRttDevice("  ")).toEqual({ error: "empty" })
    expect(checkRttDevice("STM32G473R(B-C-E)Tx")).toEqual({ error: "family" })
    expect(checkRttDevice(" STM32G473RCTx ")).toEqual({ device: "STM32G473RCTx" })
  })

  test("SWD 速率:5–50000 的整数 kHz", () => {
    expect(parseRttSpeed("4000")).toBe(4000)
    expect(parseRttSpeed(" 5 ")).toBe(5)
    expect(parseRttSpeed("50000")).toBe(50000)
    expect(parseRttSpeed("4")).toBeUndefined()
    expect(parseRttSpeed("50001")).toBeUndefined()
    expect(parseRttSpeed("1e3")).toBeUndefined()
    expect(parseRttSpeed("400.5")).toBeUndefined()
    expect(parseRttSpeed("")).toBeUndefined()
  })
})
