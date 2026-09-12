/**
 * ls 工具的厨房那一半:一次 readdir,没有子进程。
 *
 * 存在性与类型走 `toolContext.env`(ExecutionEnv),但目录项**不走** env.listDir:它对 lstat 认不出的
 * 种类(字符设备、FIFO、socket)静默丢弃 —— 2026-09-12 审稿实测 `ls /dev` 345 项只剩 5 项,cu.* /
 * tty.* 一个都没有,输出却像一份完整清单;而"串口在不在"正是嵌入式 agent 用 ls 的头号场景。
 * 所以目录项用 node:fs 的 readdir(withFileTypes),什么种类都列,只有目录加后缀。
 * 路径入口仍过 host/domain/paths.ts 的 resolveToCwd:模型会把 bash 工具里看到的
 * MSYS 形状 "/d/proj" 原样喂过来,不翻译的话 Windows 上解析成 "D:\d\proj" 然后
 * 报"不存在",而那条错误文本里看不出是路径翻译的问题。
 *
 * 与 pi 原版(core/tools/ls.ts)的三处差异:
 * - 目录判定来自 readdir 一次性带回的 Dirent,省掉 pi 的 N 次 stat(一个
 *   万条目的目录从一万次 syscall 降到一次)。
 * - symlink 有独立的 kind,**不加任何后缀**:pi 那版用 stat(跟随符号链接),指向目录的
 *   链接会被印成 "name/",于是模型以为能 cd 进去;这里按字面呈现,不跟随,也不加 "@"
 *   之类的装饰 —— 多一种后缀就多一种要模型学的约定,而它最需要的是"这个名字能不能
 *   直接喂给 read"。
 * - 入口是 lstat 语义,所以一个指向目录的 symlink 被当成 path 传进来时要先 canonicalPath
 *   再判类型,否则 `ls some-link` 会答"Not a directory" —— pi 那版是能列的,这是回归。
 */

import { readdir } from "node:fs/promises"

import {
  type AgentHarnessTool,
  DEFAULT_MAX_BYTES,
  type ExecutionToolContext,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-agent-core"

import { resolveToCwd } from "../../domain/paths.ts"
import { LS_CONTRACT, type LsDetails } from "./contract.ts"

const DEFAULT_LIMIT = 500

/**
 * limit 钳位:非数回落默认值,下界是 1 而不是 0。
 * pi 原版直接用 `limit ?? 500`,于是 limit=0 会让一个满的目录输出 "(empty directory)" ——
 * 模型读到的是"这里什么都没有",而那是假的。
 */
function entryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.trunc(limit))
}

/** 目录项的呈现名:只有目录加 "/",symlink、普通文件、设备节点都是裸名(见文件头)。 */
export function formatEntry(info: { name: string; kind: string }): string {
  return info.kind === "directory" ? `${info.name}/` : info.name
}

/** 大小写无关的字母序。ICU 不同时混排大小写的结果会抖,所以测试只断言包含关系,不断言整个数组。 */
export function sortEntryNames(names: string[]): string[] {
  return [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}

export function createLsTool(
  _options: { enginesDir?: string } = {},
): AgentHarnessTool<ExecutionToolContext, typeof LS_CONTRACT.parameters, LsDetails | undefined> {
  // _options 只为和别的工具同形(登记者统一传 enginesDir):ls 不碰发动机,也不起子进程。
  return {
    name: LS_CONTRACT.name,
    label: LS_CONTRACT.label,
    description: LS_CONTRACT.description,
    parameters: LS_CONTRACT.parameters,
    execute: async (_toolCallId, params, _onUpdate, toolContext, _invocation, context) => {
      const env = toolContext.env
      if (context.abortSignal?.aborted) throw new Error("ls was aborted")
      const dir = resolveToCwd(env.cwd, params.path?.trim() || ".")
      const limit = entryLimit(params.limit)

      // 三句错误文本逐字照 pi:模型已经学会了它们的形状,换措辞等于换一套它没见过的信号。
      const exists = await env.exists(dir, context)
      if (!exists.ok) throw new Error(`Cannot read directory: ${exists.error.message}`)
      if (!exists.value) throw new Error(`Path not found: ${dir}`)
      const info = await env.fileInfo(dir, context)
      if (!info.ok) throw new Error(`Cannot read directory: ${info.error.message}`)
      let kind = info.value.kind
      if (kind === "symlink") {
        // fileInfo 是 lstat 语义;不跟随一次的话,指向目录的链接会被拒成 "Not a directory"。
        const target = await env.canonicalPath(dir, context)
        if (!target.ok) throw new Error(`Cannot read directory: ${target.error.message}`)
        const targetInfo = await env.fileInfo(target.value, context)
        if (!targetInfo.ok) throw new Error(`Cannot read directory: ${targetInfo.error.message}`)
        kind = targetInfo.value.kind
      }
      if (kind !== "directory") throw new Error(`Not a directory: ${dir}`)

      let entries: Array<{ name: string; kind: string }>
      try {
        entries = (await readdir(dir, { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
        }))
      } catch (error) {
        throw new Error(`Cannot read directory: ${error instanceof Error ? error.message : String(error)}`)
      }

      const byName = new Map(entries.map((entry) => [entry.name, entry]))
      const names = sortEntryNames([...byName.keys()])
      const entryLimitReached = names.length > limit
      const shown = names.slice(0, limit).map((name) => formatEntry(byName.get(name)!))
      if (shown.length === 0) {
        return { content: [{ type: "text", text: "(empty directory)" }], details: undefined }
      }

      // 只卡字节:条数已经由 limit 管住了,再加一道行数限制只会让两笔账互相掩盖。
      const truncation = truncateHead(shown.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER })
      let output = truncation.content
      const details: LsDetails = {}
      const notices: string[] = []
      if (entryLimitReached) {
        notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`)
        details.entryLimitReached = limit
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
        // 逐格拷:TruncationResult 里还带着 content,整份塞进 details 等于同一段文本跨进程传两遍。
        details.truncation = {
          truncated: truncation.truncated,
          truncatedBy: truncation.truncatedBy,
          totalLines: truncation.totalLines,
          totalBytes: truncation.totalBytes,
          outputLines: truncation.outputLines,
          outputBytes: truncation.outputBytes,
        }
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`

      return {
        content: [{ type: "text", text: output }],
        details: Object.keys(details).length > 0 ? details : undefined,
      }
    },
  }
}
