/**
 * 资源管理器（右栏 file 模式）状态层。
 *
 * 设计：
 *  - 状态按「工作区目录」隔离，存放在模块级 Map 里 —— dock 模式切换 / 组件卸载 /
 *    会话切换后再回来，打开的文件、导航历史、未保存的编辑缓冲都还在。
 *  - 编辑缓冲独立于 context/file 的磁盘缓存：file.load 拿到的是磁盘内容（基线），
 *    缓冲保存用户正在编辑的文本；外部（agent / 其他编辑器）改盘时基线刷新，
 *    干净缓冲直接跟随磁盘，脏缓冲保留用户文本并标记 diskChanged。
 *  - 纯函数（历史栈、选区换算、类型判断）单独导出，便于单测。
 */
import { createRoot, createSignal } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { FileContent } from "@yoma-desktop/kernel"
import type { FileSelection } from "@/context/file"

export type MarkdownView = "preview" | "markdown"

export type ExplorerHistory = {
  stack: string[]
  index: number
}

export type LineEnding = "\n" | "\r\n"

export type ExplorerBuffer = {
  /** 编辑中的文本（统一 \n；textarea 只认 \n） */
  text: string
  /** 磁盘基线（最近一次 加载/保存 时的内容，统一 \n） */
  base: string
  /** 磁盘原始换行符，保存时还原 */
  eol: LineEnding
  dirty: boolean
  /** dirty 期间磁盘内容被外部改动 */
  diskChanged: boolean
  saving: boolean
}

// ---------------------------------------------------------------- 纯函数

export const HISTORY_MAX = 100
/** 干净缓冲保留上限（脏缓冲永不清退） */
export const CLEAN_BUFFER_MAX = 20

export function pushHistory(history: ExplorerHistory, path: string): ExplorerHistory {
  if (history.stack[history.index] === path) return history
  let stack = [...history.stack.slice(0, history.index + 1), path]
  if (stack.length > HISTORY_MAX) stack = stack.slice(stack.length - HISTORY_MAX)
  return { stack, index: stack.length - 1 }
}

export function historyStep(history: ExplorerHistory, delta: -1 | 1): ExplorerHistory {
  const index = history.index + delta
  if (index < 0 || index >= history.stack.length) return history
  return { stack: history.stack, index }
}

/** 从历史里剔除一个路径（文件被删除等场景），index 尽量落在原位附近 */
export function dropFromHistory(history: ExplorerHistory, path: string): ExplorerHistory {
  const stack = history.stack.filter((item) => item !== path)
  if (stack.length === history.stack.length) return history
  const removedBefore = history.stack.slice(0, history.index + 1).filter((item) => item === path).length
  const index = Math.min(Math.max(history.index - removedBefore, -1), stack.length - 1)
  return { stack, index }
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

/** 多数换行符为 CRLF 时按 CRLF 保存（textarea 内部统一为 \n） */
export function detectEol(text: string): LineEnding {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  if (crlf === 0) return "\n"
  const lf = text.match(/\n/g)?.length ?? 0
  return crlf * 2 > lf ? "\r\n" : "\n"
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n")
}

export function serializeEol(text: string, eol: LineEnding): string {
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text
}

/**
 * mime 是否是文本。
 *
 * 内核的 file.read 只有 `mime` 一个判别位（原来后端返回 type/encoding 两个字段，
 * 现在都没有了）。text/* 之外还有一批实际上是纯文本的 application/* 。
 */
export function isTextMime(mime: string | undefined): boolean {
  if (!mime) return false
  const base = mime.split(";", 1)[0]!.trim().toLowerCase()
  if (base.startsWith("text/")) return true
  if (base.endsWith("+json") || base.endsWith("+xml")) return true
  return base === "application/json" || base === "application/xml" || base === "application/javascript"
}

/** 内容可用文本编辑器打开（文本 mime，且不是被截断的片段 —— 存回去会丢数据） */
export function isEditableContent(content: FileContent | undefined): content is FileContent {
  if (!content) return false
  if (content.truncated) return false
  return isTextMime(content.mime)
}

/** index（含）之前的文本 → 1-based 行号 + 0-based 列号 */
export function lineColFromIndex(text: string, index: number): { line: number; col: number } {
  const clamped = Math.max(0, Math.min(index, text.length))
  let line = 1
  let lineStart = 0
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++
      lineStart = i + 1
    }
  }
  return { line, col: clamped - lineStart }
}

/** textarea 的选区 → FileSelection（1-based 行、0-based 列） */
export function selectionFromOffsets(text: string, start: number, end: number): FileSelection {
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  const a = lineColFromIndex(text, from)
  const b = lineColFromIndex(text, to)
  return { startLine: a.line, startChar: a.col, endLine: b.line, endChar: b.col }
}

/** 展开某个文件路径的所有祖先目录（"a/b/c.ts" → ["a","a/b"]） */
export function ancestorDirs(path: string): string[] {
  const parts = path.split("/").filter(Boolean)
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"))
  return out
}

// ---------------------------------------------------------------- 目录级 store

function createExplorerScope() {
  return createRoot(() => {
    const [openPath, setOpenPath] = createSignal<string | undefined>(undefined)
    const [treeVisible, setTreeVisible] = createSignal(true)
    const [history, setHistory] = createStore<ExplorerHistory>({ stack: [], index: -1 })
    const [markdownView, setMarkdownView] = createStore<Record<string, MarkdownView>>({})
    const [buffers, setBuffers] = createStore<Record<string, ExplorerBuffer>>({})
    /** 干净缓冲的 LRU 顺序（旧 → 新） */
    let cleanOrder: string[] = []

    const touchClean = (path: string) => {
      cleanOrder = cleanOrder.filter((item) => item !== path)
      cleanOrder.push(path)
      while (cleanOrder.length > CLEAN_BUFFER_MAX) {
        const evict = cleanOrder.shift()
        if (!evict) break
        setBuffers(
          produce((draft) => {
            if (draft[evict] && !draft[evict].dirty) delete draft[evict]
          }),
        )
      }
    }

    const markDirtyTracking = (path: string, dirty: boolean) => {
      if (dirty) cleanOrder = cleanOrder.filter((item) => item !== path)
      else touchClean(path)
    }

    return {
      openPath,
      setOpenPath,
      treeVisible,
      setTreeVisible,

      history: () => history,
      push(path: string) {
        const next = pushHistory(unwrap(history) as ExplorerHistory, path)
        setHistory(next)
      },
      step(delta: -1 | 1): string | undefined {
        const next = historyStep(unwrap(history) as ExplorerHistory, delta)
        if (next === (unwrap(history) as ExplorerHistory)) return undefined
        setHistory(next)
        return next.stack[next.index]
      },
      canBack: () => history.index > 0,
      canForward: () => history.index < history.stack.length - 1,

      markdownView: (path: string): MarkdownView => markdownView[path] ?? "markdown",
      setMarkdownViewFor(path: string, view: MarkdownView) {
        setMarkdownView(path, view)
      },

      buffer: (path: string): ExplorerBuffer | undefined => buffers[path],
      /** 磁盘内容就绪/刷新：干净缓冲跟随磁盘，脏缓冲保留并比对基线 */
      adoptDisk(path: string, diskRaw: string) {
        const eol = detectEol(diskRaw)
        const diskText = normalizeEol(diskRaw)
        const current = buffers[path]
        if (!current) {
          setBuffers(path, { text: diskText, base: diskText, eol, dirty: false, diskChanged: false, saving: false })
          touchClean(path)
          return
        }
        if (!current.dirty) {
          setBuffers(path, { text: diskText, base: diskText, eol, diskChanged: false })
          touchClean(path)
          return
        }
        if (diskText !== current.base) setBuffers(path, "diskChanged", true)
      },
      edit(path: string, text: string) {
        const current = buffers[path]
        if (!current) return
        const dirty = text !== current.base
        setBuffers(path, { text, dirty })
        markDirtyTracking(path, dirty)
      },
      savingStart(path: string) {
        if (buffers[path]) setBuffers(path, "saving", true)
      },
      savingDone(path: string, savedText: string, ok: boolean) {
        const current = buffers[path]
        if (!current) return
        if (!ok) {
          setBuffers(path, "saving", false)
          return
        }
        const dirty = current.text !== savedText
        setBuffers(path, { base: savedText, dirty, diskChanged: false, saving: false })
        markDirtyTracking(path, dirty)
      },
      dismissDiskChange(path: string) {
        if (buffers[path]) setBuffers(path, "diskChanged", false)
      },
      /** 放弃缓冲（重新加载磁盘内容） */
      discard(path: string) {
        setBuffers(
          produce((draft) => {
            delete draft[path]
          }),
        )
        cleanOrder = cleanOrder.filter((item) => item !== path)
      },
      dirtyPaths: () =>
        Object.entries(buffers)
          .filter(([, buffer]) => buffer.dirty)
          .map(([path]) => path),
    }
  })
}

export type ExplorerScope = ReturnType<typeof createExplorerScope>

const scopes = new Map<string, ExplorerScope>()

/** 取某个工作区目录的资源管理器状态（模块级缓存，应用生命周期内常驻） */
export function explorerScope(directory: string): ExplorerScope {
  const key = directory || "__default__"
  const existing = scopes.get(key)
  if (existing) return existing
  const scope = createExplorerScope()
  scopes.set(key, scope)
  return scope
}
