import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { exe, type EngineRunResult, type runEngine } from "../src/host/domain/engines.ts"
import { snapshot } from "../src/host/domain/stm32/cache.ts"
import { createStm32ResourcePreparer } from "../src/host/domain/stm32/resources.ts"
import { configuredSources, firmwareRepository } from "../src/host/domain/stm32/sources.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 })
})
async function put(file: string, text = "local fixture") {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "yoma-stm32-resource-"))
  roots.push(root)
  const db = path.join(root, "Cube MX", "db")
  const repository = path.join(root, "Repository")
  const configDir = path.join(root, "config")
  const enginesDir = path.join(root, "engines")
  await put(path.join(db, "mcu", "part.xml"))
  await put(path.join(db, "package.xml"), "test-v1")
  for (const bin of ["stm32ck-import", "stm32kernel"]) await put(path.join(enginesDir, "bin", exe(bin)), bin)
  let imports = 0
  let afterImport: (() => Promise<void>) | undefined
  const run: typeof runEngine = async (_bin, args, options) => {
    options?.signal?.throwIfAborted()
    let stdout = "{}"
    if (args.includes("--probe")) {
      stdout = JSON.stringify({ dbPath: db, dbVersion: "test-v1", families: ["STM32G4"] })
    } else if (args.includes("--all")) {
      imports++
      const out = args[args.indexOf("--out") + 1]!
      await put(path.join(out, "stm32g4.irpack"), "valid pack")
      await afterImport?.()
    } else if (args[0] === "list-mcus") {
      const data = args[args.indexOf("--data-dir") + 1]!
      expect(await readFile(path.join(data, "stm32g4.irpack"), "utf8")).toBe("valid pack")
      stdout = JSON.stringify({ mcus: [{ part: "test", family: "STM32G4" }] })
    } else if (args[0] === "describe-mcu") stdout = JSON.stringify({ part: { family: "STM32G4" } })
    else throw new Error(`Unexpected command ${args}`)
    return { exitCode: 0, stdout, stderr: "", timedOut: false, aborted: false } satisfies EngineRunResult
  }
  const prepare = createStm32ResourcePreparer({ run, env: { STM32CK_CUBEMX_DB: db, STM32CUBE_REPOSITORY: repository } })
  const options = { projectDir: root, configDir, enginesDir }
  async function firmware(version = "1.10.0") {
    const folder = path.join(repository, `STM32Cube_FW_G4_V${version}`)
    for (const file of [
      "Drivers/STM32G4xx_HAL_Driver/Inc/stm32g4xx_hal.h",
      "Drivers/STM32G4xx_HAL_Driver/Src/stm32g4xx_hal.c",
      "Drivers/CMSIS/Device/ST/STM32G4xx/Include/stm32g4xx.h",
      "Drivers/CMSIS/Device/ST/STM32G4xx/Source/Templates/system_stm32g4xx.c",
      "Drivers/CMSIS/Device/ST/STM32G4xx/Source/Templates/gcc/startup_stm32g473xx.s",
      "Drivers/CMSIS/Include/core_cm4.h",
      "Middlewares/Third_Party/FreeRTOS/Source/tasks.c",
      "Middlewares/ST/STM32_USB_Device_Library/Core/Inc/usbd_core.h",
      "Drivers/STM32G4xx_HAL_Driver/LICENSE.md",
    ])
      await put(path.join(folder, file), version)
    return folder
  }
  return {
    root,
    db,
    repository,
    options,
    prepare,
    firmware,
    imports: () => imports,
    afterImport: (fn: () => Promise<void>) => {
      afterImport = fn
    },
  }
}

describe("STM32 local resource lifecycle", () => {
  it("queries need no firmware; generating needs the local repository, never legacy bundled data", async () => {
    const f = await fixture()
    const query = await f.prepare(f.options)
    expect(query.families).toEqual(["STM32G4"])
    expect(query.fwDir).toBeUndefined()
    await expect(f.prepare({ ...f.options, firmware: true, part: "part" })).rejects.toThrow(
      "STM32_FIRMWARE_SOURCE_INVALID",
    )
    expect(f.imports()).toBe(1)
  })

  it("reuses verified packs, rebuilds corruption, and invalidates on DB or engine content changes", async () => {
    const f = await fixture()
    const first = await f.prepare(f.options)
    expect((await f.prepare(f.options)).dataDir).toBe(first.dataDir)
    expect(f.imports()).toBe(1)
    await put(path.join(first.dataDir, "stm32g4.irpack"), "broken")
    const repaired = await f.prepare(f.options)
    expect(f.imports()).toBe(2)
    await put(path.join(f.db, "mcu", "part.xml"), "updated source")
    const second = await f.prepare(f.options)
    expect(second.dataDir).not.toBe(first.dataDir)
    expect(await readFile(path.join(first.dataDir, "stm32g4.irpack"), "utf8")).toBe("broken")
    expect(await readFile(path.join(repaired.dataDir, "stm32g4.irpack"), "utf8")).toBe("valid pack")
    await put(path.join(f.options.enginesDir, "bin", exe("stm32kernel")), "new schema reader")
    expect((await f.prepare(f.options)).dataDir).not.toBe(second.dataDir)
    expect(f.imports()).toBe(4)
  })

  it("selects numeric firmware versions, normalizes middleware, and records portable provenance", async () => {
    const f = await fixture()
    await f.firmware("1.9.0")
    const source = await f.firmware("1.10.0")
    const result = await f.prepare({ ...f.options, firmware: true, part: "part" })
    expect(await readFile(path.join(result.fwDir!, "CMSIS_Core/Include/core_cm4.h"), "utf8")).toBe("1.10.0")
    expect(await readFile(path.join(result.fwDir!, "MW/FreeRTOS/Source/tasks.c"), "utf8")).toBe("1.10.0")
    expect(await readFile(path.join(result.fwDir!, "MW/USB_Device/Core/Inc/usbd_core.h"), "utf8")).toBe("1.10.0")
    expect(await readFile(path.join(result.fwDir!, "STM32G4/HAL_Driver/LICENSE.md"), "utf8")).toBe("1.10.0")
    const manifest = await readFile(result.manifestPath, "utf8")
    expect(manifest).not.toContain(f.root.replaceAll("\\", "\\\\"))
    expect(JSON.parse(manifest).firmware.version).toBe("1.10.0")
    await put(path.join(source, "Drivers/CMSIS/Include/core_cm4.h"), "updated")
    const updated = await f.prepare({ ...f.options, firmware: true, part: "part" })
    expect(updated.fwDir).not.toBe(result.fwDir)
    expect(await readFile(path.join(result.fwDir!, "CMSIS_Core/Include/core_cm4.h"), "utf8")).toBe("1.10.0")
  })

  it("rejects sources that change while importing and never publishes partial packs", async () => {
    const f = await fixture()
    f.afterImport(async () => put(path.join(f.db, "mcu", "part.xml"), "changed during import"))
    await expect(f.prepare(f.options)).rejects.toThrow("STM32_SOURCE_CHANGED")
    expect(await readdir(path.join(f.options.configDir, "stm32/cache/database"))).toEqual([])
  })

  it("rejects incomplete firmware before caching it, and never silently chooses an older version", async () => {
    const f = await fixture()
    await f.firmware("1.9.0")
    const newest = await f.firmware("1.10.0")
    await rm(path.join(newest, "Drivers/CMSIS/Device/ST/STM32G4xx/Source/Templates/gcc/startup_stm32g473xx.s"))
    await expect(f.prepare({ ...f.options, firmware: true, part: "part" })).rejects.toThrow("STM32_FIRMWARE_INCOMPLETE")
    expect(await readdir(path.join(f.options.configDir, "stm32/cache/firmware")).catch(() => [])).toEqual([])
  })

  it("uses project override before saved machine location before environment", async () => {
    const f = await fixture()
    await put(
      path.join(f.options.configDir, "toolchains.json"),
      JSON.stringify({
        schema: "yoma/toolchains@1",
        entries: { stm32cubemx: { id: "stm32cubemx", bin: { CubeMX: "saved" }, by: "user", confirmedAt: 1 } },
      }),
    )
    await put(
      path.join(f.root, ".yoma/toolchain.local.json"),
      JSON.stringify({ stm32cubemx: { id: "stm32cubemx", bin: { CubeMX: "project" }, by: "user", confirmedAt: 1 } }),
    )
    expect((await configuredSources(f.root, f.options.configDir, { STM32CK_CUBEMX_DB: "env" })).db).toBe("project")
    const settings = path.join(f.root, ".stm32cubemx/plugins/updater/updater.ini")
    await mkdir(f.repository)
    await put(settings, `[Path]\nRepositoryPath=${f.repository}\n`)
    expect(await firmwareRepository(undefined, { USERPROFILE: f.root })).toBe(f.repository)
  })
})

describe("STM32 concurrent preparation", () => {
  it("honors cancellation during a cached lookup", async () => {
    const f = await fixture()
    const build = async (stage: string) => put(path.join(stage, "complete"))
    await snapshot(f.root, "key", build)
    const controller = new AbortController()
    const cached = snapshot(f.root, "key", build, controller.signal)
    queueMicrotask(() => controller.abort(new Error("cancelled cached lookup")))
    await expect(cached).rejects.toThrow("cancelled cached lookup")
  })

  it("shares one build, lets one waiter cancel, and publishes only after completion", async () => {
    const f = await fixture()
    const started = deferred()
    const finish = deferred()
    let builds = 0
    const build = async (stage: string, signal: AbortSignal) => {
      builds++
      started.resolve()
      await finish.promise
      signal.throwIfAborted()
      await put(path.join(stage, "complete"))
    }
    const controller = new AbortController()
    const one = snapshot(f.root, "key", build, controller.signal)
    const cancelled = expect(one).rejects.toThrow("cancelled")
    await started.promise
    const two = snapshot(f.root, "key", build)
    // Let the second asynchronous cache check attach its waiter.
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort(new Error("cancelled"))
    await cancelled
    finish.resolve()
    expect((await two).startsWith(path.join(f.root, "key-"))).toBe(true)
    expect(builds).toBe(1)
  })

  it("cancels the builder when all waiters leave, cleans staging, and allows a retry", async () => {
    const f = await fixture()
    const started = deferred()
    const stopped = deferred()
    const controller = new AbortController()
    const promise = snapshot(
      f.root,
      "key",
      async (_stage, signal) => {
        started.resolve()
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              stopped.resolve()
              reject(signal.reason)
            },
            { once: true },
          ),
        )
      },
      controller.signal,
    )
    const cancelled = expect(promise).rejects.toThrow()
    await started.promise
    controller.abort()
    await cancelled
    await stopped.promise
    await snapshot(f.root, "key", async (stage) => put(path.join(stage, "complete")))
    expect((await readdir(f.root)).filter((file) => file.startsWith(".building-"))).toEqual([])
  })
})
