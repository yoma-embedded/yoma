/**
 * `useBenchStatus()` —— 把 transcript 折成一份 `BenchStatus` 的响应式口子。
 *
 * **为什么分两段 memo**:第一段只摊平出工具卡片,第二段才折。这样做的代价是多一个 memo,
 * 换来的是**打字不重算**:第一段对每个 part 只读 `.type`(文本 part 到此为止),
 * solid 的 store 是逐属性追踪的,所以流式文本 delta 改的是 `.text`,不会把这条链叫醒。
 * 真正会叫醒它的只有工具卡片自己的变化 —— 而工具进度在内核那侧已经按 100ms 节流过了。
 *
 * 顺序:`sync().data.message[sessionID]` 与 `sync().data.part[messageID]` 都是按 id 升序维护的
 * (server-session.ts 用 Binary.search 插),所以"消息序 → part 序"就是源序,不用再排。
 */
import { createMemo, type Accessor } from "solid-js"
import type { Part, ToolPart } from "@yoma-desktop/kernel"
import { useSync } from "@/context/sync"
import { useSessionKey } from "@/pages/session/session-layout"
import { deriveBenchStatus, EMPTY_BENCH_STATUS, type BenchStatus } from "./bench-status"
import { instrumentObservations } from "./instrument-state"

/** 模块级的稳定空数组:每次现造一个新的 `[]` 会让下游 memo 每拍都认为变了。 */
const EMPTY_PARTS: Part[] = []

/**
 * 当前会话里,与工作台有关的工具卡片,源序。
 * 传 `sessionID` 可以看别的会话(布局变体大概用不上,留着是为了测试与将来的对比视图)。
 */
export function useBenchToolParts(sessionID?: Accessor<string | undefined>): Accessor<ToolPart[]> {
  const sync = useSync()
  const { params } = useSessionKey()
  const id = sessionID ?? (() => params.id)

  return createMemo(() => {
    const session = id()
    if (!session) return []
    const messages = sync().data.message[session]
    if (!messages) return []
    const out: ToolPart[] = []
    for (const message of messages) {
      const parts = sync().data.part[message.id] ?? EMPTY_PARTS
      for (const part of parts) {
        // 只读 `.type`:文本 part 的 `.text` 不进依赖,所以流式输出不会把这条链叫醒。
        if (part.type === "tool") out.push(part)
      }
    }
    return out
  })
}

/** 当前会话的工作台现状。面板、状态条、注册表的可见性判定全用它。 */
export function useBenchStatus(sessionID?: Accessor<string | undefined>): Accessor<BenchStatus> {
  const { params } = useSessionKey()
  const parts = useBenchToolParts(sessionID)
  const recorded = createMemo(() => {
    const list = parts()
    return list.length === 0 ? EMPTY_BENCH_STATUS : deriveBenchStatus(list)
  })
  return createMemo(() => {
    const observed = instrumentObservations(sessionID?.() ?? params.id, recorded())
    return observed.length ? deriveBenchStatus([...parts(), ...observed]) : recorded()
  })
}
