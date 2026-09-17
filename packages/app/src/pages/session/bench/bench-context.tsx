/**
 * 工作台现状的**一份**共享来源。
 *
 * v2-console 这个布局里有三处要读它:底部控制台(哪几台文本仪器该有页签)、右栏的按需仪器页
 * (哪几台波形仪器该在)、最底下的状态栏(状态条 + 日志读数)。各自调一遍 `useBenchStatus()` /
 * `useBenchDisk()` 的代价不是"多一个 memo":
 *
 * - `useBenchStatus` 每份都要把整段 transcript 的工具卡片重折一遍;
 * - `useBenchDisk` 每份在触发变化时都发三个只读 RPC(其中 `file.list` 在内核那侧每层要
 *   shell 出去跑一次 `git check-ignore`)。三份就是九个。
 *
 * 所以提到一个 context 里,provider 挂在会话页的根上,谁要谁 `useBench()`。
 * 这份 context 本身**与布局无关**(只有状态,没有任何"摆在哪"),其它变体照样可以用。
 */
import { createMemo, type Accessor } from "solid-js"
import { createSimpleContext } from "@yoma-desktop/ui/context"
import type { BenchStatus } from "./bench-status"
import { useBenchStatus } from "./use-bench-status"
import { useBenchDisk } from "./bench-disk"
import { benchPins, type BenchDisk, type InstrumentContext } from "./instruments"

export interface BenchContextValue {
  /** 这次会话的工具卡片折出来的现状。 */
  status: Accessor<BenchStatus>
  /** 磁盘上有没有上一轮存下的证据。 */
  disk: Accessor<BenchDisk>
  /** 喂给注册表那几个纯函数(`visibleOnSurface` / `def.status` / `def.headline`)的一整包。 */
  ctx: Accessor<InstrumentContext>
}

export const { use: useBench, provider: BenchProvider } = createSimpleContext<BenchContextValue, {}>({
  name: "Bench",
  init: () => {
    const status = useBenchStatus()

    // 重探磁盘的时机:碰过的仪器多了一台,或者 la / scope / log 出了新东西。
    // 不轮询 —— 新证据一定先经工具卡片进 transcript,那条路已经把这里叫醒了。
    const disk = useBenchDisk(() =>
      [status().used.size, status().la?.id, status().scope?.id, status().log?.file].join("|"),
    )

    const ctx = createMemo<InstrumentContext>(() => ({
      status: status(),
      disk: disk(),
      pinned: benchPins.all(),
    }))

    return { status, disk, ctx }
  },
})
