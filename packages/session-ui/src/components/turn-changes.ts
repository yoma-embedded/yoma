/**
 * 这一轮里 agent 用 edit / write 改了哪些文件 —— 时间线「本轮改动」那一行的数据。
 *
 * opencode 的这一行读 `UserMessage.summary.diffs`,那是它的文件快照产物;内核没有快照,数据从工具结果里合成:
 *   - edit 的 details.patch(上游自带,jsdiff 的统一 diff,4 行上下文);
 *   - write 的 details.before(宿主在 write-before.ts 里补的)+ 调用参数里的 content。
 *
 * 只管这两个工具。bash 里的 sed、代码生成器、git checkout 改的文件不在这里 —— 那是审查面板(VCS diff)的事,
 * 这一行的标题也只说「已修改」,不说「全部改动」。
 *
 * 同一个文件一轮里被改多次时,逐次的 diff 按先后叠着放,不合成一份:edit 的 patch 只带 4 行上下文,没有全文
 * 就合不出一份对的(第二次的行号是相对第一次改完之后的)。行数也是逐次相加 —— 同一行改两遍算两次。
 */

import type { FileDiffMetadata } from "@pierre/diffs"
import type { Part, ToolPart } from "@yoma-desktop/kernel"
import { resolveFileDiff, type DiffSource } from "./session-diff"

export const FILE_CHANGE_TOOLS = new Set(["edit", "write"])

export type FileChange = {
  /** 归一过的绝对路径(相对路径按会话目录补全),同一个文件的多次改动靠它并到一起。 */
  file: string
  /** 给人看的路径:在会话目录里就写相对的。 */
  display: string
  /** 这一轮里第一次碰它就是新建。 */
  created: boolean
  /** 逐次改动,按发生的先后。 */
  sources: DiffSource[]
  /** 改了、但没记下内容的次数(旧会话里的 write;被覆盖的文件过大 / 是二进制)。 */
  opaque: number
}

export function isFileChange(part: Part): part is ToolPart {
  if (part.type !== "tool" || !FILE_CHANGE_TOOLS.has(part.tool)) return false
  if (part.state.status !== "completed") return false
  return typeof part.state.input?.path === "string"
}

const isAbsolute = (path: string) =>
  path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("//")

const trimEnd = (directory: string) => directory.replace(/[\\/]+$/, "")

/** 与工具自己的解析同向:`@` 前缀是提及写法,相对路径相对会话目录。不碰文件系统,`..` 之类原样留着。 */
export function resolveChangePath(directory: string, path: string) {
  const value = (path.startsWith("@") ? path.slice(1) : path).replace(/^\.[\\/]+/, "")
  if (isAbsolute(value) || !directory) return value
  return `${trimEnd(directory)}/${value}`
}

function displayPath(directory: string, file: string) {
  const root = trimEnd(directory)
  if (!root) return file
  const head = file.slice(0, root.length)
  const rest = file.slice(root.length)
  if (head !== root || !/^[\\/]/.test(rest)) return file
  return rest.replace(/^[\\/]+/, "")
}

function sourceOf(part: ToolPart, file: string): { source?: DiffSource; created: boolean } {
  if (part.state.status !== "completed") return { created: false }
  const metadata = (part.state.metadata ?? {}) as Record<string, unknown>
  if (part.tool === "edit") {
    return { created: false, source: typeof metadata.patch === "string" ? { file, patch: metadata.patch } : undefined }
  }
  const after = part.state.input?.content
  if (typeof after !== "string") return { created: false }
  if (metadata.before === null) return { created: true, source: { file, before: "", after } }
  if (typeof metadata.before === "string") return { created: false, source: { file, before: metadata.before, after } }
  return { created: false }
}

export function turnFileChanges(parts: readonly Part[], directory: string): FileChange[] {
  const byFile = new Map<string, FileChange>()
  for (const part of parts) {
    if (!isFileChange(part)) continue
    const file = resolveChangePath(directory, part.state.input.path as string)
    const next = sourceOf(part, file)
    const change = byFile.get(file) ?? {
      file,
      display: displayPath(directory, file),
      created: next.created,
      sources: [],
      opaque: 0,
    }
    if (next.source) change.sources.push(next.source)
    else change.opaque += 1
    byFile.set(file, change)
  }
  return Array.from(byFile.values())
}

export type FileChangeView = {
  diffs: FileDiffMetadata[]
  additions: number
  deletions: number
}

/** 解析是重活(patch → 逐行结构,新建的大文件尤其),只在那一行真的画出来时才做。 */
export function fileChangeView(change: FileChange): FileChangeView {
  const diffs = change.sources.map(resolveFileDiff)
  const hunks = diffs.flatMap((diff) => diff.hunks)
  return {
    diffs,
    additions: hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
    deletions: hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
  }
}
