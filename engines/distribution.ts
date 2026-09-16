import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

/** Application code is distributed; CubeMX databases and their derivatives stay local. */
export const STM32_RESOURCE_POLICY = {
  database: "user-local-cubemx",
  irpacks: "generated-in-user-cache",
  firmware: "user-local-cubemx-repository",
} as const

// Add an engine's redistributable runtime assets here deliberately. Copying all
// of data/ can upload the developer's CubeMX database, generated packs and HAL.
const PUBLIC_DATA = ["la"] as const

export function assertNoStm32Data(root: string): void {
  if (existsSync(path.join(root, "data", "stm32"))) {
    throw new Error("STM32 user data must not be included in engine distributions (data/stm32)")
  }
  const data = path.join(root, "data")
  if (existsSync(data)) {
    for (const name of readdirSync(data)) {
      if (!(PUBLIC_DATA as readonly string[]).includes(name)) {
        throw new Error(`Unregistered engine data must not be distributed: data/${name}`)
      }
    }
  }
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.name.toLowerCase().endsWith(".irpack")) {
        throw new Error(`STM32 user data must not be included in engine distributions: ${file}`)
      }
      if (entry.isDirectory()) visit(file)
    }
  }
  visit(root)
}

/** The sole materialization path used by desktop packaging, including local engines. */
export function materializeEngineResources(source: string, destination: string): void {
  if (existsSync(path.join(destination, "bin")) || existsSync(path.join(destination, "data"))) {
    throw new Error("Engine staging destination must be empty")
  }
  cpSync(path.join(source, "bin"), path.join(destination, "bin"), { recursive: true, dereference: true })
  mkdirSync(path.join(destination, "data"), { recursive: true })
  for (const name of PUBLIC_DATA) {
    const from = path.join(source, "data", name)
    if (existsSync(from)) {
      cpSync(from, path.join(destination, "data", name), { recursive: true, dereference: true })
    }
  }
  assertNoStm32Data(destination)

  // Recompute the staged manifest: legacy irpack counts and firmware flags
  // describe the source machine, not what the installer is allowed to ship.
  const sourceManifest = path.join(source, "manifest.json")
  const metadata = existsSync(sourceManifest)
    ? (JSON.parse(readFileSync(sourceManifest, "utf8")) as Record<string, unknown>)
    : {}
  const bin = Object.fromEntries(
    readdirSync(path.join(destination, "bin")).map((name) => {
      const file = path.join(destination, "bin", name)
      return [name, { bytes: statSync(file).size, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }]
    }),
  )
  writeFileSync(
    path.join(destination, "manifest.json"),
    JSON.stringify(
      {
        platform: metadata.platform,
        arch: metadata.arch,
        builtAt: metadata.builtAt,
        la: metadata.la,
        stm32: STM32_RESOURCE_POLICY,
        bin,
      },
      null,
      2,
    ) + "\n",
  )
}
