/**
 * 项目目录的文件监视器:工作树一有变化就推 `vcs.updated`,审查页据此重拉 diff。
 *
 * 这是 VS Code 源代码管理视图"改完立刻刷新"的那半机制。`vcs.updated` 这个事件类型和前端的接收端
 * 都是从 opencode 移植来的,但服务端的监视器当年没有一起过来 —— 于是审查页只在打开时拉一次,
 * 之后要等 agent 跑完一轮才刷新;用户在编辑器里改的文件永远看不见(2026-09-06 实测)。
 *
 * 两条纪律:
 * - `.git/` 下面只认提交 / 切分支留下的痕迹(HEAD、refs、logs、packed-refs)。`git diff` / `git status`
 *   自己会刷新 `.git/index`,把它算进去就是"刷新触发刷新"的死循环。
 * - 监视器 `persistent:false`,定时器 unref:它们不能把 utilityProcess 吊住不退出(见 host/stream.ts)。
 *
 * git worktree 的 `.git` 是一个指针文件,真正的仓库目录在别处,那种检出里提交不会被监视到 ——
 * agent 跑完一轮照旧会刷新,只是用户自己在终端提交后要等下一次刷新。
 */

import { watch, type FSWatcher } from "node:fs"
import path from "node:path"

import type { VcsInfo } from "../types.ts"
import { vcsInfo } from "./services.ts"

export interface VcsWatchOptions {
  emit(directory: string, info: VcsInfo): void
  /** 去抖窗口。一次保存、一次 bun install 都是一串事件,只刷一次。 */
  debounceMs?: number
  /** 最多同时盯几个目录;超过按最久没用过的关掉。 */
  maxWatchers?: number
}

/** 该不该因为这条(相对被监视目录的)路径的变化去刷新审查页。 */
export function shouldRefresh(relative: string | null | undefined): boolean {
  if (!relative) return true
  const p = relative.replace(/\\/g, "/")
  if (p === ".git" || p.startsWith(".git/")) {
    return (
      p === ".git/HEAD" ||
      p === ".git/packed-refs" ||
      p === ".git/MERGE_HEAD" ||
      p.startsWith(".git/refs/") ||
      p.startsWith(".git/logs/")
    )
  }
  if (p === "node_modules" || p.startsWith("node_modules/") || p.includes("/node_modules/")) return false
  if (p === ".yoma" || p.startsWith(".yoma/")) return false
  return true
}

interface Entry {
  watcher: FSWatcher
  timer?: ReturnType<typeof setTimeout>
  lastUsed: number
  /** 这个目录到来时的各种写法,事件按每种写法各回一条。 */
  names: Set<string>
}

export class VcsWatchers {
  private readonly entries = new Map<string, Entry>()
  private readonly options: Required<VcsWatchOptions>
  private closed = false

  constructor(options: VcsWatchOptions) {
    this.options = {
      emit: options.emit,
      debounceMs: options.debounceMs ?? 400,
      maxWatchers: options.maxWatchers ?? 16,
    }
  }

  /**
   * 开始盯一个目录。同一个目录会以不同写法到来 —— 路由里是 `D:\x`,会话记录里是 `D:/x`,
   * 前端各处拿着哪种就传哪种,而 session 页收到事件时是**按字符串相等**认目录的。所以按解析后
   * 的真实路径只开一个监视器,但每种写法都记着,事件按每种写法各回一条。2026-09-06 实测:
   * 只回登记时那一种写法的话,用户在 VS Code 里改文件,事件到了前端却被当成别的目录丢掉。
   */
  ensure(directory: string): void {
    if (this.closed) return
    const key = path.resolve(directory)
    const existing = this.entries.get(key)
    if (existing) {
      existing.lastUsed = Date.now()
      existing.names.add(directory)
      return
    }
    while (this.entries.size >= this.options.maxWatchers) {
      let oldest: string | undefined
      let oldestUsed = Infinity
      for (const [candidate, entry] of this.entries) {
        if (entry.lastUsed < oldestUsed) {
          oldest = candidate
          oldestUsed = entry.lastUsed
        }
      }
      if (oldest === undefined) break
      this.drop(oldest)
    }
    let watcher: FSWatcher
    try {
      watcher = watch(key, { recursive: true, persistent: false }, (_event, filename) => {
        if (!shouldRefresh(filename)) return
        this.schedule(key)
      })
    } catch {
      // 平台不支持递归监视,或目录已经没了:没有监视器,审查页退回"agent 跑完再刷"。
      return
    }
    watcher.on("error", () => this.drop(key))
    this.entries.set(key, { watcher, lastUsed: Date.now(), names: new Set([directory]) })
  }

  watching(directory: string): boolean {
    return this.entries.has(path.resolve(directory))
  }

  dispose(): void {
    this.closed = true
    // drop 会改 map,先把 key 复制出来再遍历
    for (const directory of Array.from(this.entries.keys())) this.drop(directory)
  }

  private schedule(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void this.fire(key)
    }, this.options.debounceMs)
    ;(entry.timer as { unref?: () => void }).unref?.()
  }

  private async fire(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (this.closed || !entry) return
    const info = await vcsInfo(key).catch(() => undefined)
    if (!info || this.closed) return
    if (!info.root) {
      // 不是仓库(或 .git 刚被删了):盯着没意义,自己退场;下次 vcs.info / vcs.diff 会再登记。
      this.drop(key)
      return
    }
    for (const name of entry.names) this.options.emit(name, info)
  }

  private drop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
    try {
      entry.watcher.close()
    } catch {
      // 已经关了
    }
  }
}
