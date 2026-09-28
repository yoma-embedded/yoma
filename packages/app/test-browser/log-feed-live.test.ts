import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mock = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  logTail: vi.fn(),
}))
vi.mock("@/utils/kernel", () => ({
  kernelAvailable: () => true,
  kernel: {
    file: { list: mock.list, read: mock.read },
    instrument: { logTail: mock.logTail },
  },
}))

import {
  acquireLogFeed,
  LIVE_INTERVAL_MS,
  LogFeedTesting,
  POLL_INTERVAL_MS,
  releaseLogFeed,
  SLOW_INTERVAL_MS,
} from "@/pages/session/bench/log-feed"
import { LOG_TAIL_LINES } from "@/pages/session/bench/log-lines"
import type { LogTailView } from "@yoma-desktop/kernel"

const DIR = "D:\\develop\\motor_control\\BK64_motor"
const NAME = "hw-20260924-101112345.log"
const FILE = `${DIR}\\.yoma\\logs\\${NAME}`
const tail = (lines: string[], nextSeq: number, extra: Partial<LogTailView> = {}): LogTailView => ({
  running: true,
  source: "rtt STM32G473RC via J-Link SWD 4000 kHz",
  file: FILE,
  writable: true,
  nextSeq,
  lost: 0,
  lines,
  ...extra,
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => (resolve = yes))
  return { promise, resolve }
}
const owner = {}
const texts = (feed: ReturnType<typeof acquireLogFeed>) => feed.state.lines.map((line) => `${line.no}:${line.text}`)

beforeEach(() => {
  vi.useFakeTimers()
  // reset 而不是 clear:一条用例半路挂掉时,它排着没用完的 mockResolvedValueOnce 不许漏进下一条。
  vi.resetAllMocks()
  mock.list.mockResolvedValue([{ name: NAME, type: "file" }])
  mock.read.mockResolvedValue({ content: "[+0.001] boot\n[+0.002] [2] I: ready\n", truncated: false })
  mock.logTail.mockResolvedValue(tail([], 0, { running: false, file: undefined, source: undefined }))
})
afterEach(() => {
  LogFeedTesting.reset()
  vi.useRealTimers()
})

describe("log feed live mode", () => {
  test("without a live session it only reads the disk, numbered by file line", async () => {
    const feed = acquireLogFeed(DIR)
    await vi.advanceTimersByTimeAsync(0)
    expect(texts(feed)).toEqual(["1:[+0.001] boot", "2:[+0.002] [2] I: ready"])
    expect(feed.state.live).toBe(false)
    expect(mock.logTail).not.toHaveBeenCalled()
  })

  test("a running capture is pulled every LIVE_INTERVAL_MS with since, appended in place", async () => {
    const feed = acquireLogFeed(DIR)
    await vi.advanceTimersByTimeAsync(0)
    const disk = feed.state.lines
    mock.logTail.mockResolvedValueOnce(tail(["[+0.001] boot", "[+0.002] [2] I: ready"], 2))
    feed.setLive(owner, "s1")
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.logTail).toHaveBeenLastCalledWith({ sessionID: "s1" })
    expect(feed.state.live).toBe(true)
    expect(feed.state.name).toBe(NAME)
    expect(feed.state.path).toBe(`.yoma/logs/${NAME}`)
    // 读盘读到的正是这两行:数组原样留着(<Index> 不重建)
    expect(feed.state.lines).toBe(disk)

    mock.logTail.mockResolvedValueOnce(tail(["[+1.204] [4] E: [SAFETY] undervoltage"], 3))
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS)
    expect(mock.logTail).toHaveBeenLastCalledWith({ sessionID: "s1", since: 2 })
    expect(texts(feed)).toEqual([
      "1:[+0.001] boot",
      "2:[+0.002] [2] I: ready",
      "3:[+1.204] [4] E: [SAFETY] undervoltage",
    ])
    expect(feed.state.lines.at(-1)?.level).toBe("error")
    expect(feed.state.lines[0]).toBe(disk[0])

    // 没有新行:数组与 updatedAt 都不动
    const before = feed.state.lines
    const updatedAt = feed.state.updatedAt
    mock.logTail.mockResolvedValue(tail([], 3))
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS * 3)
    expect(feed.state.lines).toBe(before)
    expect(feed.state.updatedAt).toBe(updatedAt)
    expect(mock.logTail).toHaveBeenLastCalledWith({ sessionID: "s1", since: 3 })
    // 实时的时候不再每拍读盘
    const reads = mock.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    expect(mock.read.mock.calls.length).toBe(reads)
  })

  test("never overlaps its own requests, and a stale reply cannot overwrite a newer one", async () => {
    const feed = acquireLogFeed(DIR)
    await vi.advanceTimersByTimeAsync(0)
    const slow = deferred<LogTailView>()
    mock.logTail.mockReturnValueOnce(slow.promise)
    feed.setLive(owner, "s1")
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS * 5)
    // 在路上的那一拍没回来之前不排下一拍
    expect(mock.logTail).toHaveBeenCalledTimes(1)
    // 换了会话:那一拍被顶掉
    mock.logTail.mockResolvedValue(tail(["[+0.1] new session"], 1, { file: `${DIR}\\.yoma\\logs\\hw-2.log` }))
    feed.setLive(owner, "s2")
    await vi.advanceTimersByTimeAsync(0)
    slow.resolve(tail(["[+9] OLD SESSION"], 1))
    await vi.advanceTimersByTimeAsync(0)
    expect(texts(feed)).toEqual(["1:[+0.1] new session"])
    expect(feed.state.name).toBe("hw-2.log")
  })

  test("a new capture (different file) resets the cursor instead of filtering by the old since", async () => {
    const feed = acquireLogFeed(DIR)
    await vi.advanceTimersByTimeAsync(0)
    mock.logTail.mockResolvedValueOnce(tail(["a", "b", "c"], 3))
    feed.setLive(owner, "s1")
    await vi.advanceTimersByTimeAsync(0)
    const second = `${DIR}\\.yoma\\logs\\hw-2.log`
    mock.logTail.mockResolvedValueOnce(tail([], 1, { file: second }))
    mock.logTail.mockResolvedValueOnce(tail(["fresh"], 1, { file: second }))
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS)
    expect(mock.logTail.mock.calls.slice(-2).map(([params]) => params)).toEqual([
      { sessionID: "s1", since: 3 },
      { sessionID: "s1" },
    ])
    expect(texts(feed)).toEqual(["1:fresh"])
  })

  test("when the capture stops or logTail fails it quietly falls back to reading the same file", async () => {
    const feed = acquireLogFeed(DIR)
    await vi.advanceTimersByTimeAsync(0)
    mock.logTail.mockResolvedValueOnce(tail(["[+0.001] boot", "[+0.002] [2] I: ready", "[+0.003] more"], 3))
    feed.setLive(owner, "s1")
    await vi.advanceTimersByTimeAsync(0)
    const shown = feed.state.lines
    expect(feed.state.live).toBe(true)

    mock.logTail.mockRejectedValueOnce(new Error("unknown method instrument.logTail"))
    mock.read.mockResolvedValue({ content: "[+0.001] boot\n[+0.002] [2] I: ready\n[+0.003] more\n", truncated: false })
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS)
    expect(feed.state.live).toBe(false)
    expect(feed.state.error).toBeUndefined()
    // 同一份文件、同一套行号:数组原样留着,画面是连着的
    expect(feed.state.lines).toBe(shown)

    // 下一拍(读盘节奏)再问一次实时:采集停了 → 仍然读盘
    mock.logTail.mockResolvedValue(tail(["x"], 4, { running: false }))
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(feed.state.live).toBe(false)
  })

  test("setLive(undefined) from the last owner returns to disk mode; releasing the feed stops all polling", async () => {
    const feed = acquireLogFeed(DIR)
    await vi.advanceTimersByTimeAsync(0)
    const other = {}
    mock.logTail.mockResolvedValue(tail(["a"], 1))
    feed.setLive(owner, "s1")
    feed.setLive(other, "s1")
    await vi.advanceTimersByTimeAsync(0)
    feed.setLive(owner, undefined)
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS)
    // 另一个面板还在说"有"
    expect(feed.state.live).toBe(true)
    feed.setLive(other, undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.state.live).toBe(false)
    const calls = mock.logTail.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    expect(mock.logTail.mock.calls.length).toBe(calls)

    releaseLogFeed(DIR)
    expect(LogFeedTesting.size()).toBe(0)
    const total = mock.list.mock.calls.length + mock.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    expect(mock.list.mock.calls.length + mock.read.mock.calls.length).toBe(total)
  })

  describe("a log over file.read's 2 MB window", () => {
    // file.read 只给得出开头:前 30000 行,末尾那一行被字节数切断。
    const HEAD = {
      content: Array.from({ length: 30000 }, (_, i) => `[+${i}] line ${i + 1}`).join("\n"),
      truncated: true,
    }
    /** 内核那边的实时窗口:文件第 48001–50000 行。 */
    const LIVE = Array.from({ length: 2000 }, (_, i) => `[+${48000 + i}] line ${48001 + i}`)
    const REASON = "[+99] ! ERROR: RTT disconnected: target reset"
    const goLive = async () => {
      mock.read.mockResolvedValue(HEAD)
      const feed = acquireLogFeed(DIR)
      await vi.advanceTimersByTimeAsync(0)
      expect(feed.state.truncated).toBe(true)
      mock.logTail.mockResolvedValueOnce(tail(LIVE, 50000))
      feed.setLive(owner, "s1")
      await vi.advanceTimersByTimeAsync(0)
      expect(feed.state.live).toBe(true)
      expect(feed.state.lines.at(-1)).toMatchObject({ no: 50000 })
      return feed
    }

    test("when the capture stops it keeps the kernel's tail and the stop reason, not the head of the file", async () => {
      const feed = await goLive()
      // J-Link 掉线:内核说停了,带着停的那一刻写下的原因;这一拍退回读盘,读回来的是开头
      mock.logTail.mockResolvedValueOnce(tail([REASON], 50001, { running: false, writable: false }))
      const reads = mock.read.mock.calls.length
      await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS)
      expect(mock.read.mock.calls.length).toBe(reads + 1)
      expect(feed.state.live).toBe(false)
      expect(feed.state.lines.at(-1)).toMatchObject({ no: 50001, text: REASON, level: "error" })
      expect(feed.state.lines[0].no).toBe(48002)
      expect(feed.state.clipped).toBe(48001)
      // 屏幕上不是开头,"看到的是开头"的提示不挂
      expect(feed.state.truncated).toBe(false)

      // 面板随后交回 undefined、之后一直读盘:尾巴还在,而且大文件照旧 10 秒一拍(不每 2 秒拖 2 MB)
      const shown = feed.state.lines
      feed.setLive(owner, undefined)
      await vi.advanceTimersByTimeAsync(0)
      const afterHandBack = mock.read.mock.calls.length
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
      expect(mock.read.mock.calls.length).toBe(afterHandBack)
      await vi.advanceTimersByTimeAsync(SLOW_INTERVAL_MS)
      expect(mock.read.mock.calls.length).toBe(afterHandBack + 1)
      expect(feed.state.lines).toBe(shown)
      expect(feed.state.truncated).toBe(false)
    })

    test("handing the session back before the next tick still pulls the stop-time lines once", async () => {
      const feed = await goLive()
      // 用户按了断开:SerialControls 拿到 stop 的回复就交回 undefined,抢在这份 feed 的下一拍之前
      mock.logTail.mockResolvedValueOnce(tail([REASON], 50001, { running: false, writable: false }))
      feed.setLive(owner, undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(mock.logTail).toHaveBeenLastCalledWith({ sessionID: "s1", since: 50000 })
      expect(feed.state.lines.at(-1)).toMatchObject({ no: 50001, text: REASON })
      expect(feed.state.live).toBe(false)
      expect(feed.state.truncated).toBe(false)
      // 只拉这一次
      const calls = mock.logTail.mock.calls.length
      await vi.advanceTimersByTimeAsync(SLOW_INTERVAL_MS * 2)
      expect(mock.logTail.mock.calls.length).toBe(calls)
      expect(feed.state.lines.at(-1)).toMatchObject({ no: 50001 })
    })

    test("one failed pull on a running capture keeps the tail and retries live within POLL_INTERVAL_MS", async () => {
      const feed = await goLive()
      const shown = feed.state.lines
      mock.logTail.mockRejectedValueOnce(new Error("kernel busy"))
      await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS)
      expect(feed.state.live).toBe(false)
      expect(feed.state.lines).toBe(shown)
      expect(feed.state.truncated).toBe(false)

      const calls = mock.logTail.mock.calls.length
      mock.logTail.mockResolvedValueOnce(tail([...LIVE.slice(1), "[+50000] line 50001"], 50001))
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      expect(mock.logTail.mock.calls.length).toBe(calls + 1)
      expect(feed.state.live).toBe(true)
      expect(feed.state.lines.at(-1)).toMatchObject({ no: 50001 })
    })
  })

  test("with follow off a full live window only appends: every row keeps its line, nothing slides", async () => {
    const feed = acquireLogFeed(DIR)
    await vi.advanceTimersByTimeAsync(0)
    const full = Array.from({ length: LOG_TAIL_LINES }, (_, i) => `[+${i}] line ${i + 1}`)
    mock.logTail.mockResolvedValueOnce(tail(full, LOG_TAIL_LINES))
    feed.setLive(owner, "s1")
    await vi.advanceTimersByTimeAsync(0)
    const before = feed.state.lines
    expect(before).toHaveLength(LOG_TAIL_LINES)

    // 用户往上翻着看、正选中一段(面板的 onScroll 把跟随关了)
    feed.setFollow(false)
    mock.logTail.mockResolvedValueOnce(tail(["[+2000] n1", "[+2001] n2"], LOG_TAIL_LINES + 2))
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS)
    expect(feed.state.lines).toHaveLength(LOG_TAIL_LINES + 2)
    // `<Index>` 按下标复用节点:每个下标上还是原来那一行
    for (const i of [0, 1, 1000, LOG_TAIL_LINES - 1]) expect(feed.state.lines[i]).toBe(before[i])
    expect(feed.state.clipped).toBe(0)

    // 跟随回来:下一拍照常砍回 LOG_TAIL_LINES
    feed.setFollow(true)
    mock.logTail.mockResolvedValueOnce(tail(["[+2002] n3"], LOG_TAIL_LINES + 3))
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS)
    expect(feed.state.lines).toHaveLength(LOG_TAIL_LINES)
    expect(feed.state.lines[0].no).toBe(4)
  })

  test("disk mode numbers a clipped window by file line, so it matches the live numbering", async () => {
    const content = Array.from({ length: 2005 }, (_, i) => `[+${i}] line ${i + 1}`).join("\n") + "\n"
    mock.read.mockResolvedValue({ content, truncated: false })
    const feed = acquireLogFeed(DIR)
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.state.clipped).toBe(5)
    expect(feed.state.lines[0]).toMatchObject({ no: 6, text: "[+5] line 6" })
    expect(feed.state.lines.at(-1)).toMatchObject({ no: 2005, text: "[+2004] line 2005" })
  })
})
