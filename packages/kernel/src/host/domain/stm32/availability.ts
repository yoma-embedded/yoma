import { engineBin, type runEngine } from "../engines.ts"
import { aborted } from "./cache.ts"
import { probeStm32Database, type Stm32ProbeOptions } from "./probe.ts"

export interface Stm32Availability {
  available: boolean
  reason?: string
}

/** No conversion, cache writes, firmware download, or GUI launch during capability discovery. */
export async function inspectStm32Availability(
  options: Stm32ProbeOptions,
  deps: { run?: typeof runEngine; env?: NodeJS.ProcessEnv } = {},
): Promise<Stm32Availability> {
  try {
    aborted(options.signal)
    engineBin("stm32kernel", options)
    await probeStm32Database(options, deps)
    aborted(options.signal)
    return { available: true }
  } catch (error) {
    aborted(options.signal)
    return { available: false, reason: (error instanceof Error ? error.message : String(error)).slice(0, 600) }
  }
}
