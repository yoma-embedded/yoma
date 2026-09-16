import { homedir } from "node:os"
import path from "node:path"
import { assertEngineSettled, engineBin, runEngine } from "../engines.ts"
import { aborted } from "./cache.ts"
import { configuredSources, Stm32ResourceError } from "./sources.ts"

export interface Stm32ProbeOptions {
  projectDir: string
  configDir?: string
  enginesDir?: string
  signal?: AbortSignal
  /** The calling session's immutable execution environment. */
  env?: NodeJS.ProcessEnv
}

export interface Stm32DatabaseProbe {
  dbPath: string
  dbVersion: string
  families: string[]
}

/** The same read-only discovery is used by tool availability and actual preparation. */
export async function probeStm32Database(
  options: Stm32ProbeOptions,
  deps: { run?: typeof runEngine; env?: NodeJS.ProcessEnv } = {},
) {
  aborted(options.signal)
  const env = options.env ?? deps.env ?? process.env
  const configDir = options.configDir ?? path.join(homedir(), ".yoma")
  const sources = await configuredSources(options.projectDir, configDir, env)
  const importer = engineBin("stm32ck-import", options)
  const result = assertEngineSettled(
    await (deps.run ?? runEngine)(importer, ["--probe", ...(sources.db ? ["--cubemx-db", sources.db] : [])], {
      cwd: options.projectDir,
      env,
      signal: options.signal,
      timeoutMs: 10_000,
    }),
    "CubeMX database discovery",
  )
  aborted(options.signal)
  if (result.exitCode !== 0) {
    throw new Stm32ResourceError("STM32_DB_UNAVAILABLE", (result.stderr || result.stdout).trim().slice(-2000))
  }
  let database: Stm32DatabaseProbe
  try {
    database = JSON.parse(result.stdout) as Stm32DatabaseProbe
    if (
      !path.isAbsolute(database.dbPath) ||
      typeof database.dbVersion !== "string" ||
      !Array.isArray(database.families) ||
      !database.families.length ||
      database.families.some((family) => typeof family !== "string" || !/^STM32[A-Z0-9]+$/.test(family))
    )
      throw new Error()
  } catch {
    throw new Stm32ResourceError(
      "STM32_IMPORTER_PROTOCOL",
      "The installed STM32 importer returned invalid database metadata. Reinstall Yoma.",
    )
  }
  return { database, sources, importer, configDir }
}
