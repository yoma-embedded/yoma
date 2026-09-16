import { afterEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { NO_AMBIENT_AUTH } from "./models.ts"

import { inspectEngines } from "./preflight.ts"
import { createKernelHost } from "./index.ts"
import { ENGINE_BINARIES } from "./domain/engines.ts"

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

describe("inspectEngines", () => {
  test("missingDir / emptyShell / missingBin / ok", () => {
    expect(inspectEngines(undefined).code).toBe("missingDir")

    const missing = path.join(tempDir("yoma-eng-"), "nope")
    expect(inspectEngines(missing).code).toBe("missingDir")

    const shell = tempDir("yoma-eng-shell-")
    expect(inspectEngines(shell).code).toBe("emptyShell")

    const partial = tempDir("yoma-eng-partial-")
    mkdirSync(path.join(partial, "bin"), { recursive: true })
    const report = inspectEngines(partial)
    expect(report.code).toBe("missingBin")
    expect(report.missing.length).toBeGreaterThan(0)

    const ok = tempDir("yoma-eng-ok-")
    const bin = path.join(ok, "bin")
    mkdirSync(bin, { recursive: true })
    const exe = process.platform === "win32" ? ".exe" : ""
    for (const name of ENGINE_BINARIES) {
      writeFileSync(path.join(bin, name + exe), "")
    }
    expect(inspectEngines(ok)).toEqual({ ok: true, code: "ok", dir: ok, missing: [] })
  })

  test("只缺 rg 也算缺:grep / find 靠它,自检报 ok 会让两个工具在用户机器上静默死掉", () => {
    const dir = tempDir("yoma-eng-norg-")
    const bin = path.join(dir, "bin")
    mkdirSync(bin, { recursive: true })
    const exe = process.platform === "win32" ? ".exe" : ""
    for (const name of ENGINE_BINARIES.filter((name) => name !== "rg")) {
      writeFileSync(path.join(bin, name + exe), "")
    }
    const report = inspectEngines(dir)
    expect(report.ok).toBe(false)
    expect(report.code).toBe("missingBin")
    expect(report.missing).toEqual(["rg"])
  })

  test("旧引擎包缺本地转换器时不能报告 ready", () => {
    const dir = tempDir("yoma-eng-noimport-")
    const bin = path.join(dir, "bin")
    mkdirSync(bin, { recursive: true })
    for (const name of ENGINE_BINARIES.filter((name) => name !== "stm32ck-import")) {
      writeFileSync(path.join(bin, name + (process.platform === "win32" ? ".exe" : "")), "")
    }
    expect(inspectEngines(dir).missing).toEqual(["stm32ck-import"])
  })
})

describe("app.preflight", () => {
  test("no key → auth.missing, no engines dir → engines.missingDir", async () => {
    const saved: Record<string, string | undefined> = {}
    // key 类环境由 NO_AMBIENT_AUTH 挡掉;这两个是 yoma 自己的开关,仍直接读 process.env。
    for (const name of ["YOMA_PROVIDER", "YOMA_MODEL"]) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    try {
      const host = createKernelHost({
        sessionsRoot: tempDir("yoma-pf-sessions-"),
        stateDir: tempDir("yoma-pf-state-"),
        configDir: tempDir("yoma-pf-config-"),
        authContext: NO_AMBIENT_AUTH,
        version: "test",
        onEvents: () => {},
      })
      const report = await host.handle("app.preflight", undefined)
      expect(report.auth.ok).toBe(false)
      expect(report.auth.code).toBe("missing")
      expect(report.auth.detail).toMatch(/type":"api_key"/)
      expect(report.engines.ok).toBe(false)
      expect(report.engines.code).toBe("missingDir")
      await host.dispose()
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
