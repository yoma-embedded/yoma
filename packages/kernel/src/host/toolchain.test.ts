/**
 * toolchain.status / toolchain.set RPC(host/toolchain.ts)的验证。
 *
 * 只测这一层胶水,不重测七档探测与验证本身 —— 那些在 coding-agent 的
 * toolchain-{resolve,tool}.test.ts 里。这里要证明的是四件事:三种视图形态(没声明 /
 * 清单坏了 / 正常核账)折叠得对;fresh 真的绕过并写回账本;set 走的是与 agent 工具
 * 同一套验证(坏路径带清楚理由 reject);set 成功后返回的是落账后的真实状态。
 *
 * env 全程显式注入(PATH 空字符串起步)—— 不注入的话这台开发机上真装了什么会悄悄
 * 影响 missing 判定(coding-agent 那几个测试文件同一条纪律)。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readLedger } from "@yoma/coding-agent"

import { toolchainFamilies, toolchainFamilySet, toolchainFamilyStatus, toolchainSet, toolchainStatus } from "./toolchain.ts"

let projectDir: string
let configDir: string
let binDir: string

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "yoma-tc-rpc-project-"))
  configDir = mkdtempSync(path.join(tmpdir(), "yoma-tc-rpc-config-"))
  binDir = mkdtempSync(path.join(tmpdir(), "yoma-tc-rpc-bin-"))
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
  // 被 probeVersion 起过的假工具在 Windows 上偶尔句柄释放慢一拍,直删撞 EBUSY
  // (coding-agent 的 toolchain-*.test.ts 同一条注释)。
  rmSync(binDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/** 造一个能被 probeVersion spawn 的假工具,打印一行版本号就退出。返回绝对路径。 */
function writeFakeExe(dir: string, name: string, version: string): string {
  if (process.platform === "win32") {
    const file = path.join(dir, `${name}.bat`)
    writeFileSync(file, `@echo off\r\necho ${version}\r\n`)
    return file
  }
  const file = path.join(dir, name)
  writeFileSync(file, `#!/bin/sh\necho "${version}"\n`)
  chmodSync(file, 0o755)
  return file
}

function writeManifest(tools: unknown[]): void {
  mkdirSync(path.join(projectDir, ".yoma"), { recursive: true })
  writeFileSync(path.join(projectDir, ".yoma", "toolchain.json"), JSON.stringify({ schema: "yoma/toolchain@1", tools }))
}

function baseOpts(pathDirs: string[] = []) {
  return {
    directory: projectDir,
    configDir,
    side: "mother" as const,
    probe: {
      platform: process.platform,
      env: { PATH: pathDirs.join(path.delimiter), PATHEXT: ".EXE;.CMD;.BAT;.COM" },
    },
  }
}

describe("toolchain.status", () => {
  it("项目没声明清单:declared:false、无 error、tools 空 —— UI 据此给引导文案", async () => {
    const view = await toolchainStatus(baseOpts())
    expect(view).toEqual({ declared: false, manifestPath: undefined, side: "mother", ok: true, tools: [] })
  })

  it("清单存在但内容坏了:declared:false + error 带人话 —— 设置页正是排查它的地方,不抛", async () => {
    mkdirSync(path.join(projectDir, ".yoma"), { recursive: true })
    writeFileSync(path.join(projectDir, ".yoma", "toolchain.json"), "{ not json")

    const view = await toolchainStatus(baseOpts())
    expect(view.declared).toBe(false)
    expect(view.ok).toBe(false)
    expect(view.error).toMatch(/not valid JSON/)
  })

  it("正常核账:逐工具给判定,manifestPath 指向清单文件", async () => {
    writeFakeExe(binDir, "widget", "1.2.3")
    writeManifest([
      { id: "widget", bin: ["widget"] },
      { id: "gizmo", bin: ["gizmo"], install: { win32: "get gizmo", darwin: "get gizmo", linux: "get gizmo" } },
    ])

    const view = await toolchainStatus(baseOpts([binDir]))
    expect(view.declared).toBe(true)
    expect(view.manifestPath).toBe(path.join(projectDir, ".yoma", "toolchain.json"))
    expect(view.ok).toBe(false) // gizmo 非 optional 且缺失
    expect(view.tools.map((t) => [t.id, t.status])).toEqual([
      ["widget", "ok"],
      ["gizmo", "missing"],
    ])
    expect(view.tools[1].hint).toBe("get gizmo")
    // status 是纯读:不写账本(fresh 才写)。
    expect((await readLedger(configDir)).entries).toEqual({})
  })

  it("fresh:true 绕过账本重新探测,并把新结果写回账本(同 agent 工具的 resolve 动作)", async () => {
    writeFakeExe(binDir, "widget", "2.0.0")
    writeManifest([{ id: "widget", bin: ["widget"] }])

    const view = await toolchainStatus({ ...baseOpts([binDir]), fresh: true })
    expect(view.tools[0].status).toBe("ok")

    const ledger = await readLedger(configDir)
    expect(ledger.entries.widget?.version).toBe("2.0.0")
    expect(ledger.entries.widget?.by).toBe("auto")
  })
})

describe("toolchain.set", () => {
  it("坏路径带清楚理由 reject(与 agent 工具同一套验证),账本不动", async () => {
    writeManifest([{ id: "widget", bin: ["widget"] }])
    await expect(
      toolchainSet({ ...baseOpts(), id: "widget", path: path.join(binDir, "does-not-exist.exe") }),
    ).rejects.toThrow(/does not exist/)
    expect((await readLedger(configDir)).entries).toEqual({})
  })

  it("好路径记进账本(by:user),返回落账后的核账结果:该工具 ok 且 source 是 ledger", async () => {
    const exe = writeFakeExe(binDir, "widget", "3.1.4")
    writeManifest([{ id: "widget", bin: ["widget"] }])

    // PATH 留空:证明 set 之后的 ok 来自账本记录,不是探测顺路撞见的。
    const view = await toolchainSet({ ...baseOpts(), id: "widget", path: exe })
    const widget = view.tools[0]
    expect(widget.status).toBe("ok")
    expect(widget.source).toBe("ledger")
    expect(widget.version).toBe("3.1.4")

    const ledger = await readLedger(configDir)
    expect(ledger.entries.widget?.by).toBe("user")
    expect(Object.values(ledger.entries.widget?.bin ?? {})).toEqual([exe])
  })

  it("贴目录:按清单声明的 bin 名在目录里解析出可执行文件再入账(记的是文件,不是目录)", async () => {
    const exe = writeFakeExe(binDir, "widget", "3.1.4")
    writeManifest([{ id: "widget", bin: ["widget"] }])

    const view = await toolchainSet({ ...baseOpts(), id: "widget", path: binDir })
    expect(view.tools[0].status).toBe("ok")

    const ledger = await readLedger(configDir)
    // PATHEXT 展开的扩展名大小写取自 PATHEXT(通常大写),Windows 文件系统不分大小写 —— 按小写比较。
    expect(Object.values(ledger.entries.widget?.bin ?? {}).map((p) => p.toLowerCase())).toEqual([exe.toLowerCase()])
  })
})

// ─── 机器级(按芯片平台)────────────────────────────────────────────────────────
//
// platform 一律注入 "linux":family 预设用的是真实工具 id(jlink / cmake / …),表里
// 有它们的 well-known/registry 条目 —— 按 process.platform 跑的话,开发机上真装的
// SEGGER / CMake 会悄悄让 missing 断言时红时绿(win32 还会真起 reg.exe)。linux 的
// 表条目在这台机器上展开为空,PATH 档又完全受注入的 env 控制,判定于是只由测试
// 自己摆的东西决定。PATHEXT 照常注入 —— 假工具在 win32 上是 .bat,PATH 档的展开
// 逻辑按"env 里有没有 PATHEXT"切换,与 platform 参数无关(locations.ts 的既有语义)。

function familyOpts(pathDirs: string[] = [], extraEnv: Record<string, string> = {}) {
  return {
    configDir,
    side: "mother" as const,
    probe: {
      platform: "linux",
      env: { PATH: pathDirs.join(path.delimiter), PATHEXT: ".EXE;.CMD;.BAT;.COM", ...extraEnv },
    },
  }
}

describe("toolchain.families", () => {
  it("目录带全预设平台,工具行带 title/pathKind;账本为空时 recordedIds 为空", async () => {
    const view = await toolchainFamilies({ configDir })
    expect(view.recordedIds).toEqual([])
    const stm32 = view.families.find((family) => family.id === "stm32")
    expect(stm32).toBeDefined()
    const armGcc = stm32?.tools.find((tool) => tool.id === "arm-gcc")
    expect(armGcc?.pathKind).toBe("exe")
    expect(armGcc?.title).not.toBe("")
    // dir 型条目(手填安装目录)至少有一个 —— UI 的占位文案分支靠它。
    expect(stm32?.tools.some((tool) => tool.pathKind === "dir")).toBe(true)
  })

  it("记过账后 recordedIds 里能看到 —— 首跑提醒的消失条件", async () => {
    const exe = writeFakeExe(binDir, "arm-none-eabi-gcc", "13.2.1")
    await toolchainFamilySet({ ...familyOpts(), family: "stm32", id: "arm-gcc", path: exe })
    const view = await toolchainFamilies({ configDir })
    expect(view.recordedIds).toEqual(["arm-gcc"])
  })
})

describe("toolchain.familyStatus", () => {
  it("未知平台直接 reject —— 那是调用方代码写错,不折叠成 error 视图", async () => {
    await expect(toolchainFamilyStatus({ ...familyOpts(), family: "z80" })).rejects.toThrow(/未知芯片平台/)
  })

  it("不需要项目:declared 恒为 true,PATH 上的工具判 ok,其余 missing 且带安装指引", async () => {
    writeFakeExe(binDir, "arm-none-eabi-gcc", "13.2.1")

    const view = await toolchainFamilyStatus({ ...familyOpts([binDir]), family: "stm32" })
    expect(view.declared).toBe(true)
    expect(view.error).toBeUndefined()

    const byId = new Map(view.tools.map((tool) => [tool.id, tool]))
    expect(byId.get("arm-gcc")?.status).toBe("ok")
    expect(byId.get("arm-gcc")?.source).toBe("path")
    expect(byId.get("cmake")?.status).toBe("missing")
    // 安装指引来自预设数据,linux 档位注入下取的是 linux 那条。
    expect(byId.get("cmake")?.hint).toContain("apt install cmake")
    // stm32 平台唯一的必备工具是 arm-gcc —— 它 ok 则整体 ok,其余 optional 缺失不拉红。
    expect(view.ok).toBe(true)
    // 纯读:不写账本(fresh 才写)。
    expect((await readLedger(configDir)).entries).toEqual({})
  })

  it("env 档:IDF_PATH 指向存在的目录即判 ok(目录型工具,版本未知不碍事)", async () => {
    const view = await toolchainFamilyStatus({ ...familyOpts([], { IDF_PATH: binDir }), family: "esp32" })
    const idf = view.tools.find((tool) => tool.id === "idf")
    expect(idf?.status).toBe("ok")
    expect(idf?.source).toBe("env")
  })

  it("fresh:true 把探到的结果写回机器账本(by:auto)", async () => {
    writeFakeExe(binDir, "arm-none-eabi-gcc", "13.2.1")
    await toolchainFamilyStatus({ ...familyOpts([binDir]), family: "stm32", fresh: true })
    const ledger = await readLedger(configDir)
    expect(ledger.entries["arm-gcc"]?.by).toBe("auto")
    expect(ledger.entries["arm-gcc"]?.version).toBe("13.2.1")
  })
})

describe("toolchain.familySet", () => {
  it("exe 型走严格档:好路径带版本入账,返回的核账里该工具 ok 且 source 是 ledger", async () => {
    const exe = writeFakeExe(binDir, "arm-none-eabi-gcc", "13.2.1")
    const view = await toolchainFamilySet({ ...familyOpts(), family: "stm32", id: "arm-gcc", path: exe })
    const armGcc = view.tools.find((tool) => tool.id === "arm-gcc")
    expect(armGcc?.status).toBe("ok")
    expect(armGcc?.source).toBe("ledger")

    const ledger = await readLedger(configDir)
    expect(ledger.entries["arm-gcc"]?.by).toBe("user")
    expect(ledger.entries["arm-gcc"]?.version).toBe("13.2.1")
  })

  it("dir 型只验存在:目录入账无版本,核账靠账本记录判 ok —— GUI/目录条目的正门", async () => {
    const installDir = path.join(binDir, "STM32CubeMX")
    mkdirSync(installDir, { recursive: true })

    const view = await toolchainFamilySet({ ...familyOpts(), family: "stm32", id: "stm32cubemx", path: installDir })
    const cubemx = view.tools.find((tool) => tool.id === "stm32cubemx")
    expect(cubemx?.status).toBe("ok")
    expect(cubemx?.source).toBe("ledger")

    const ledger = await readLedger(configDir)
    expect(ledger.entries.stm32cubemx?.by).toBe("user")
    expect(ledger.entries.stm32cubemx?.version).toBeUndefined()
  })

  it("exe 型贴目录:按预设声明的 bin 名解析出可执行文件再入账(截图里 JLink_V958 那种输入)", async () => {
    const exe = writeFakeExe(binDir, "arm-none-eabi-gcc", "13.2.1")

    const view = await toolchainFamilySet({ ...familyOpts(), family: "stm32", id: "arm-gcc", path: binDir })
    const armGcc = view.tools.find((tool) => tool.id === "arm-gcc")
    expect(armGcc?.status).toBe("ok")

    const ledger = await readLedger(configDir)
    expect(Object.values(ledger.entries["arm-gcc"]?.bin ?? {}).map((p) => p.toLowerCase())).toEqual([exe.toLowerCase()])
  })

  it("exe 型贴了没有对应可执行文件的目录:不 reject,原样记录目录本身,核账因账本记录判 ok", async () => {
    const uv4Dir = path.join(binDir, "UV4")
    mkdirSync(uv4Dir, { recursive: true })

    const view = await toolchainFamilySet({ ...familyOpts(), family: "stm32", id: "keil", path: uv4Dir })
    const keil = view.tools.find((tool) => tool.id === "keil")
    expect(keil?.status).toBe("ok")

    const ledger = await readLedger(configDir)
    expect(Object.values(ledger.entries.keil?.bin ?? {})).toEqual([uv4Dir])
    expect(ledger.entries.keil?.version).toBeUndefined()
  })

  it("exe 型对不存在的路径照样 reject(与项目 toolchain.set 同一套拒绝理由),账本不动", async () => {
    await expect(
      toolchainFamilySet({ ...familyOpts(), family: "stm32", id: "arm-gcc", path: path.join(binDir, "nope") }),
    ).rejects.toThrow(/does not exist/)
    expect((await readLedger(configDir)).entries).toEqual({})
  })

  it("平台预设里没有的工具 id 直接 reject", async () => {
    await expect(
      toolchainFamilySet({ ...familyOpts(), family: "esp32", id: "arm-gcc", path: binDir }),
    ).rejects.toThrow(/没有工具/)
  })
})
