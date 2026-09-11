/**
 * 文件监视器:改了文件要推 vcs.updated,而自己刷新时写的 .git/index 不能把自己再触发一遍。
 *
 * 分两层测。监视器自己的逻辑(过滤、去抖、按每种写法各回一条、非仓库自己退场)用假监视器直接喂事件,
 * 完全确定。真的 node:fs.watch 只留两条"最终会来"的集成用例,不对着真监视器断言"恰好几条":
 * macOS 的 FSEvents 流是异步起的,watch() 返回后的窗口里动静会丢;系统忙时事件还会被合并成一条没有
 * 文件名的通知。2026-09 全量测试并行跑时这里红了五次、单跑都过,走的就是这两条路。
 */

import { describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { VcsInfo } from "../types.ts"
import { VcsWatchers, shouldRefresh, type WatchFn } from "./vcs-watch.ts"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "pipe",
  })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const DEBOUNCE = 100
/** 真监视器的用例:满载下每一步都可能慢几秒,预算放宽;单跑在 5 秒以内。 */
const SLOW = 60_000

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

/**
 * 反复写 file 直到 predicate 成立。起流窗口里的动静会丢,只写一次就是在赌;每写一次等上一秒半再写,
 * 写太密会排出一串在飞的刷新(每次刷新都是好几个 git 子进程),满载下落地要好几秒。
 */
async function pokeUntil(file: string, predicate: () => boolean, capMs = 15_000): Promise<boolean> {
  const started = Date.now()
  while (!predicate() && Date.now() - started < capMs) {
    writeFileSync(file, `${Date.now()}\n`)
    if (await waitFor(predicate, 1_500)) return true
  }
  return predicate()
}

/** 等到连续 quietMs 没有新事件(在飞的刷新都落地了);到 capMs 还没安静就返回 false。 */
async function settle(events: readonly unknown[], quietMs = 800, capMs = 10_000): Promise<boolean> {
  const started = Date.now()
  let seen = events.length
  let quietSince = Date.now()
  while (Date.now() - started < capMs) {
    await sleep(50)
    if (events.length !== seen) {
      seen = events.length
      quietSince = Date.now()
    } else if (Date.now() - quietSince >= quietMs) return true
  }
  return false
}

/** 假监视器:记住回调,用例直接喂事件。 */
class FakeWatch {
  readonly listeners: Array<(event: string, filename: string | null) => void> = []
  closed = 0
  readonly watch: WatchFn = (_directory, _options, listener) => {
    this.listeners.push(listener)
    return {
      on: () => undefined,
      close: () => {
        this.closed += 1
      },
    }
  }
  emit(filename: string | null): void {
    for (const listener of this.listeners) listener("change", filename)
  }
}

function initRepo(prefix: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), prefix))
  git(repo, "init", "-q", "-b", "main")
  return repo
}

type Event = { directory: string; info: VcsInfo }

describe("shouldRefresh", () => {
  test("工作树里的普通路径要刷;分隔符两种写法都认", () => {
    expect(shouldRefresh("src/main.c")).toBe(true)
    expect(shouldRefresh("src\\main.c")).toBe(true)
    expect(shouldRefresh("README.md")).toBe(true)
    // 平台给不出文件名时宁可多刷一次
    expect(shouldRefresh(null)).toBe(true)
    expect(shouldRefresh(undefined)).toBe(true)
  })

  test(".git 下只认提交 / 切分支的痕迹,index 这种自己刷新时会写的不算", () => {
    expect(shouldRefresh(".git/index")).toBe(false)
    expect(shouldRefresh(".git/index.lock")).toBe(false)
    expect(shouldRefresh(".git/objects/ab/cdef")).toBe(false)
    expect(shouldRefresh(".git")).toBe(false)
    expect(shouldRefresh(".git/HEAD")).toBe(true)
    expect(shouldRefresh(".git\\refs\\heads\\main")).toBe(true)
    expect(shouldRefresh(".git/logs/HEAD")).toBe(true)
    expect(shouldRefresh(".git/packed-refs")).toBe(true)
  })

  test("node_modules 与 .yoma 运行产物不刷", () => {
    expect(shouldRefresh("node_modules/x/index.js")).toBe(false)
    expect(shouldRefresh("packages/app/node_modules/x")).toBe(false)
    expect(shouldRefresh(".yoma/logs/a.log")).toBe(false)
  })
})

describe("VcsWatchers(假监视器)", () => {
  test("一串动静只刷一次;同一目录的两种写法只开一个监视器,事件却各回一条", async () => {
    const repo = initRepo("yoma-vcs-watch-fake-")
    const fake = new FakeWatch()
    const events: Event[] = []
    const watchers = new VcsWatchers({
      emit: (directory, info) => events.push({ directory, info }),
      debounceMs: DEBOUNCE,
      watch: fake.watch,
    })
    try {
      // 路由里是 D:\x、会话记录里是 D:/x,前端 session 页按字符串相等认目录
      const alias = repo.replaceAll("\\", "/") + "/"
      watchers.ensure(repo)
      watchers.ensure(alias)
      watchers.ensure(repo)
      expect(fake.listeners.length).toBe(1)
      expect(watchers.watching(repo)).toBe(true)
      expect(watchers.watching(alias)).toBe(true)

      for (const name of ["a.txt", "src/b.c", "a.txt"]) fake.emit(name)
      expect(await waitFor(() => events.length >= 2, 5_000)).toBe(true)
      expect(await settle(events)).toBe(true)
      expect(events.map((e) => e.directory).sort()).toEqual([repo, alias].sort())
      expect(events.every((e) => e.info.root !== undefined)).toBe(true)
    } finally {
      watchers.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("node_modules、.yoma、.git/index 的动静不刷;提交留下的 .git/logs/HEAD 要刷", async () => {
    const repo = initRepo("yoma-vcs-watch-filter-")
    const fake = new FakeWatch()
    const events: Event[] = []
    const watchers = new VcsWatchers({
      emit: (directory, info) => events.push({ directory, info }),
      debounceMs: DEBOUNCE,
      watch: fake.watch,
    })
    try {
      watchers.ensure(repo)
      for (const name of ["node_modules/x/index.js", ".yoma/logs/a.log", ".git/index", ".git/objects/ab/cdef"]) {
        fake.emit(name)
      }
      await sleep(DEBOUNCE * 5)
      expect(events.length).toBe(0)
      expect(watchers.watching(repo)).toBe(true)

      fake.emit(".git/logs/HEAD")
      expect(await waitFor(() => events.length >= 1, 5_000)).toBe(true)
    } finally {
      watchers.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("不是仓库的目录:有动静就自己退场、关掉监视器、不推事件", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yoma-vcs-watch-plain-"))
    const fake = new FakeWatch()
    const events: Event[] = []
    const watchers = new VcsWatchers({
      emit: (directory, info) => events.push({ directory, info }),
      debounceMs: DEBOUNCE,
      watch: fake.watch,
    })
    try {
      watchers.ensure(dir)
      fake.emit("a.txt")
      expect(await waitFor(() => !watchers.watching(dir), 5_000)).toBe(true)
      expect(events.length).toBe(0)
      expect(fake.closed).toBe(1)
    } finally {
      watchers.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("超过上限时关掉最久没用的那个", () => {
    const dirs = [1, 2, 3].map((n) => mkdtempSync(path.join(tmpdir(), `yoma-vcs-watch-cap-${n}-`)))
    const fake = new FakeWatch()
    const watchers = new VcsWatchers({ emit: () => {}, maxWatchers: 2, watch: fake.watch })
    try {
      watchers.ensure(dirs[0]!)
      watchers.ensure(dirs[1]!)
      watchers.ensure(dirs[2]!)
      expect(watchers.watching(dirs[0]!)).toBe(false)
      expect(watchers.watching(dirs[1]!)).toBe(true)
      expect(watchers.watching(dirs[2]!)).toBe(true)
      expect(fake.closed).toBe(1)
    } finally {
      watchers.dispose()
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("VcsWatchers(真的 node:fs.watch)", () => {
  test(
    "改文件最终推 vcs.updated(dirty:true);自己刷新写的 .git/index 不再触发;提交后 dirty 回到 false",
    async () => {
      const repo = initRepo("yoma-vcs-watch-real-")
      const events: Event[] = []
      const watchers = new VcsWatchers({ emit: (directory, info) => events.push({ directory, info }), debounceMs: DEBOUNCE })
      try {
        writeFileSync(path.join(repo, "a.txt"), "a\n")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "init")
        watchers.ensure(repo)

        // 预热(见文件头):戳到第一条事件,等在飞的刷新落地,清零
        expect(await pokeUntil(path.join(repo, "a.txt"), () => events.length >= 1)).toBe(true)
        expect(await settle(events)).toBe(true)
        events.length = 0

        writeFileSync(path.join(repo, "a.txt"), "changed\n")
        expect(await waitFor(() => events.length >= 1, 10_000)).toBe(true)
        expect(await settle(events)).toBe(true)
        expect(events.every((e) => e.directory === repo && e.info.dirty === true && e.info.root !== undefined)).toBe(true)

        // 直接制造一次 .git/index 写入(git add 先写 index.lock 再改名成 index):不该有新事件
        const seen = events.length
        git(repo, "add", "a.txt")
        await sleep(1_000)
        expect(events.length).toBe(seen)

        // 提交之后要刷(.git/logs/HEAD 变了),而且 dirty 回到 false
        git(repo, "commit", "-q", "-m", "second")
        expect(await waitFor(() => events.length > seen, 10_000)).toBe(true)
        expect(await settle(events)).toBe(true)
        expect(events[events.length - 1]!.info.dirty).toBe(false)

        watchers.dispose()
        expect(watchers.watching(repo)).toBe(false)
      } finally {
        watchers.dispose()
        rmSync(repo, { recursive: true, force: true })
      }
    },
    SLOW,
  )

  test(
    "不是仓库的目录:有动静之后监视器自己退场,不推事件",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "yoma-vcs-watch-plain-real-"))
      const events: unknown[] = []
      const watchers = new VcsWatchers({ emit: (directory, info) => events.push({ directory, info }), debounceMs: DEBOUNCE })
      try {
        watchers.ensure(dir)
        expect(watchers.watching(dir)).toBe(true)
        expect(await pokeUntil(path.join(dir, "a.txt"), () => !watchers.watching(dir))).toBe(true)
        expect(events.length).toBe(0)
      } finally {
        watchers.dispose()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    SLOW,
  )
})
