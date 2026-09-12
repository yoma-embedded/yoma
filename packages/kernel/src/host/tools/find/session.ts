/**
 * find 工具的厨房那一半:自带 ripgrep 的文件查找。
 *
 * 2026-09-12 从 pi 的 core/tools/find.ts 移回来,引擎从 fd 换成 `rg --files` —— yoma 不打包 fd,
 * 而 rg 已经因为 grep 躺在 engines/bin 里了。换引擎的账:
 * - glob / 隐藏文件:rg 一一对得上(它的 glob 就是 gitignore 语义),所以上游为 fd 打的两个补丁
 *   (给含斜杠的 pattern 前置两个星号加斜杠、Windows 上把斜杠换成 `[/\\]`)整段删掉 —— 那是 fd
 *   `--full-path` 的脾气,rg 不需要,留着反而会把 `src/<两个星号>/x.spec.ts` 这类 pattern 匹歪。
 * - .gitignore:**用户的 glob 不交给 rg**。rg 的 `--glob` 属于 override 层,压在 ignore 之上 ——
 *   2026-09-12 实测 `--glob '*'` 会把 node_modules/ 与 *.log 整个放回来,连被忽略的目录都进。所以
 *   rg 只带一条 `!.git/`(负 glob 不触发 override),负责"尊重 .gitignore 地列文件";pattern 在
 *   JS 侧按 gitignore 语义挑(domain/paths.ts 的 matchesToolGlob)。
 * - 锚定:rg 的相对路径与 glob 锚点都以它的 cwd 为准,给它绝对路径参数时 `src/**` 一个都匹不到
 *   (实测)。所以 rg 在搜索根里跑、不带路径参数,结果再换算成相对会话 cwd。
 * - limit:rg 没有 --max-results,数到 limit 在 JS 侧杀进程(runEngineLines 的 onLine 返回 "stop")。
 * - 顺序:rg --files 是并行无序的,要稳定输出得 --sort path(代价是单线程;这个工具本来就受 limit 约束)。
 * - **目录:出不来**。rg --files 只出文件,上游的 fd 会把目录也当结果。这是真实能力缺口,写在
 *   description 与 guidelines 里("要看目录用 ls"),否则模型问"某个目录在哪"会拿到 "No files found"。
 *
 * 其余与 grep 同一条纪律:engineBin 的绝对路径(内核进程的 PATH 上没有 rg)、runEngineLines 的
 * 杀树与有界结算、默认 60 s 超时(上游没有超时)、输出相对会话 cwd 且统一正斜杠。
 */

import path from "node:path"

import {
  type AgentHarnessTool,
  DEFAULT_MAX_BYTES,
  type ExecutionToolContext,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-agent-core"

import { clamp, engineBin, runEngineLines } from "../../domain/engines.ts"
import { insideGitRepo, matchesToolGlob, resolveToCwd } from "../../domain/paths.ts"
import { FIND_CONTRACT, type FindDetails } from "./contract.ts"

const DEFAULT_RESULT_LIMIT = 1000
const FIND_TIMEOUT_MS = 60 * 1000
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 一行结果相对基准目录 + 统一正斜杠。
 *
 * pathModule 可注入是为了在 macOS 上真跑 Windows 分支。两个坑都是 issue #6104 踩出来的,别按
 * "searchPath.length + 1" 切字符串:盘根 `I:\` 与 POSIX `/` 自带尾分隔符,那样切会吃掉第一段的
 * 第一个字符;同名前缀的兄弟目录(`Models` vs `Models2`)会被误判成子目录。
 *
 * 尾斜杠那一支今天走不到(rg --files 只出文件),留着是因为它不要钱,而"结果带尾斜杠就是目录"
 * 这个约定一旦被破坏,输出里会多出一个看不出来的 `//`。
 */
export function relativizeFindResultPath(
  resultPath: string,
  base: string,
  pathModule: path.PlatformPath = path,
): string {
  const hadTrailingSeparator =
    resultPath.endsWith(pathModule.sep) || (pathModule.sep === "\\" && resultPath.endsWith("/"))
  const relativePath = pathModule.isAbsolute(resultPath) ? pathModule.relative(base, resultPath) : resultPath
  const posixPath = relativePath.split(pathModule.sep).join("/")
  return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath
}

export function createFindTool(
  options: { enginesDir?: string } = {},
): AgentHarnessTool<ExecutionToolContext, typeof FIND_CONTRACT.parameters, FindDetails> {
  return {
    name: FIND_CONTRACT.name,
    label: FIND_CONTRACT.label,
    description: FIND_CONTRACT.description,
    parameters: FIND_CONTRACT.parameters,
    execute: async (_toolCallId, params, _onUpdate, toolContext, _invocation, context) => {
      const env = toolContext.env
      const cwd = env.cwd
      // 这一轮已经被用户停掉:不起子进程。runEngineLines 要到 spawn 之后才看信号。
      if (context.abortSignal?.aborted) throw new Error("find was aborted")
      // rg 的 glob 里 `!` 开头是排除、`/` 开头锚定搜索根:模型写 '!foo' 会拿到"除 foo 以外全部",写
      // '/src/*.c' 会静默零结果。两种都不是它想要的,当场说清比猜着跑强。
      if (params.pattern.startsWith("!")) {
        throw new Error("find: pattern must not start with '!' (that would exclude files); give the glob to match")
      }
      if (params.pattern.startsWith("/")) {
        throw new Error("find: pattern must be relative; put the directory in path and a relative glob in pattern")
      }
      const searchPath = resolveToCwd(cwd, params.path ?? ".")
      const info = await env.fileInfo(searchPath, context)
      if (!info.ok) throw new Error(`Path not found: ${searchPath}`)
      // rg 以搜索根为 cwd 跑,给它一个文件会 spawn 同步抛 ENOTDIR,报出来像 rg 坏了。
      if (info.value.kind !== "directory") {
        throw new Error(`find: path must be a directory (got a file) — use grep to search inside one file`)
      }
      const rg = engineBin("rg", { enginesDir: options.enginesDir })

      const limit = clamp(params.limit, DEFAULT_RESULT_LIMIT, 1, Number.MAX_SAFE_INTEGER)
      const timeoutMs = clamp(
        params.timeout === undefined ? undefined : params.timeout * 1000,
        FIND_TIMEOUT_MS,
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      )

      // --hidden 会把 .git/ 也列出来,`!.git/` 挡住它;负 glob 不会像正 glob 那样压掉 .gitignore。
      const args = ["--files", "--color=never", "--hidden", "--sort", "path", "--glob", "!.git/"]
      if (!insideGitRepo(searchPath)) args.push("--no-require-git")

      const found: string[] = []
      let resultLimitReached = false
      let result: Awaited<ReturnType<typeof runEngineLines>>
      try {
        result = await runEngineLines(rg, args, {
          cwd: searchPath,
          signal: context.abortSignal,
          timeoutMs,
          onLine: (line) => {
            const trimmed = line.trim()
            if (!trimmed) return
            // rg 给的是相对搜索根的路径(Windows 上带反斜杠):先按 gitignore 语义挑,再换算成相对会话 cwd。
            const relativeToRoot = trimmed.split(path.sep).join("/")
            if (!matchesToolGlob(relativeToRoot, params.pattern)) return
            found.push(relativizeFindResultPath(path.resolve(searchPath, trimmed), cwd))
            if (found.length >= limit) {
              resultLimitReached = true
              return "stop"
            }
            return
          },
        })
      } catch (error) {
        throw new Error(`Failed to run ripgrep: ${error instanceof Error ? error.message : String(error)}`)
      }

      if (result.timedOut) {
        throw new Error(
          `find timed out after ${Math.round(timeoutMs / 1000)}s — narrow path or pattern, or raise timeout`,
        )
      }
      if (result.aborted) throw new Error("find was aborted")
      // rg: 0 = 有命中,1 = 没命中(两者都正常),其余是真错(搜索根读不了之类)。已经拿到行时不报错 ——
      // 半份结果比一条 "exited with code 2" 有用,而被我们杀掉的那一次退出码没有意义。
      if (!result.stopped && result.exitCode !== 0 && result.exitCode !== 1 && found.length === 0) {
        throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`)
      }
      if (found.length === 0) {
        return { content: [{ type: "text", text: "No files found matching pattern" }], details: {} }
      }

      // 只卡字节:行数已经被 limit 管住了。
      const truncation = truncateHead(found.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER })
      let output = truncation.content
      const details: FindDetails = {}
      const notices: string[] = []
      if (resultLimitReached) {
        notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`)
        details.resultLimitReached = limit
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
        // 逐格拷:TruncationResult 里还带着一份 content,那是同一段文本的第二份拷贝。
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
      return { content: [{ type: "text", text: output }], details }
    },
  }
}
