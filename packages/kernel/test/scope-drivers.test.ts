/**
 * 驱动一致性:同一套断言跑 Siglent(对着 FakeSds)、DemoScope,以及设了 YOMA_SCOPE_HARDWARE=<address> 时的真机。
 * 真机那遍会改仪器设置(与工具平时做的一样),跑完尽量按开始时的状态放回去;只在显式打开时跑。
 * `YOMA_SCOPE_HARDWARE_CHANNEL=<n>` 指到接了信号的通道(默认 1);悬空通道上单次触发等不到,套件走的是另一条分支。
 */
import { DemoScope } from "../src/host/domain/scope/demo.ts"
import type { ScopeDriver, ScopeStatus } from "../src/host/domain/scope/driver.ts"
import { openScope } from "../src/host/domain/scope/registry.ts"
import { SiglentScope } from "../src/host/domain/scope/siglent.ts"
import { FakeSds } from "./fixtures/scope/fake-sds.ts"
import { describeScopeDriver } from "./scope-conformance.ts"

describeScopeDriver("siglent over FakeSds", async () => {
  const fake = await FakeSds.start({ recordPoints: 1000, maxPoint: 300 })
  const driver = await SiglentScope.open(fake.address)
  return {
    driver,
    cleanup: async () => {
      await driver.close()
      await fake.close()
    },
  }
})

describeScopeDriver("demo", async () => ({
  driver: new DemoScope({ triggerDelayMs: 20 }),
  cleanup: async () => {},
}))

/** 把套件改过的通道、时基、深度、触发放回开始时的样子;尽力而为,放不回去的只记不抛。 */
async function restore(driver: ScopeDriver, before: ScopeStatus): Promise<string[]> {
  const notes: string[] = []
  const step = async (what: string, fn: () => Promise<{ mismatches: string[] } | void>) => {
    try {
      const r = await fn()
      if (r && r.mismatches.length) notes.push(`${what}: ${r.mismatches.join("; ")}`)
    } catch (error) {
      notes.push(`${what}: ${String(error)}`)
    }
  }
  for (const c of before.channels)
    await step(`C${c.ch}`, () =>
      driver.setChannel({
        ch: c.ch,
        on: c.on,
        probe: c.probe,
        vdiv: c.vdiv,
        offset: c.offset,
        coupling: c.coupling,
        bwlimit: c.bwlimit,
        ...(c.unit === "V" || c.unit === "A" ? { unit: c.unit } : {}),
      }),
    )
  await step("timebase", () => driver.setTimebase({ scale: before.timebase.scale, delay: before.timebase.delay }))
  await step("mdepth", () => driver.setMemoryDepth(before.acquire.mdepth))
  await step("trigger", () =>
    driver.setTrigger({
      source: before.trigger.source,
      slope: before.trigger.slope,
      level: before.trigger.level,
      mode: /norm/i.test(before.trigger.mode) ? "normal" : "auto",
    }),
  )
  if (!/stop/i.test(before.trigger.status)) await step("run", () => driver.run())
  return notes
}

const hardware = process.env.YOMA_SCOPE_HARDWARE
if (hardware) {
  const channel = Number(process.env.YOMA_SCOPE_HARDWARE_CHANNEL ?? "1")
  describeScopeDriver(`hardware ${hardware} on C${channel}`, async () => {
    const driver = await openScope(hardware)
    const before = await driver.status()
    return {
      driver,
      channel,
      acquireMs: 1500,
      cleanup: async () => {
        try {
          const notes = await restore(driver, before)
          if (notes.length) console.warn(`hardware restore: ${notes.join(" | ")}`)
        } finally {
          await driver.close()
        }
      },
    }
  })
}
