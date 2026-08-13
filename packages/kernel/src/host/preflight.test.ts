import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { inspectEngines, parseProbeList } from "./preflight.ts"
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

describe("parseProbeList", () => {
  test("picks indexed probe-rs list rows", () => {
    const output = [
      "The following debug probes were found:",
      "[0]: STLink V2 (VID:PID 0483:374b, Serial: 1234)",
      "[1]: J-Link (VID:PID 1366:0105)",
    ].join("\n")
    expect(parseProbeList(output)).toEqual([
      "STLink V2 (VID:PID 0483:374b, Serial: 1234)",
      "J-Link (VID:PID 1366:0105)",
    ])
  })

  test("empty / prose does not invent a device", () => {
    expect(parseProbeList("Error: no probe found")).toEqual([])
    expect(parseProbeList("")).toEqual([])
  })
})

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
    for (const name of ["stm32kernel", "probe-rs", "controller_map", "board_ir", "connections"]) {
      writeFileSync(path.join(bin, name + exe), "")
    }
    expect(inspectEngines(ok)).toEqual({ ok: true, code: "ok", dir: ok, missing: [] })
  })
})

describe("app.preflight", () => {
  test("no key → auth.missing, no engines dir → engines.missingDir, probe skipped", async () => {
    const saved: Record<string, string | undefined> = {}
    for (const name of ["MY_PI_PROVIDER", "MY_PI_MODEL", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY"]) {
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
      expect(report.probe.code).toBe("skipped")
      await host.dispose()
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
