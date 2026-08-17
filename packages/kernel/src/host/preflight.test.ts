import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { inspectEngines } from "./preflight.ts"
import { createKernelHost } from "./index.ts"

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
    for (const name of ["stm32kernel", "controller_map", "board_ir", "connections"]) {
      writeFileSync(path.join(bin, name + exe), "")
    }
    expect(inspectEngines(ok)).toEqual({ ok: true, code: "ok", dir: ok, missing: [] })
  })
})

describe("app.preflight", () => {
  test("no key → auth.missing, no engines dir → engines.missingDir", async () => {
    const saved: Record<string, string | undefined> = {}
    for (const name of ["YOMA_PROVIDER", "YOMA_MODEL", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY"]) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    try {
      const host = createKernelHost({
        sessionsRoot: tempDir("yoma-pf-sessions-"),
        stateDir: tempDir("yoma-pf-state-"),
        configDir: tempDir("yoma-pf-config-"),
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
