/**
 * 文件监视器:改了文件要推 vcs.updated,而自己刷新时写的 .git/index 不能把自己再触发一遍。
 */

import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { VcsInfo } from "../types.ts"
import { VcsWatchers, shouldRefresh } from "./vcs-watch.ts"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "pipe",
  })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

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

describe("VcsWatchers", () => {
  test("改一个文件 → 一次 vcs.updated(dirty:true);自己刷新写下的 .git/index 不会再触发一次", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "yoma-vcs-watch-"))
    const events: Array<{ directory: string; info: VcsInfo }> = []
    const watchers = new VcsWatchers({ emit: (directory, info) => events.push({ directory, info }), debounceMs: 100 })
    try {
      git(repo, "init", "-q", "-b", "main")
      writeFileSync(path.join(repo, "a.txt"), "a\n")
      git(repo, "add", ".")
      git(repo, "commit", "-q", "-m", "init")

      // 同一目录的第二种写法(带尾斜杠;Windows 上再换成正斜杠):只开一个监视器,事件却要按两种写法各回一条 ——
      // 前端 session 页按字符串相等认目录,路由里是 D:\x、会话记录里是 D:/x。
      const alias = repo.replaceAll("\\", "/") + "/"
      watchers.ensure(repo)
      watchers.ensure(alias)
      expect(watchers.watching(repo)).toBe(true)
      expect(watchers.watching(alias)).toBe(true)
      // 幂等
      watchers.ensure(repo)

      writeFileSync(path.join(repo, "a.txt"), "changed\n")
      expect(await waitFor(() => events.length >= 2, 3_000)).toBe(true)
      expect(events.map((e) => e.directory).sort()).toEqual([repo, alias].sort())
      expect(events.every((e) => e.info.dirty === true && e.info.root !== undefined)).toBe(true)

      // 上一次 fire 里的 git status 会碰 .git/index;静一秒,不该再来
      await sleep(1_000)
      expect(events.length).toBe(2)

      // 提交之后也要刷(.git/logs/HEAD 变了),而且 dirty 回到 false
      git(repo, "add", ".")
      git(repo, "commit", "-q", "-m", "second")
      expect(await waitFor(() => events.length >= 4, 3_000)).toBe(true)
      expect(events[events.length - 1]!.info.dirty).toBe(false)
    } finally {
      watchers.dispose()
      expect(watchers.watching(repo)).toBe(false)
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("不是仓库的目录:第一次动静之后监视器自己退场,不推事件", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yoma-vcs-watch-plain-"))
    const events: unknown[] = []
    const watchers = new VcsWatchers({ emit: (directory, info) => events.push({ directory, info }), debounceMs: 100 })
    try {
      watchers.ensure(dir)
      expect(watchers.watching(dir)).toBe(true)
      writeFileSync(path.join(dir, "a.txt"), "a\n")
      expect(await waitFor(() => !watchers.watching(dir), 3_000)).toBe(true)
      expect(events.length).toBe(0)
    } finally {
      watchers.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("node_modules 里的动静不触发", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "yoma-vcs-watch-nm-"))
    const events: unknown[] = []
    const watchers = new VcsWatchers({ emit: (directory, info) => events.push({ directory, info }), debounceMs: 100 })
    try {
      git(repo, "init", "-q", "-b", "main")
      mkdirSync(path.join(repo, "node_modules", "x"), { recursive: true })
      watchers.ensure(repo)
      writeFileSync(path.join(repo, "node_modules", "x", "index.js"), "1\n")
      await sleep(800)
      expect(events.length).toBe(0)
    } finally {
      watchers.dispose()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("超过上限时关掉最久没用的那个", () => {
    const dirs = [1, 2, 3].map((n) => mkdtempSync(path.join(tmpdir(), `yoma-vcs-watch-cap-${n}-`)))
    const watchers = new VcsWatchers({ emit: () => {}, maxWatchers: 2 })
    try {
      watchers.ensure(dirs[0]!)
      watchers.ensure(dirs[1]!)
      watchers.ensure(dirs[2]!)
      expect(watchers.watching(dirs[0]!)).toBe(false)
      expect(watchers.watching(dirs[1]!)).toBe(true)
      expect(watchers.watching(dirs[2]!)).toBe(true)
    } finally {
      watchers.dispose()
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    }
  })
})
