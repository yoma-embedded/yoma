/**
 * `useTargetIdentity()` —— 当前会话的目标身份(工程名 · 芯片 · 内核 · 探针)。
 *
 * **刻意不进 `bench-context`**:那份 context 是三处消费者共用的热点,而身份今天只有状态栏
 * 最左那一格要。它复用 `useBenchToolParts()` 摊平出来的那批工具卡片,自己再折一遍 ——
 * 多的是一条 memo(只在工具卡片变了的时候重跑),省的是一处三家都要改的接线。
 */
import { createMemo, type Accessor } from "solid-js"
import { useSDK } from "@/context/sdk"
import { deriveTargetIdentity, type TargetIdentity } from "./target-identity"
import { useBenchToolParts } from "./use-bench-status"

export function useTargetIdentity(sessionID?: Accessor<string | undefined>): Accessor<TargetIdentity> {
  const sdk = useSDK()
  const parts = useBenchToolParts(sessionID)
  return createMemo(() => deriveTargetIdentity(parts(), sdk().directory))
}
