/**
 * 日志喂料 —— 工程 `.yoma/logs/hw-*.log` 里最新那一份的尾巴。
 *
 * 这不是 log 工具的第二条实现:采集、串口、环形缓冲全在内核里,这里只**读那份落盘的文件**。
 * 好处是采集停了、会话重开了、agent 早就走了,日志照样看得见 —— 面板不依赖 transcript 里
 * 恰好有一次 `log read`。
 *
 * **两种读法**(2026-09-24,RTT 进来之后):
 * - **读盘**(缺省):每 2 秒重读最新那份文件。什么都不依赖,但最多晚 2 秒,文件过了 2 MB 读到的是开头。
 * - **实时**:有人开着日志面板、而且这个会话有一个在跑的采集时(`SerialControls` 从 log status 知道,
 *   经 `onLive` → `setLive(owner, 会话 id)` 交过来),每 `LIVE_INTERVAL_MS` 拉一次内核的
 *   `instrument.logTail({ sessionID, since })`,只拿新行接上去(`log-live.ts` 的 `mergeLiveTail`)。
 *   那是内核内存里环形缓冲的快照,与落盘文件逐行同形(`[+1.234] 正文`),所以分级 / 过滤照旧;
 *   每次采集一份新文件、一行一个序号,行号就用文件里的行号 —— 读盘那条路也改成按文件行号编,
 *   采集一停(或 logTail 说没在跑、或拉失败)这一拍就退回读盘,读的是同一份文件,行号正文逐行相同,画面接得上。
 *   实时仍然守纪律 1:日志面板卸载时交回 `undefined`,只剩状态栏在看时退回 2 秒读盘;
 *   窗口在后台时实时的节奏也退回 2 秒。游标(`cursor`)与 seq 一样不进 store(纪律 4)。
 * - **退回读盘时文件过了 2 MB**(RTT 连着跑几分钟就到):`file.read` 只给得出开头,而面板上正是内核给的尾巴
 *   —— 拿开头换掉它,停下来的那一刻最该看的几行(为什么停了)就没了。所以(2026-09-25):
 *   采集停了先把停的那一刻写下的几行最后拉一次(`log-live.ts` 规矩 5;面板先交回 `undefined` 的话由
 *   `ending` 补这一拉);读盘读回来只有开头、又正是面板上这份文件(`tailFile`)时,留着内核的尾巴,
 *   "看到的是开头"的提示也不挂;实时这一拍只是拉失败了的话,2 秒后就再试实时,不被大文件的 10 秒节奏拖住。
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
import type { LogTailView } from "@yoma-desktop/kernel"
import { kernel, kernelAvailable } from "@/utils/kernel"
import { LOG_TAIL_BYTES, LOG_TAIL_LINES, pickNewestLogFile, tailLines, type LogLine } from "./log-lines"
import { liveCursorStale, liveLogPath, mergeLiveTail, numberLogLines, sameLogLines, type LiveCursor } from "./log-live"

/** 日志目录,相对工程根。`file.list` / `file.read` 收的就是这种相对路径。 */
export const LOG_DIR = ".yoma/logs"

/** 常规节奏。比 1 秒慢一档 —— 硬件日志不是股票行情,而每一拍都是两次跨进程读盘。 */
export const POLL_INTERVAL_MS = 2000
/** 文件超过 file.read 的 2 MB 窗口之后的节奏。 */
export const SLOW_INTERVAL_MS = 10_000
/** 每几拍重列一次目录(找有没有更新的 hw-*.log)。 */
const LIST_EVERY = 5
/** 实时模式的节奏。内核那侧只是读内存里的环形缓冲,一拍很便宜;RTT 的日志就是要"打出来就看见"。 */
export const LIVE_INTERVAL_MS = 200

export interface LogFeedState {
  /** 文件名,如 `hw-20260918-101112345.log`。 */
  name?: string
  /** 相对工程根的路径,可直接喂回 `file.read`。 */
  path?: string
  /** 行号(`no`)是文件里的行号,读盘与实时两条路同一套编法。 */
  lines: LogLine[]
  /** 这一窗口之前、文件里还有多少行没显示。 */
  clipped: number
  /** 文件大过 `file.read` 的 2 MB 窗口:**看到的是开头不是结尾**。 */
  truncated: boolean
  /** 最近一次成功读到内容的时刻(epoch ms)。 */
  updatedAt?: number
  loading: boolean
  error?: string
  /** 这些行来自内核的实时尾巴(有一个在跑的采集、有人开着日志面板),而不是读盘。 */
  live: boolean
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
  /**
   * 实时模式的开关。`owner` 是说话的那一方(一个日志面板一个),`sessionID` 是它看到的在跑的采集所在的
   * 会话,`undefined` 是"我这儿没有了 / 我走了"。几方都在说时最后一个说"有"的算数。
   */
  setLive(owner: object, sessionID: string | undefined): void
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
  /** 谁在说"这个会话有采集在跑"。 */
  const liveOwners = new Map<object, string>()
  let liveSession: string | undefined
  /** 实时游标:落地过一次实时合并之后才有;回到读盘(换过行)就作废,下一次实时整窗重拉。 */
  let cursor: LiveCursor | undefined
  /** 刚交回 `undefined` 的那个会话与它的游标:下一拍最后拉它一次(停的那一刻写下的几行),只用一次。 */
  let ending: { sessionID: string; cursor: LiveCursor } | undefined
  /** 面板上的行是内核给的哪一份文件的尾巴(实时落过地之后);读盘把行换掉了就不是了。 */
  let tailFile: string | undefined
  /**
   * 上一次读盘是不是只读到了开头(文件过了 2 MB)—— 定下一拍的节奏用。不看 `state.truncated`:
   * 留着内核尾巴的时候(见 runDisk)屏幕上不是开头、不挂提示,可那份文件照样一读就是 2 MB。
   */
  let bigFile = false

  return createRoot<FeedEntry>((dispose) => {
    const [state, setState] = createStore<LogFeedState>({
      lines: [],
      clipped: 0,
      truncated: false,
      loading: false,
      live: false,
      follow: true,
      filter: "",
    })

    const schedule = (delay?: number) => {
      if (stopped) return
      // 工程目录为空时每一拍都是空转:不排下一拍,由调用方换一个 feed(目录变了 = 换路由 = 重建)。
      if (!directory) return
      clearTimeout(timer)
      timer = setTimeout(() => void run(), delay ?? (bigFile ? SLOW_INTERVAL_MS : POLL_INTERVAL_MS))
    }

    /** 窗口在后台时没人看得见,实时也退回常规节奏。 */
    const liveDelay = () =>
      typeof document !== "undefined" && document.visibilityState === "hidden" ? POLL_INTERVAL_MS : LIVE_INTERVAL_MS

    /**
     * 上一拍读到的原文。**内容一个字节都没变时不换 `lines` 数组** —— 换了的话
     * `<Index>` 上游的引用一变,用户正选中的那段栈回溯每 2 秒被清一次(没法复制),
     * 而且节点重排会夹一次 scrollTop、把"跟随"莫名其妙关掉。
     */
    let lastRaw: string | undefined

    const run = async () => {
      if (stopped) return
      const mine = ++seq
      // 没人要实时了的话,刚交回 undefined 的那个会话在这一拍最后拉一次(一次性的)。
      const last = liveSession ? undefined : ending
      ending = undefined
      const session = liveSession ?? last?.sessionID
      /** 下一拍的间隔;undefined = 读盘的常规节奏。 */
      let next: number | undefined
      if (session) {
        const reply = await readLive(session, liveSession ? cursor : last?.cursor)
        // 同一道关:被 refresh() / setLive() / stop() 顶掉的这一拍不许落地。
        if (stopped || mine !== seq) return
        // 没在跟随(用户往上翻着看)时窗口不往前滑,见 log-live.ts 规矩 4。
        const merged = reply ? mergeLiveTail(state.lines, reply.from, reply.view, { hold: !state.follow }) : undefined
        if (merged?.kind === "reset") {
          cursor = undefined
          schedule(0)
          return
        }
        const wasLive = state.live
        if (reply && merged?.kind === "lines") {
          // 采集停了(规矩 5)或这是交回之后的最后一拉:这几行照样落地,但不再是实时,往下照旧读盘。
          const live = !!liveSession && reply.view.running
          cursor = merged.cursor
          // 下一次读盘一定重建行:实时这段时间里文件长了多少,lastRaw 说不上来。
          lastRaw = undefined
          const where = liveLogPath(directory, reply.view.file ?? "")
          tailFile = where.name
          setState({
            name: where.name,
            path: where.path,
            clipped: merged.clipped,
            truncated: false,
            loading: false,
            error: undefined,
            live,
            // 没有新行时 lines / updatedAt 都不碰:`<Index>` 上游的数组不变,跟随也不会每 200 ms 滚一次。
            ...(merged.changed ? { lines: merged.lines, updatedAt: Date.now() } : {}),
          })
          if (live) {
            schedule(liveDelay())
            return
          }
        }
        // 没有在跑的采集(停了、源断了)、或这一拍拉失败了:这一拍照旧读盘 —— 读的是同一份文件。
        // 刚从实时退回来时先重列一次目录。
        if (wasLive) tick = 0
        // 在跑的采集只是这一拍拉失败了:2 秒后再试实时。连着失败(这时已经不是 live)才按读盘的节奏来,
        // 大文件是 10 秒 —— 别让一次失败把实时冻住 10 秒,也别在一直失败时每 2 秒拖 2 MB。
        if (!reply && liveSession && wasLive) next = POLL_INTERVAL_MS
      }
      cursor = undefined
      await runDisk(mine, next)
    }

    const runDisk = async (mine: number, next?: number) => {
      const relist = tick % LIST_EVERY === 0 || !state.path
      tick++
      setState("loading", true)
      let patch: Partial<LogFeedState> | undefined
      let raw: string | undefined
      let headOnly = false
      try {
        const read = await readFeed({ directory, name: state.name, relist })
        patch = read?.patch
        raw = read?.raw
        headOnly = read?.patch.truncated === true
        if (headOnly && patch?.name !== undefined && patch.name === tailFile) {
          // 只读到开头(2 MB),而面板上正是这份文件的尾巴(内核给的,更新的那一截,停的那一刻的几行也在里面):
          // 留着尾巴,不拿开头换掉;"看到的是开头"的提示也不挂 —— 屏幕上不是开头。
          const { lines: _lines, clipped: _clipped, truncated: _truncated, ...rest } = patch
          patch = rest
        } else if (raw !== undefined && raw === lastRaw && patch) {
          // 没变:只报个时间,行对象原样留着。
          patch = { updatedAt: patch.updatedAt, error: undefined }
        } else if (patch?.lines && sameLogLines(state.lines, patch.lines)) {
          // 刚从实时退回来:读到的正是面板上那几行(行号同一套),数组也原样留着。
          const { lines: _same, ...rest } = patch
          patch = rest
        }
      } catch {
        // readFeed 自己已经把两个 RPC 都兜住了;这一层是给将来的重构留的 ——
        // 漏出去的 rejection 在 Electron 里是 Runtime.exceptionThrown,e2e:paint 见一条就红。
        patch = undefined
      } finally {
        // **落地要过这一关**:慢的那一拍(比如 2 MB 的读)晚于新的一拍回来时,
        // 不许把新结果盖回旧的。被 refresh() / stop() 顶掉了也别再排下一拍。
        if (!stopped && mine === seq) {
          if (patch) setState({ ...patch, loading: false, live: false })
          else setState({ loading: false, live: false })
          // 行换成了读盘读的:面板上不再是内核的尾巴。
          if (patch?.lines) tailFile = undefined
          if (raw !== undefined) lastRaw = raw
          bigFile = headOnly
          schedule(next)
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
      setLive: (owner, sessionID) => {
        liveOwners.delete(owner)
        if (sessionID) liveOwners.set(owner, sessionID)
        let next: string | undefined
        for (const id of liveOwners.values()) next = id
        if (next === liveSession) return
        // 最后一个说"有"的走了(采集停了、面板卸载了):那个会话再拉最后一次,见 run()。
        ending = !next && liveSession && cursor ? { sessionID: liveSession, cursor } : undefined
        liveSession = next
        cursor = undefined
        tick = 0
        if (stopped) return
        // 顶掉在路上的那一拍,马上按新的读法来一拍。放进定时器而不是就地 run():这里常常是从组件的
        // effect 里叫过来的,就地跑会在那个 effect 里同步读 store(纪律 4 说的那种自依赖)。
        seq++
        clearTimeout(timer)
        timer = setTimeout(() => void run(), 0)
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
 * 实时拉一拍。**只返回回复,不写 store,也不动游标** —— 落不落地由调用方在 seq 关卡之后决定。
 * 游标对不上(换了一次采集:文件变了、序号倒退)时不带 since 再拉一次:带着旧游标拉回来的行是按错的
 * 序号筛过的,接不上。任何失败都是 undefined(调用方这一拍退回读盘),不抛。
 */
async function readLive(
  sessionID: string,
  from: LiveCursor | undefined,
): Promise<{ view: LogTailView; from: LiveCursor | undefined } | undefined> {
  if (!kernelAvailable()) return undefined
  try {
    const view = await kernel.instrument.logTail(from ? { sessionID, since: from.since } : { sessionID })
    if (!liveCursorStale(from, view)) return { view, from }
    return { view: await kernel.instrument.logTail({ sessionID }), from: undefined }
  } catch {
    return undefined
  }
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
    // 这一窗口之前文件里有几行(丢掉的那半行在窗口之后,不算)。行号按文件编,与实时那条路同一套。
    const before = Math.max(0, total - kept.length - (file.truncated && total > 0 ? 1 : 0))
    return {
      patch: {
        name,
        path,
        lines: numberLogLines(kept, before),
        clipped: before,
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
