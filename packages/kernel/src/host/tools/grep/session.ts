/**
 * grep 工具的厨房那一半:自带 ripgrep 的内容搜索。
 *
 * 2026-09-12 从 pi 的 core/tools/grep.ts 移回来,四处换成 yoma 的底座:
 * - rg 不再现下载(上游 ensureTool("rg") 会去 GitHub 拉):engines/build.ts 已经把 14.1.1 钉进
 *   engines/bin,这里走 engineBin("rg") 的**绝对路径** —— 内核进程自己的 PATH 上没有 rg(只有
 *   会话 shell 的 env 被前置过 engines/bin),用裸名字 spawn 只会得到 ENOENT。
 * - 子进程走 host/domain 的 runEngineLines:流式逐行 + 到 limit 就杀树。全量收集在这里是不能接受的,
 *   `rg --json` 在一个真工程上能吐几十 MB,而模型只要头 100 行。
 * - 上游没有超时;这里默认 60 s 并钳位,超时文本带"收窄 path / glob"的指引 —— 不带的话模型会原样重试。
 * - 输出路径一律相对会话 cwd:上游搜单个文件时退化成 basename(grep.ts:137-145),模型拿到的串
 *   喂不回 read,而它看不出为什么。
 *
 * 错误分类学:rg exit 0 = 有命中、1 = 没命中,两者都是正常结果;其余退出码(坏 glob、坏正则)才把
 * stderr 当错误抛 —— 只有 stderr 说得清"glob 写坏了"。到 limit 被我们杀掉的那一次退出码没有意义。
 */

import path from "node:path"
import { executionEnvSnapshot } from "../../domain/execution-env.ts"

import {
  type AgentHarnessTool,
  type Context,
  DEFAULT_MAX_BYTES,
  type ExecutionEnv,
  type ExecutionToolContext,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-agent-core"

import { clamp, engineBin, runEngineLines } from "../../domain/engines.ts"
import { fileKindFollowingLinks } from "../../domain/file-kind.ts"
import { insideGitRepo, matchesToolGlob, resolveToCwd } from "../../domain/paths.ts"
import { GREP_CONTRACT, type GrepDetails } from "./contract.ts"

const DEFAULT_MATCH_LIMIT = 100
/** 上下文行钳到 10:limit × context 是一次真实的内存峰值(每个匹配都要读一段文件)。 */
const MAX_CONTEXT_LINES = 10
const GREP_TIMEOUT_MS = 60 * 1000
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 10 * 60 * 1000

/** `rg --json` 的 match 事件里我们要的三格。文件名不是合法 UTF-8 时 path 是 {bytes},没有 text。 */
interface RgMatchEvent {
  type?: string
  data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } }
}

interface RgMatch {
  file: string
  line: number
  /** context=0 时直接用 rg 给的这一行,省一次文件读。 */
  text?: string
}

/** 输出路径:相对某个根 + 正斜杠。相对路径原样返回(rg 吃的是绝对路径,正常不会走到)。 */
export function toRelativePosix(from: string, target: string): string {
  const relative = path.isAbsolute(target) ? path.relative(from, target) : target
  return relative.split(path.sep).join("/") || "."
}

/** rg 给的行带着行尾换行;\r 一并剥掉,免得 Windows 文件的输出每行多一个看不见的字符。 */
function stripLineEnding(line: string): string {
  return line.replace(/\r?\n$/, "").replace(/\r/g, "")
}

/**
 * 取上下文要用的文件行,按文件缓存。
 *
 * 用 env.readTextLines({ maxLines }) 而不是整文件读(上游 grep.ts:147-160 是整文件 + 缓存):
 * 第 3 行的匹配不该把一个 200 MB 的日志读进内存。调用方先合并同一文件所需的最高行号,缓存让
 * 后续窗口复用这次有界读取。读不了就给空数组 —— 那只是少一段上下文,不该让整次搜索失败。
 */
async function readLinesUpTo(
  env: ExecutionEnv,
  context: Context,
  cache: Map<string, { maxLines: number; lines: string[] }>,
  file: string,
  needed: number,
): Promise<string[]> {
  const cached = cache.get(file)
  if (cached && cached.maxLines >= needed) return cached.lines
  const read = await env.readTextLines(file, { maxLines: needed }, context)
  const lines = read.ok ? read.value : []
  cache.set(file, { maxLines: needed, lines })
  return lines
}

export function createGrepTool(
  options: { enginesDir?: string } = {},
): AgentHarnessTool<ExecutionToolContext, typeof GREP_CONTRACT.parameters, GrepDetails> {
  return {
    name: GREP_CONTRACT.name,
    label: GREP_CONTRACT.label,
    description: GREP_CONTRACT.description,
    parameters: GREP_CONTRACT.parameters,
    execute: async (_toolCallId, params, _onUpdate, toolContext, _invocation, context) => {
      const env = toolContext.env
      const processEnv = executionEnvSnapshot(env)
      const cwd = env.cwd
      // 这一轮已经被用户停掉:不起子进程。runEngineLines 要到 spawn 之后才看信号。
      if (context.abortSignal?.aborted) throw new Error("grep was aborted")
      const searchPath = resolveToCwd(cwd, params.path ?? ".")
      // 跟随符号链接 / Windows junction:env.fileInfo 是 lstat 语义,链接到目录只答 "symlink",
      // 不跟随的话这里会退化成"搜单个文件"—— 丢 --no-require-git、glob 锚点也挪到会话 cwd。
      const kind = await fileKindFollowingLinks(env, searchPath, context)
      if (!kind.ok) throw new Error(`Path not found: ${searchPath}`)
      const searchingDirectory = kind.kind === "directory"
      // 缺席时 engineBin 自己抛带修复指引的错(重装 / npm run engines:build),比 ENOENT 有用得多。
      const rg = engineBin("rg", { enginesDir: options.enginesDir })

      const contextLines = clamp(params.context, 0, 0, MAX_CONTEXT_LINES)
      const limit = clamp(params.limit, DEFAULT_MATCH_LIMIT, 1, Number.MAX_SAFE_INTEGER)
      const timeoutMs = clamp(
        params.timeout === undefined ? undefined : params.timeout * 1000,
        GREP_TIMEOUT_MS,
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      )

      // 用户的 glob **不交给 rg**:rg 的 --glob 是 override 层,压在 .gitignore 之上(2026-09-12 实测
      // `--glob '*'` 把 node_modules/ 整个放回来)。rg 只带 `!.git/`(负 glob 不触发 override,只挡住
      // --hidden 放进来的 .git/),glob 在下面按 gitignore 语义挑。
      const args = ["--json", "--line-number", "--color=never", "--hidden", "--glob", "!.git/"]
      // 仓库外 rg 默认不读 .gitignore:解压的 SDK、没纳管的工程里 node_modules 会把 limit 吃满。
      if (searchingDirectory && !insideGitRepo(searchPath)) args.push("--no-require-git")
      if (params.ignoreCase) args.push("--ignore-case")
      if (params.literal) args.push("--fixed-strings")
      // `--` 之后才是 pattern:flag 形状的 pattern(`--pre=./x.sh`)必须当文本搜,不能当 rg 的参数。
      // 搜目录时 rg 在那个目录里跑、不带路径参数(rg 的相对路径与 glob 锚点都以它的 cwd 为准);
      // 搜单个文件时才把文件当参数。
      args.push("--", params.pattern)
      const rgCwd = searchingDirectory ? searchPath : cwd
      if (!searchingDirectory) args.push(searchPath)

      const matches: RgMatch[] = []
      let skippedNonUtf8 = 0
      let matchLimitReached = false
      let result: Awaited<ReturnType<typeof runEngineLines>>
      try {
        result = await runEngineLines(rg, args, {
          env: processEnv,
          cwd: rgCwd,
          signal: context.abortSignal,
          timeoutMs,
          onLine: (line) => {
            if (!line.startsWith("{")) return
            let event: RgMatchEvent
            try {
              event = JSON.parse(line) as RgMatchEvent
            } catch {
              return
            }
            if (event.type !== "match") return
            const lineNumber = event.data?.line_number
            if (typeof lineNumber !== "number") return
            const file = event.data?.path?.text
            if (file === undefined) {
              // 非 UTF-8 文件名:rg 给 {bytes: base64}。上游只读 .text,于是整行静默消失。
              skippedNonUtf8++
              return
            }
            // rg 给的路径相对它的 cwd;glob 按相对搜索根的正斜杠路径挑。
            const absolute = path.resolve(rgCwd, file)
            if (params.glob) {
              const relativeToRoot = path
                .relative(searchingDirectory ? searchPath : cwd, absolute)
                .split(path.sep)
                .join("/")
              if (!matchesToolGlob(relativeToRoot, params.glob)) return
            }
            matches.push({ file: absolute, line: lineNumber, text: event.data?.lines?.text })
            if (matches.length >= limit) {
              matchLimitReached = true
              return "stop"
            }
            return
          },
        })
      } catch (error) {
        throw new Error(`Failed to run ripgrep: ${error instanceof Error ? error.message : String(error)}`)
      }

      if (result.timedOut) {
        throw new Error(`grep timed out after ${Math.round(timeoutMs / 1000)}s — narrow path or glob, or raise timeout`)
      }
      if (result.aborted) throw new Error("grep was aborted")
      // exit 2 且一条命中都没有才算真错(坏正则)。一棵树里一个读不动的目录也会让 rg 退 2,而命中
      // 照样吐了出来 —— 那时丢掉全部命中换一句 "Permission denied" 等于 grep 在这台机器上永久不可用。
      const partial = !result.stopped && result.exitCode !== 0 && result.exitCode !== 1
      if (partial && matches.length === 0) {
        throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`)
      }

      const details: GrepDetails = {}
      const notices: string[] = []
      if (partial) {
        const firstError = result.stderr.trim().split("\n")[0] ?? ""
        notices.push(`partial results: ${firstError || `ripgrep exited with code ${result.exitCode}`}`)
        details.partial = true
      }
      if (matches.length === 0) {
        if (skippedNonUtf8 > 0) {
          details.skippedNonUtf8 = skippedNonUtf8
          return {
            content: [{ type: "text", text: `No matches found\n\n[${skippedNotice(skippedNonUtf8)}]` }],
            details,
          }
        }
        return { content: [{ type: "text", text: "No matches found" }], details }
      }

      let linesTruncated = false
      const outputLines: string[] = []
      const fileCache = new Map<string, { maxLines: number; lines: string[] }>()
      // 相邻命中的窗口会重叠。每个文件行只输出一次,但后面的命中不能被前面的
      // 上下文标成 '-'。先收齐命中行号,同时把同一文件的有界读取合成一次。
      const fileMatches = new Map<string, { hits: Set<number>; needed: number; emitted: Set<number> }>()
      for (const match of matches) {
        let file = fileMatches.get(match.file)
        if (!file) {
          file = { hits: new Set(), needed: 0, emitted: new Set() }
          fileMatches.set(match.file, file)
        }
        file.hits.add(match.line)
        file.needed = Math.max(file.needed, match.line + contextLines)
      }
      for (const match of matches) {
        const relative = toRelativePosix(cwd, match.file)
        if (contextLines === 0 && match.text !== undefined) {
          const line = truncateLine(stripLineEnding(match.text))
          if (line.wasTruncated) linesTruncated = true
          outputLines.push(`${relative}:${match.line}: ${line.text}`)
          continue
        }
        const file = fileMatches.get(match.file)!
        const lines = await readLinesUpTo(env, context, fileCache, match.file, file.needed)
        if (lines.length === 0) {
          outputLines.push(`${relative}:${match.line}: (unable to read file)`)
          continue
        }
        const start = Math.max(1, match.line - contextLines)
        const end = Math.min(lines.length, match.line + contextLines)
        for (let current = start; current <= end; current++) {
          if (file.emitted.has(current)) continue
          file.emitted.add(current)
          const line = truncateLine(stripLineEnding(lines[current - 1] ?? ""))
          if (line.wasTruncated) linesTruncated = true
          const prefix = file.hits.has(current) ? `${relative}:${current}: ` : `${relative}-${current}- `
          outputLines.push(`${prefix}${line.text}`)
        }
      }

      // 只卡字节:行数已经被 limit 管住了(一个匹配最多 2×context+1 行)。
      const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER })
      let output = truncation.content
      if (matchLimitReached) {
        notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`)
        details.matchLimitReached = limit
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
        // 逐格拷而不是整份塞:TruncationResult 里还有一份 content,那是同一段文本的第二份拷贝。
        details.truncation = {
          truncated: truncation.truncated,
          truncatedBy: truncation.truncatedBy,
          totalLines: truncation.totalLines,
          totalBytes: truncation.totalBytes,
          outputLines: truncation.outputLines,
          outputBytes: truncation.outputBytes,
        }
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`)
        details.linesTruncated = true
      }
      if (skippedNonUtf8 > 0) {
        notices.push(skippedNotice(skippedNonUtf8))
        details.skippedNonUtf8 = skippedNonUtf8
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`
      return { content: [{ type: "text", text: output }], details }
    },
  }
}

function skippedNotice(count: number): string {
  return `${count} match(es) skipped: those file names are not valid UTF-8`
}
