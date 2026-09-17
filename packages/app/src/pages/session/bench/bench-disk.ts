/**
 * 磁盘上有没有证据 —— 决定"这次会话没人碰过的仪器要不要露出来"。
 *
 * 三次只读 RPC:`la.captures` / `scope.captures` / `file.list .yoma/logs`。
 * **不轮询**:上一轮存下的采集不会自己消失,新采集会经工具卡片进 transcript,
 * 那条路已经把面板叫醒了(`la`/`scope` 进 `status.used`)。所以这里只在
 * 工程目录变了、或者工具卡片数变了的时候重探一次 —— 开着 app 干别的时一个请求都不发。
 */
import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { kernel, kernelAvailable } from "@/utils/kernel"
import { useSDK } from "@/context/sdk"
import { EMPTY_BENCH_DISK, type BenchDisk } from "./instruments"
import { LOG_DIR } from "./log-feed"
import { isLogFileName } from "./log-lines"

/**
 * 探一次磁盘。`trigger` 变化时重探(面板传的是"这次会话碰过几台仪器"),
 * 工程目录变化时也重探。
 */
export function useBenchDisk(trigger: () => unknown): () => BenchDisk {
  const sdk = useSDK()
  /**
   * **trigger 必须过一道 memo**,而且要在这里过 —— `on()` 没有等值判断,它只负责追踪,
   * 依赖一通知就跑。调用方给的 `() => [...].join("|")` 读的是 `useBenchStatus()`,
   * 而那个 memo 每次重算都返回一个**新对象**,于是无条件通知:flash 边跑边上卡片时
   * 每秒十拍,每拍三个 RPC(其中 `file.list` 还要 shell 出去跑一次 `git check-ignore`)。
   * 包在这儿而不是让调用方包,是因为这个坑从调用点一个字都看不出来。
   */
  const key = createMemo(() => String(trigger()))
  const [disk, setDisk] = createStore<BenchDisk>({ ...EMPTY_BENCH_DISK })
  let seq = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
    seq++
  })

  const probe = async (directory: string) => {
    if (!directory || !kernelAvailable()) return
    const mine = ++seq
    // 三条各自兜底:一条挂了不该把另外两条的结果一起丢掉。
    const [la, scope, logs] = await Promise.all([
      kernel.la.captures(directory).then((list) => list.length).catch(() => 0),
      kernel.scope.captures(directory).then((list) => list.length).catch(() => 0),
      kernel.file
        .list(directory, LOG_DIR)
        // 目录不存在(一次都没采集过)就是 0,不是错误。
        .then((entries) => entries.filter((entry) => entry.type !== "directory" && isLogFileName(entry.name)).length)
        .catch(() => 0),
    ])
    if (disposed || mine !== seq) return
    setDisk({ laCaptures: la, scopeCaptures: scope, logFiles: logs })
  }

  createEffect(
    on([() => sdk().directory, key], ([directory]) => {
      void probe(directory)
    }),
  )

  return () => disk
}
