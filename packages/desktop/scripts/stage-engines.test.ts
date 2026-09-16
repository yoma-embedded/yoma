import { afterEach, expect, test } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { assertNoStm32Data, materializeEngineResources, STM32_RESOURCE_POLICY } from "../../../engines/distribution.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "yoma-staging-"))
  roots.push(root)
  const source = path.join(root, "source")
  const destination = path.join(root, "stage")
  function file(relative: string, content: string) {
    const target = path.join(source, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return { source, destination, file }
}

test.each(["stm32ck-import.exe", "stm32ck-import"])(
  "stages %s and public LA resources without copying private developer data",
  (importer) => {
    const f = fixture()
    f.file(`bin/${importer}`, "native importer placeholder")
    f.file("data/la/decoders/i2c.py", "public decoder")
    f.file("data/la/res/device.fw", "public logic analyzer firmware")
    f.file("data/stm32/stm32g4.irpack", "PRIVATE DEVICE DATA")
    f.file("data/stm32/fw/STM32G4/HAL/Src/hal.c", "PRIVATE HAL DATA")
    f.file("data/stm32/db/mcu/device.xml", "PRIVATE DATABASE")
    f.file("data/unregistered-cache/source.xml", "PRIVATE UNKNOWN RESOURCE")
    f.file("manifest.json", JSON.stringify({ irpacks: 27, firmware: "bundled", platform: "fixture" }))

    materializeEngineResources(f.source, f.destination)

    expect(readFileSync(path.join(f.destination, "bin", importer), "utf8")).toBe("native importer placeholder")
    expect(readdirSync(path.join(f.destination, "data"))).toEqual(["la"])
    expect(readFileSync(path.join(f.destination, "data/la/res/device.fw"), "utf8")).toBe(
      "public logic analyzer firmware",
    )
    expect(existsSync(path.join(f.destination, "data/stm32"))).toBe(false)
    const manifest = JSON.parse(readFileSync(path.join(f.destination, "manifest.json"), "utf8"))
    expect(manifest.stm32).toEqual(STM32_RESOURCE_POLICY)
    expect(manifest.irpacks).toBeUndefined()
    expect(manifest.firmware).toBeUndefined()
    expect(manifest.bin[importer].sha256).toMatch(/^[0-9a-f]{64}$/)
    // Packaging must never delete or modify the user's source material either.
    expect(readFileSync(path.join(f.source, "data/stm32/stm32g4.irpack"), "utf8")).toBe("PRIVATE DEVICE DATA")
  },
)

test("an engine distribution needs no STM32 data directory", () => {
  const f = fixture()
  f.file("bin/stm32ck-import", "importer")
  materializeEngineResources(f.source, f.destination)
  expect(readdirSync(path.join(f.destination, "data"))).toEqual([])
  expect(() => assertNoStm32Data(f.destination)).not.toThrow()
})

test("a misplaced irpack in an otherwise public directory blocks distribution", () => {
  const f = fixture()
  f.file("bin/stm32ck-import", "importer")
  f.file("data/la/accidental-copy.irpack", "PRIVATE DEVICE DATA")
  expect(() => materializeEngineResources(f.source, f.destination)).toThrow(/must not be included/)
})

test("staging cannot reuse a dirty destination that retains private data", () => {
  const f = fixture()
  f.file("bin/stm32ck-import", "importer")
  mkdirSync(path.join(f.destination, "data/stm32/fw"), { recursive: true })
  expect(() => materializeEngineResources(f.source, f.destination)).toThrow(/destination must be empty/)
})
