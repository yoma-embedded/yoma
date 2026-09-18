/**
 * 日志喂料 —— 工程 `.yoma/logs/hw-*.log` 里最新那一份的尾巴。
 *
 * 这不是 log 工具的第二条实现:采集、串口、环形缓冲全在内核里,这里只**读那份落盘的文件**。
 * 好处是采集停了、会话重开了、agent 早就走了,日志照样看得见 —— 面板不依赖 transcript 里
 * 恰好有一次 `log read`。
 *
 * 四条纪律:
 * 1. **没人看就不轮询**。按消费者计数:`useLogFeed()` 挂载时 +1,`onCleanup` 时 -1,归零就
 *    清定时器并把这份 feed 整个 dispose 掉。开着 app 不看日志时,这里一个 RPC 都不发。
 * 2. **轮询不能便宜以为**。`file.list` 在内核那侧每层要 shell 出去跑一次 `git check-ignore`,
 *    所以列目录是每 `LIST_EVERY` 拍才一次,平时只重读那一个文件。
 * 3. **`file.read` 截的是头**(host/services.ts:`stat.size > 2MB` 就只读前 2 MB)。所以
 *    `truncated` 为真时我们**读不到真正的尾巴** —— 这时如实说,并且把节奏放慢到
 *    `SLOW_INTERVAL_MS`(每 2 秒拖 2 MB 过 IPC 是真会让界面掉帧的)。
 * 4. **seq 不进 store**。刷新是从 effect 里同步叫起来的,把计数读进 store 就是一个自依赖循环
 *    (la-waveform.tsx 那条注释付过学费)。
 */
import { createRoot, onCleanup } from "solid-js"
import { createStore, type Store } from "solid-js/store"
import { kernel, kernelAvailable } from "@/utils/kernel"
import { LOG_TAIL_BYTES, LOG_TAIL_LINES, pickNewestLogFile, tailLines, toLogLines, type LogLine } from "./log-lines"

/** 日志目录,相对工程根。`file.list` / `file.read` 收的就是这种相对路径。 */
export const LOG_DIR = ".yoma/logs"

/** 常规节奏。比 1 秒慢一档 —— 硬件日志不是股票行情,而每一拍都是两次跨进程读盘。 */
export const POLL_INTERVAL_MS = 2000
/** 文件超过 file.read 的 2 MB 窗口之后的节奏。 */
export const SLOW_INTERVAL_MS = 10_000
/** 每几拍重列一次目录(找有没有更新的 hw-*.log)。 */
const LIST_EVERY = 5

export interface LogFeedState {
  /** 文件名,如 `hw-20260918-101112345.log`。 */
  name?: string
  /** 相对工程根的路径,可直接喂回 `file.read`。 */
  path?: string
  lines: LogLine[]
  /** 这一窗口之前还有多少行没显示(按行数上限砍掉的)。 */
  clipped: number
  /** 文件大过 `file.read` 的 2 MB 窗口:**看到的是开头不是结尾**。 */
  truncated: boolean
  /** 最近一次成功读到内容的时刻(epoch ms)。 */
  updatedAt?: number
  loading: boolean
  error?: string
  /** 跟随尾部。面板把它翻成"新内容来了就滚到底"。 */
  follow: boolean
  /**
   * 过滤词。**跟着这份 feed 走,不是某个组件的局部状态** —— 底部控制台把过滤框提到了页签行上,
   * 而行区在下面另一个组件里,两边必须读同一个值。同一份日志开两处却各过滤各的也不是特性。
   */
  filter: string
}

export interface LogFeed {
  state: Store<LogFeedState>
  setFollow(follow: boolean): void
  setFilter(filter: string): void
  /** 手动重来一次(换文件 + 重读),不等下一拍。 */
  refresh(): void
}

interface FeedEntry {
  feed: LogFeed
  dispose(): void
  consumers: number
  stop(): void
}

/** 一个工程一份 feed。两个面板同时开(比如底部控制台 + 右栏)共用同一次轮询。 */
const feeds = new Map<string, FeedEntry>()

function createFeed(directory: string): FeedEntry {
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0
  let tick = 0
  let stopped = false

  return createRoot<FeedEntry>((dispose) => {
    const [state, setState] = createStore<LogFeedState>({
      lines: [],
      clipped: 0,
      truncated: false,
      loading: false,
      follow: true,
      filter: "",
    })

    const schedule = () => {
      if (stopped) return
      // 工程目录为空时每一拍都是空转:不排下一拍,由调用方换一个 feed(目录变了 = 换路由 = 重建)。
      if (!directory) return
      clearTimeout(timer)
      // `state.truncated` 在这里是非响应式地读一次(只用来定下一拍的间隔),不建依赖。
      timer = setTimeout(() => void run(), state.truncated ? SLOW_INTERVAL_MS : POLL_INTERVAL_MS)
    }

    /**
     * 上一拍读到的原文。**内容一个字节都没变时不换 `lines` 数组** —— 换了的话
     * `<Index>` 上游的引用一变,用户正选中的那段栈回溯每 2 秒被清一次(没法复制),
     * 而且节点重排会夹一次 scrollTop、把"跟随"莫名其妙关掉。
     */
    let lastRaw: string | undefined

    const run = async () => {
      if (stopped) return
      const mine = ++seq
      const relist = tick % LIST_EVERY === 0 || !state.path
      tick++
      setState("loading", true)
      let patch: Partial<LogFeedState> | undefined
      let raw: string | undefined
      try {
        const read = await readFeed({ directory, name: state.name, relist })
        patch = read?.patch
        raw = read?.raw
        if (raw !== undefined && raw === lastRaw && patch) {
          // 没变:只报个时间,行对象原样留着。
          patch = { updatedAt: patch.updatedAt, error: undefined }
        }
      } catch {
        // readFeed 自己已经把两个 RPC 都兜住了;这一层是给将来的重构留的 ——
        // 漏出去的 rejection 在 Electron 里是 Runtime.exceptionThrown,e2e:paint 见一条就红。
        patch = undefined
      } finally {
        // **落地要过这一关**:慢的那一拍(比如 2 MB 的读)晚于新的一拍回来时,
        // 不许把新结果盖回旧的。被 refresh() / stop() 顶掉了也别再排下一拍。
        if (!stopped && mine === seq) {
          if (patch) setState({ ...patch, loading: false })
          else setState("loading", false)
          if (raw !== undefined) lastRaw = raw
          schedule()
        }
      }
    }

    const feed: LogFeed = {
      state,
      setFollow: (follow) => setState("follow", follow),
      setFilter: (filter) => setState("filter", filter),
      refresh: () => {
        tick = 0
        seq++
        clearTimeout(timer)
        void run()
      },
    }

    void run()

    return {
      feed,
      dispose,
      consumers: 0,
      stop: () => {
        stopped = true
        seq++
        clearTimeout(timer)
      },
    }
  })
}

/**
 * 读一拍,**只返回要落的那一块,自己不写 store** —— 写不写由调用方在 seq 关卡之后决定。
 * 任何一步失败都变成一块 patch,不抛。
 */
async function readFeed(input: {
  directory: string
  name: string | undefined
  relist: boolean
}): Promise<{ patch: Partial<LogFeedState>; raw?: string } | undefined> {
  const { directory, relist } = input
  // 工程目录还没解析出来(首帧)时什么都别做 —— 空目录喂给 file.list 只会白抛一个异常。
  if (!directory) return undefined
  if (!kernelAvailable()) return { patch: { error: "内核通道不可用" } }

  const empty: Partial<LogFeedState> = {
    name: undefined,
    path: undefined,
    lines: [],
    clipped: 0,
    truncated: false,
    error: undefined,
  }

  let name = input.name
  if (relist || !name) {
    try {
      const entries = await kernel.file.list(directory, LOG_DIR)
      const newest = pickNewestLogFile(entries)
      // 目录还不存在(一次都没采集过)也走这一支 —— 那是常态,不是错误,面板显示空状态。
      if (!newest) return { patch: empty }
      name = newest
    } catch {
      return { patch: empty }
    }
  }

  const path = `${LOG_DIR}/${name}`
  try {
    const file = await kernel.file.read(directory, path)
    const raw = typeof file.content === "string" ? file.content : ""
    // truncated 时末尾那一行是被字节数切断的半行,不是文件真的到此为止 —— 丢掉它。
    const kept = tailLines(raw, { maxLines: LOG_TAIL_LINES, maxBytes: LOG_TAIL_BYTES, dropLastPartial: file.truncated })
    const total = countLines(raw)
    return {
      patch: {
        name,
        path,
        lines: toLogLines(kept),
        clipped: Math.max(0, total - kept.length),
        truncated: file.truncated,
        updatedAt: Date.now(),
        error: undefined,
      },
      raw,
    }
  } catch (error) {
    // 文件在两拍之间被换掉(采集重开)会 ENOENT:下一拍重列就接上了,原文照给不吓唬人。
    return { patch: { error: error instanceof Error ? error.message : String(error) } }
  }
}

function countLines(content: string): number {
  if (!content) return 0
  let n = 1
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++
  return content.endsWith("\n") ? n - 1 : n
}

/**
 * 订阅当前工程的日志喂料。**必须在组件里调**(靠 `onCleanup` 退订)。
 * 最后一个消费者卸载时轮询停掉、这份 feed 被 dispose —— 右栏切走之后不会再有 RPC。
 */
export function useLogFeed(directory: () => string): LogFeed {
  // 目录在会话生命周期里不变(换工程 = 换路由 = 组件重建),所以取一次就够。
  const dir = directory()
  const entry = acquireLogFeed(dir)
  onCleanup(() => releaseLogFeed(dir))
  return entry
}

export function acquireLogFeed(directory: string): LogFeed {
  let entry = feeds.get(directory)
  if (!entry) {
    entry = createFeed(directory)
    feeds.set(directory, entry)
  }
  entry.consumers++
  return entry.feed
}

export function releaseLogFeed(directory: string) {
  const entry = feeds.get(directory)
  if (!entry) return
  entry.consumers--
  if (entry.consumers > 0) return
  entry.stop()
  entry.dispose()
  feeds.delete(directory)
}

/** 测试与开发用:把所有 feed 收掉。 */
export const LogFeedTesting = {
  reset() {
    for (const [directory] of feeds) {
      const entry = feeds.get(directory)
      entry?.stop()
      entry?.dispose()
    }
    feeds.clear()
  },
  size: () => feeds.size,
}
