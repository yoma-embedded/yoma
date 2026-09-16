import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { exe, type EngineRunResult, type runEngine } from "../src/host/domain/engines.ts"
import { inspectStm32Availability } from "../src/host/domain/stm32/availability.ts"
import { writeLedgerEntry } from "../src/host/domain/toolchain/ledger.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 })
})
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "yoma-stm32-availability-"))
  roots.push(root)
  const enginesDir = path.join(root, "engines")
  const configDir = path.join(root, "config")
  await mkdir(path.join(enginesDir, "bin"), { recursive: true })
  await mkdir(configDir)
  for (const name of ["stm32kernel", "stm32ck-import"])
    await writeFile(path.join(enginesDir, "bin", exe(name)), "fixture")
  return { root, configDir, enginesDir, projectDir: root }
}
function result(stdout: string, exitCode = 0): EngineRunResult {
  return { stdout, stderr: "", exitCode, timedOut: false, aborted: false }
}

it("does not advertise STM32 configuration when CubeMX is missing and does not prepare caches", async () => {
  const f = await fixture()
  const run = vi.fn<typeof runEngine>(async (_bin, args) => {
    expect(args).toEqual(["--probe"])
    return result("No local CubeMX database", 1)
  })
  expect(await inspectStm32Availability(f, { run, env: {} })).toMatchObject({
    available: false,
    reason: expect.stringContaining("CubeMX"),
  })
  expect(run).toHaveBeenCalledTimes(1)
  expect(await readdir(f.configDir)).toEqual([])
})

it("rechecks changed settings and enables chip tools without requiring downloaded firmware", async () => {
  const f = await fixture()
  const installed = path.join(f.root, "Cube MX", "db")
  const run = vi.fn<typeof runEngine>(async (_bin, args) => {
    expect(args[0]).toBe("--probe")
    return args[2] === installed
      ? result(JSON.stringify({ dbPath: installed, dbVersion: "DB.fixture", families: ["STM32G4"] }))
      : result("configured CubeMX database unavailable", 1)
  })
  const save = (location: string) =>
    writeLedgerEntry({ id: "stm32cubemx", bin: { CubeMX: location }, by: "user", confirmedAt: 1 }, f.configDir)
  await save(path.join(f.root, "stale"))
  expect((await inspectStm32Availability(f, { run, env: { STM32CK_CUBEMX_DB: installed } })).available).toBe(false)
  await save(installed)
  expect(await inspectStm32Availability(f, { run, env: {} })).toEqual({ available: true })
  expect(await readdir(f.configDir)).toEqual(["toolchains.json"])
})

it("does not confuse a missing importer or malformed discovery output with available chip data", async () => {
  const f = await fixture()
  const run = vi.fn<typeof runEngine>(async () => result("not JSON"))
  expect(await inspectStm32Availability(f, { run, env: {} })).toMatchObject({
    available: false,
    reason: expect.stringContaining("STM32_IMPORTER_PROTOCOL"),
  })
  await rm(path.join(f.enginesDir, "bin", exe("stm32ck-import")))
  expect(await inspectStm32Availability(f, { run, env: {} })).toMatchObject({
    available: false,
    reason: expect.stringContaining("stm32ck-import"),
  })
  expect(run).toHaveBeenCalledTimes(1)
})

it("propagates cancellation instead of recording a false unavailable state", async () => {
  const f = await fixture()
  const controller = new AbortController()
  const run = vi.fn<typeof runEngine>(async () => {
    controller.abort(new Error("user stopped"))
    return result(JSON.stringify({ dbPath: f.root, dbVersion: "test", families: ["STM32G4"] }))
  })
  await expect(inspectStm32Availability({ ...f, signal: controller.signal }, { run, env: {} })).rejects.toThrow(
    "user stopped",
  )
})

it("uses each session's CubeMX environment without leaking a different project's location", async () => {
  const f = await fixture()
  const locations = [path.join(f.root, "project-a", "db"), path.join(f.root, "project-b", "db")]
  const used: string[] = []
  const run = vi.fn<typeof runEngine>(async (_bin, args) => {
    const location = args[args.indexOf("--cubemx-db") + 1]!
    used.push(location)
    return result(JSON.stringify({ dbPath: location, dbVersion: "test", families: ["STM32G4"] }))
  })
  await Promise.all(
    locations.map((db) =>
      inspectStm32Availability(
        { ...f, env: { STM32CK_CUBEMX_DB: db } },
        { run, env: { STM32CK_CUBEMX_DB: "wrong inherited source" } },
      ),
    ),
  )
  expect(used.sort()).toEqual(locations.sort())
})
