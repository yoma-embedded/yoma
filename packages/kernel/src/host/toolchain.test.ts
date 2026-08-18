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
import { readLedger } from "@yoma/my-pi-coding-agent"

import { toolchainSet, toolchainStatus } from "./toolchain.ts"

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
  mkdirSync(path.join(projectDir, ".my-pi"), { recursive: true })
  writeFileSync(path.join(projectDir, ".my-pi", "toolchain.json"), JSON.stringify({ schema: "yoma/toolchain@1", tools }))
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
    mkdirSync(path.join(projectDir, ".my-pi"), { recursive: true })
    writeFileSync(path.join(projectDir, ".my-pi", "toolchain.json"), "{ not json")

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
    expect(view.manifestPath).toBe(path.join(projectDir, ".my-pi", "toolchain.json"))
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
})
