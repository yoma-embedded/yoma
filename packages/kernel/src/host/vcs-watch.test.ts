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

      watchers.ensure(repo)
      expect(watchers.watching(repo)).toBe(true)
      // 幂等
      watchers.ensure(repo)

      writeFileSync(path.join(repo, "a.txt"), "changed\n")
      expect(await waitFor(() => events.length >= 1, 3_000)).toBe(true)
      expect(events[0]!.directory).toBe(repo)
      expect(events[0]!.info.dirty).toBe(true)
      expect(events[0]!.info.root).toBeDefined()

      // 上一次 fire 里的 git status 会碰 .git/index;静一秒,不该有第二条
      await sleep(1_000)
      expect(events.length).toBe(1)

      // 提交之后也要刷(.git/logs/HEAD 变了),而且 dirty 回到 false
      git(repo, "add", ".")
      git(repo, "commit", "-q", "-m", "second")
      expect(await waitFor(() => events.length >= 2, 3_000)).toBe(true)
      expect(events[events.length - 1]!.info.dirty).toBe(false)
    } finally {
      watchers.dispose()
      expect(watchers.watching(repo)).toBe(false)
      rmSync(repo, { recursive: true, force: true })
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
