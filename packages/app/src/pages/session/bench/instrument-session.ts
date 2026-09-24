import { useNavigate } from "@solidjs/router"
import { onCleanup } from "solid-js"
import type { GdbInput } from "@yoma-desktop/kernel/tools/gdb/contract"
import type { LogInput } from "@yoma-desktop/kernel/tools/log/contract"
import { useSDK } from "@/context/sdk"
import { kernel } from "@/utils/kernel"
import { sessionHref } from "@/utils/session-href"
import { executeInstrument } from "./instrument-state"
import { useSessionKey } from "../session-layout"

/** A draft becomes an instrument session only after an explicit Connect action. */
export function createInstrumentSession() {
  const sdk = useSDK()
  const { params } = useSessionKey()
  const navigate = useNavigate()
  let disposed = false
  onCleanup(() => { disposed = true })
  const pending = new Map<string, Promise<string>>()
  const created = new Map<string, string>()
  const id = () => params.id ?? created.get(sdk().directory)
  const ensure = async () => {
    const current = id()
    if (current) return current
    const directory = sdk().directory
    const existing = pending.get(directory)
    if (existing) return existing
    const request = kernel.session.create({ directory }).then((session) => {
      created.set(directory, session.id)
      return session.id
    }).finally(() => { pending.delete(directory) })
    pending.set(directory, request)
    return request
  }
  function run(tool: "log", input: LogInput): ReturnType<typeof kernel.instrument.execute>
  function run(tool: "gdb", input: GdbInput): ReturnType<typeof kernel.instrument.execute>
  async function run(tool: "log" | "gdb", input: LogInput | GdbInput) {
    const directory = sdk().directory
    const routeID = params.id
    const sessionID = await ensure()
    const result = await executeInstrument({ sessionID, tool, input })
    if (!disposed && !routeID && !params.id && directory === sdk().directory) navigate(sessionHref(sessionID))
    return result
  }
  return { id, ensure, run }
}
