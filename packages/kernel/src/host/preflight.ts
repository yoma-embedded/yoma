/**
 * 首跑预检:配 key、认引擎。失败带 code。
 *
 * 2026-08 起没有探针预检:从前那一段就是 `probe-rs list`,probe-rs 移除后没有
 * 跨厂商的探针枚举器可替(J-Link 走原厂驱动、OpenOCD 无 list 命令)——
 * "插没插调试器"改由烧录/调试那一步的分诊话术兜着。
 */

import { existsSync } from "node:fs"
import path from "node:path"

import { ENGINE_BINARIES, exe } from "@yoma/coding-agent"

import type { PreflightAuth, PreflightEngines, PreflightReport } from "../protocol.ts"
import { authFilePath } from "./auth.ts"
import type { SessionManager } from "./session-manager.ts"

export async function runPreflight(input: {
  sessions: SessionManager
  configDir: string
  enginesDir?: string
}): Promise<PreflightReport> {
  const auth = await inspectAuth(input.sessions, input.configDir)
  const engines = inspectEngines(input.enginesDir)
  return { auth, engines }
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

