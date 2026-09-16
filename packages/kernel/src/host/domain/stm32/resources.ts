/** User-owned CubeMX sources -> verified local snapshots. No downloads or bundled ST data. */
import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { assertEngineSettled, engineBin, runEngine } from "../engines.ts"
import { aborted, digest, fileDigest, snapshot, treeDigest } from "./cache.ts"
import { exists, firmwarePackage, firmwareRepository, Stm32ResourceError } from "./sources.ts"
import { probeStm32Database } from "./probe.ts"

export interface Stm32ResourceOptions {
  enginesDir?: string
  configDir?: string
  projectDir: string
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  part?: string
  firmware?: boolean
  onProgress?: (message: string) => void
}

export interface Stm32Resources {
  dataDir: string
  fwDir?: string
  manifestPath: string
  families: string[]
}

const MANIFEST = "stm32-resources.json"
// Bump when normalization/layout changes. Engine hashes cover importer and IR schema changes.
const FORMAT = 1

async function databaseHash(db: string, signal?: AbortSignal) {
  const sources: Record<string, string> = {}
  for (const dir of ["mcu", "plugins/clock"]) {
    const root = path.join(db, dir)
    if (await exists(root)) sources[dir] = (await treeDigest(root, signal)).hash
  }
  if (await exists(path.join(db, "package.xml"))) sources.package = await fileDigest(path.join(db, "package.xml"))
  return digest(JSON.stringify(sources))
}

async function firmwareHash(trees: Array<{ source: string; target: string }>, signal?: AbortSignal) {
  const content: Record<string, string> = {}
  for (const tree of trees) {
    aborted(signal)
    content[tree.target] = (await stat(tree.source)).isDirectory()
      ? (await treeDigest(tree.source, signal)).hash
      : await fileDigest(tree.source)
  }
  return digest(JSON.stringify(content))
}

/** Dependency injection for isolated tests; production callers use prepareStm32Resources. */
export function createStm32ResourcePreparer(deps: { run?: typeof runEngine; env?: NodeJS.ProcessEnv } = {}) {
  const run = deps.run ?? runEngine
  return async function prepare(options: Stm32ResourceOptions): Promise<Stm32Resources> {
    const { signal, onProgress } = options
    aborted(signal)
    const env = options.env ?? deps.env ?? process.env
    const { database: probe, sources, importer, configDir } = await probeStm32Database(options, { run, env })
    const kernel = engineBin("stm32kernel", options)
    const exec = async (
      bin: string,
      args: string[],
      code: string,
      abort = signal,
      progress?: (message: string) => void,
    ) => {
      aborted(abort)
      const result = assertEngineSettled(
        await run(bin, args, {
          cwd: options.projectDir,
          env,
          signal: abort,
          timeoutMs: 10 * 60_000,
          onOutput: progress
            ? ({ stream, text }) => {
                if (stream === "stderr") progress(text.slice(-2000))
              }
            : undefined,
        }),
        "STM32 local resources",
      )
      if (result.exitCode !== 0)
        throw new Stm32ResourceError(code, (result.stderr || result.stdout).trim().slice(-4000))
      return result.stdout
    }
    const families = [...new Set(probe.families)].sort()
    onProgress?.(`Checking local CubeMX database ${probe.dbVersion} (${families.length} families)…`)
    const [dbHash, importerHash, kernelHash] = await Promise.all([
      databaseHash(probe.dbPath, signal),
      fileDigest(importer),
      fileDigest(kernel),
    ])
    const manifest = {
      schema: "yoma/stm32-resources@1",
      format: FORMAT,
      database: { version: probe.dbVersion, sha256: dbHash, families },
      engines: { importer: importerHash, kernel: kernelHash },
    }
    const key = digest(JSON.stringify(manifest))
    const cache = path.join(configDir, "stm32", "cache")
    const base = await snapshot(
      path.join(cache, "database"),
      key,
      async (stage, abort, progress) => {
        progress("Preparing chip data from local CubeMX; this runs once for each database / engine version…")
        const data = path.join(stage, "packs")
        await exec(
          importer,
          ["--cubemx-db", probe.dbPath, "--all", "--quiet-lint", "--out", data],
          "STM32_IMPORT_FAILED",
          abort,
          progress,
        )
        const packs = (await readdir(data))
          .filter((f) => f.endsWith(".irpack"))
          .map((f) => f.slice(0, -7).toUpperCase())
          .sort()
        if (JSON.stringify(packs) !== JSON.stringify(families)) {
          throw new Stm32ResourceError(
            "STM32_IMPORT_INCOMPLETE",
            "The importer did not produce all detected families. The incomplete result was discarded.",
          )
        }
        // The consumer must read the result before it becomes the active snapshot.
        await exec(kernel, ["list-mcus", "--data-dir", data], "STM32_PACK_INCOMPATIBLE", abort)
        if ((await databaseHash(probe.dbPath, abort)) !== dbHash) {
          throw new Stm32ResourceError(
            "STM32_SOURCE_CHANGED",
            "CubeMX data changed while preparing it. Retry after CubeMX finishes updating.",
          )
        }
        await writeFile(path.join(stage, MANIFEST), JSON.stringify(manifest, null, 2) + "\n")
      },
      signal,
      onProgress,
    )
    const dataDir = path.join(base, "packs")
    if (!options.firmware) return { dataDir, manifestPath: path.join(base, MANIFEST), families }
    if (!options.part)
      throw new Stm32ResourceError("STM32_PART_REQUIRED", "Preparing firmware requires the configuration's mcu.part.")
    const description = JSON.parse(
      await exec(kernel, ["describe-mcu", options.part, "--data-dir", dataDir], "STM32_PART_UNKNOWN"),
    ) as { part?: { family?: string } }
    // Same explicit alias as the importer; family comes from chip metadata, never a prefix guess.
    const family = description.part?.family?.replace(/^STM32L4\+$/, "STM32L4")
    if (!family) throw new Stm32ResourceError("STM32_PART_UNKNOWN", `No family metadata for ${options.part}`)
    const repository = await firmwareRepository(sources.repository, env)
    const firmware = await firmwarePackage(repository, family)
    onProgress?.(`Checking local firmware ${firmware.name}…`)
    const fwHash = await firmwareHash(firmware.trees, signal)
    const fullManifest = {
      ...manifest,
      firmware: { family, package: firmware.name, version: firmware.version, sha256: fwHash },
    }
    const fwKey = digest(JSON.stringify(fullManifest))
    const prepared = await snapshot(
      path.join(cache, "firmware"),
      fwKey,
      async (stage, abort, progress) => {
        progress(`Preparing HAL / CMSIS and available middleware from ${firmware.name}…`)
        for (const tree of firmware.trees) {
          aborted(abort)
          const target = path.join(stage, "fw", tree.target)
          await mkdir(path.dirname(target), { recursive: true })
          await cp(tree.source, target, { recursive: true, dereference: true })
        }
        if ((await firmwareHash(firmware.trees, abort)) !== fwHash) {
          throw new Stm32ResourceError(
            "STM32_SOURCE_CHANGED",
            "CubeMX firmware changed while preparing it. Retry after CubeMX finishes updating.",
          )
        }
        await writeFile(path.join(stage, MANIFEST), JSON.stringify(fullManifest, null, 2) + "\n")
      },
      signal,
      onProgress,
    )
    return { dataDir, fwDir: path.join(prepared, "fw"), manifestPath: path.join(prepared, MANIFEST), families }
  }
}

export const prepareStm32Resources = createStm32ResourcePreparer()
