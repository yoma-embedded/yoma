import { access, readFile, readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { readLedger, readLocalOverrides } from "../toolchain/ledger.ts"

export class Stm32ResourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`)
    this.name = "Stm32ResourceError"
  }
}

export async function exists(file: string) {
  return access(file).then(
    () => true,
    () => false,
  )
}

export async function configuredSources(projectDir: string, configDir: string, env: NodeJS.ProcessEnv) {
  const [local, ledger] = await Promise.all([readLocalOverrides(projectDir), readLedger(configDir)])
  const recorded = (id: string) => Object.values((local[id] ?? ledger.entries[id])?.bin ?? {})[0]
  return {
    db: recorded("stm32cubemx") ?? env.STM32CK_CUBEMX_DB,
    repository: recorded("stm32cube-repository") ?? env.STM32CUBE_REPOSITORY,
  }
}

/** Repository configuration is separate from the CubeMX application installation. */
export async function firmwareRepository(explicit: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  if (explicit) {
    if (
      !(await stat(explicit).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    ) {
      throw new Stm32ResourceError(
        "STM32_FIRMWARE_SOURCE_INVALID",
        `Configured firmware repository does not exist: ${explicit}. Update STM32Cube firmware repository in Settings → Toolchain.`,
      )
    }
    return realpath(explicit)
  }
  const home = env.USERPROFILE ?? env.HOME ?? homedir()
  // CubeMX records a custom download location in its own settings. Read it before defaults.
  const settings = [path.join(home, ".stm32cubemx", "plugins", "updater", "updater.ini")]
  for (const file of settings) {
    const text = await readFile(file, "utf8").catch(() => "")
    const match = text.match(/^\s*RepositoryPath\s*=\s*(.+)\s*$/im)
    if (!match) continue
    const value = match[1]!.trim()
    if (
      await stat(value).then(
        (s) => s.isDirectory(),
        () => false,
      )
    )
      return realpath(value)
    throw new Stm32ResourceError(
      "STM32_FIRMWARE_SOURCE_INVALID",
      `CubeMX's configured firmware repository is unavailable: ${value}. Select its actual directory in Settings → Toolchain.`,
    )
  }
  const fallback = path.join(home, "STM32Cube", "Repository")
  if (
    await stat(fallback).then(
      (s) => s.isDirectory(),
      () => false,
    )
  )
    return realpath(fallback)
  throw new Stm32ResourceError(
    "STM32_FIRMWARE_MISSING",
    "No local STM32Cube firmware repository was found. Download the needed firmware with CubeMX, or select your existing STM32Cube Repository in Settings → Toolchain.",
  )
}

/** Numeric version order: 1.10 must be newer than 1.9. Keep a chosen tree fixed for one operation. */
export function compareVersions(a: string, b: string): number {
  const left = a
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number)
  const right = b
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff) return diff
  }
  return a.localeCompare(b)
}

export async function firmwarePackage(repository: string, family: string) {
  if (!/^STM32[A-Z0-9]+$/.test(family))
    throw new Stm32ResourceError("STM32_FAMILY_INVALID", `Invalid MCU family: ${family}`)
  const prefix = `STM32Cube_FW_${family.slice(5)}_V`
  const names = (await readdir(repository, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort((a, b) => compareVersions(b.slice(prefix.length), a.slice(prefix.length)))
  if (!names.length)
    throw new Stm32ResourceError(
      "STM32_FIRMWARE_MISSING",
      `No downloaded ${family} firmware is present in ${repository}. Download that family in CubeMX; chip queries and configuration validation remain available.`,
    )
  const name = names[0]!
  const root = path.join(repository, name)
  const drivers = path.join(root, "Drivers")
  const halDirs = (await readdir(drivers, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && /^STM32.*_HAL_Driver$/.test(entry.name))
    .map((entry) => entry.name)
  const deviceRoot = path.join(drivers, "CMSIS", "Device", "ST")
  const deviceDirs = (await readdir(deviceRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  if (halDirs.length !== 1 || deviceDirs.length !== 1)
    throw new Stm32ResourceError(
      "STM32_FIRMWARE_INCOMPLETE",
      `${name} does not contain an unambiguous HAL/CMSIS device tree. Repair this firmware package in CubeMX.`,
    )
  const trees = [
    { source: path.join(drivers, halDirs[0]!, "Inc"), target: `${family}/HAL_Driver/Inc` },
    { source: path.join(drivers, halDirs[0]!, "Src"), target: `${family}/HAL_Driver/Src` },
    { source: path.join(deviceRoot, deviceDirs[0]!, "Include"), target: `${family}/CMSIS_Device/Include` },
    { source: path.join(deviceRoot, deviceDirs[0]!, "Source"), target: `${family}/CMSIS_Device/Source` },
    { source: path.join(drivers, "CMSIS", "Include"), target: "CMSIS_Core/Include" },
  ]
  for (const tree of trees) {
    if (
      !(await stat(tree.source).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    )
      throw new Stm32ResourceError(
        "STM32_FIRMWARE_INCOMPLETE",
        `${name} is missing directory ${path.relative(root, tree.source)}. Repair the downloaded firmware in CubeMX.`,
      )
  }
  // A partially downloaded package may have directories but no usable headers/startup code.
  const required = [
    { dir: path.join(drivers, halDirs[0]!, "Inc"), pattern: /_hal\.h$/i },
    { dir: path.join(drivers, halDirs[0]!, "Src"), pattern: /_hal\.c$/i },
    { dir: path.join(deviceRoot, deviceDirs[0]!, "Include"), pattern: /\.h$/i },
    { dir: path.join(deviceRoot, deviceDirs[0]!, "Source/Templates/gcc"), pattern: /\.s$/i },
    { dir: path.join(deviceRoot, deviceDirs[0]!, "Source/Templates"), pattern: /^system_.*\.c$/i },
    { dir: path.join(drivers, "CMSIS/Include"), pattern: /^core_.*\.h$/i },
  ]
  for (const { dir, pattern } of required) {
    const files = await readdir(dir, { withFileTypes: true }).catch(() => [])
    if (!files.some((file) => file.isFile() && pattern.test(file.name))) {
      throw new Stm32ResourceError(
        "STM32_FIRMWARE_INCOMPLETE",
        `${name} lacks required firmware files in ${path.relative(root, dir)}. Repair this downloaded package in CubeMX.`,
      )
    }
  }
  for (const [source, target] of [
    ["Middlewares/Third_Party/FreeRTOS", "MW/FreeRTOS"],
    ["Middlewares/ST/STM32_USB_Device_Library", "MW/USB_Device"],
  ]) {
    if (await exists(path.join(root, source!))) trees.push({ source: path.join(root, source!), target: target! })
  }
  // Keep licence/provenance alongside the copied source trees.
  for (const file of ["License.md", "LICENSE.md", "LICENSE.txt", "Release_Notes.html"]) {
    if (await exists(path.join(root, file))) trees.push({ source: path.join(root, file), target: `${family}/${file}` })
  }
  for (const [source, target] of [
    [path.join(drivers, halDirs[0]!), `${family}/HAL_Driver`],
    [path.join(deviceRoot, deviceDirs[0]!), `${family}/CMSIS_Device`],
    [path.join(drivers, "CMSIS"), "CMSIS_Core"],
  ]) {
    for (const file of ["LICENSE", "LICENSE.md", "LICENSE.txt", "License.md", "License.txt"]) {
      if (await exists(path.join(source!, file)))
        trees.push({ source: path.join(source!, file), target: `${target}/${file}` })
    }
  }
  return { name, version: name.slice(prefix.length), root, family, trees }
}
