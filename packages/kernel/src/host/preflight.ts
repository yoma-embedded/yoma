/** 首跑预检:配 key、认引擎、认探针。失败带 code。 */

import { existsSync } from "node:fs"
import path from "node:path"

import { ENGINE_BINARIES, exe, runEngine } from "@yoma/my-pi-coding-agent"

import type { PreflightAuth, PreflightEngines, PreflightProbe, PreflightReport } from "../protocol.ts"
import { authFilePath } from "./auth.ts"
import type { SessionManager } from "./session-manager.ts"

const PROBE_LIST_TIMEOUT_MS = 8_000

export async function runPreflight(input: {
  sessions: SessionManager
  configDir: string
  enginesDir?: string
}): Promise<PreflightReport> {
  const auth = await inspectAuth(input.sessions, input.configDir)
  const engines = inspectEngines(input.enginesDir)
  const probe = engines.ok && engines.dir ? await inspectProbe(engines.dir) : skippedProbe(engines)
  return { auth, engines, probe }
}

async function inspectAuth(sessions: SessionManager, configDir: string): Promise<PreflightAuth> {
  const file = authFilePath(configDir)
  const catalog = await sessions.providers()
  const providers = catalog.filter((item) => item.authenticated).map((item) => item.id)
  if (providers.length) return { ok: true, code: "ok", file, providers }

  const error = sessions.modelStatus().error
  const missing = !error || /no usable provider/i.test(error) || /no api key/i.test(error)
  return {
    ok: false,
    code: missing ? "missing" : "error",
    file,
    providers: [],
    detail: error,
  }
}

export function inspectEngines(enginesDir: string | undefined): PreflightEngines {
  if (!enginesDir) {
    return { ok: false, code: "missingDir", dir: null, missing: [...ENGINE_BINARIES] }
  }
  if (!existsSync(enginesDir)) {
    return {
      ok: false,
      code: "missingDir",
      dir: enginesDir,
      missing: [...ENGINE_BINARIES],
      detail: enginesDir,
    }
  }
  const binDir = path.join(enginesDir, "bin")
  if (!existsSync(binDir)) {
    return {
      ok: false,
      code: "emptyShell",
      dir: enginesDir,
      missing: [...ENGINE_BINARIES],
      detail: enginesDir,
    }
  }
  const missing = ENGINE_BINARIES.filter((name) => !existsSync(path.join(binDir, exe(name))))
  if (missing.length) {
    return { ok: false, code: "missingBin", dir: enginesDir, missing, detail: missing.join(", ") }
  }
  return { ok: true, code: "ok", dir: enginesDir, missing: [] }
}

function skippedProbe(engines: PreflightEngines): PreflightProbe {
  return { ok: false, code: "skipped", devices: [], detail: engines.code }
}

async function inspectProbe(enginesDir: string): Promise<PreflightProbe> {
  const bin = path.join(enginesDir, "bin", exe("probe-rs"))
  if (!existsSync(bin)) return { ok: false, code: "skipped", devices: [] }

  let result: Awaited<ReturnType<typeof runEngine>>
  try {
    result = await runEngine(bin, ["list"], { timeoutMs: PROBE_LIST_TIMEOUT_MS })
  } catch (error) {
    return { ok: false, code: "error", devices: [], detail: (error as Error).message }
  }
  if (result.timedOut) return { ok: false, code: "error", devices: [], detail: "probe-rs list timed out" }

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n")
  const devices = parseProbeList(output)
  if (devices.length) return { ok: true, code: "ok", devices }
  if (/no probe/i.test(output)) return { ok: false, code: "none", devices: [] }
  if (result.exitCode !== 0) return { ok: false, code: "error", devices: [], detail: output.trim() || `exit ${result.exitCode}` }
  return { ok: false, code: "none", devices: [] }
}

/** 抽出 probe-rs list 的 `[0]: …` 行。 */
export function parseProbeList(output: string): string[] {
  const devices: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    const indexed = trimmed.match(/^\[(\d+)\]:\s*(.+)$/)
    if (indexed) {
      devices.push(indexed[2]!.trim())
      continue
    }
  }
  return devices
}
