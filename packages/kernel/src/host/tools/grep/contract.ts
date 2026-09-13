/**
 * grep 工具的契约:菜单那一半(门规与 flash 的 contract.ts 同注,不重抄)。
 *
 * 这个工具是 2026-09-12 从 pi 的 coding-agent 移回来的四个之一(powershell / grep / find / ls)。
 * 与上游的两处实质差别写在 description 里,因为模型的行为直接吃它:
 * - 路径相对会话 cwd(上游搜单个文件时退化成 basename,模型拿到的串喂不回 read);
 * - 永不进 .git/(上游的 --hidden 会把几千个对象文件搜进来,正好吃满 limit)。
 *
 * 截断的三个数字(100 匹配 / 50KB / 500 字符)在这里是**字面量**:契约门不许 import
 * `@earendil-works/pi-agent-core`(那是 Node 侧依赖,会让浏览器包打不开),所以真值住在
 * session.ts 里,这份说明书只是抄一遍给模型看。改一边要改两边。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

const grepParameters = Type.Object({
  pattern: Type.String({ description: "Search pattern. A regex by default, a literal string when literal=true." }),
  path: Type.Optional(
    Type.String({ description: "File or directory to search (default: the session working directory)." }),
  ),
  glob: Type.Optional(
    Type.String({ description: "Only search files matching this glob, e.g. '*.c' or 'src/**/*.spec.ts'." }),
  ),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)." })),
  literal: Type.Optional(
    Type.Boolean({ description: "Treat pattern as a literal string instead of a regex (default: false)." }),
  ),
  context: Type.Optional(
    Type.Number({ description: "Lines of context before and after each match (default 0, clamped to 0-10)." }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of matches (default 100). The search stops once the limit is hit." }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Seconds before the search is killed (default 60, clamped to 1-600)." }),
  ),
})

export type GrepInput = Static<typeof grepParameters>

/**
 * 内核 truncateHead 结果里能 JSON 往返、卡片又真用得上的那几格。
 *
 * 故意**不含 content**:那是输出正文本身,已经在工具结果的 content[] 里了;连着 details 再塞
 * 一份等于跨进程把同一段文本传两遍(50KB 的输出变 100KB)。
 */
export interface GrepTruncation {
  truncated: boolean
  truncatedBy: "lines" | "bytes" | null
  totalLines: number
  totalBytes: number
  outputLines: number
  outputBytes: number
}

export interface GrepDetails {
  truncation?: GrepTruncation
  /** 到顶的那个 limit 值(不是匹配总数 —— 被杀掉的 rg 并不知道总数)。 */
  matchLimitReached?: number
  linesTruncated?: boolean
  /** 文件名不是合法 UTF-8、因此被丢掉的匹配数:静默丢会让模型以为那些文件没命中。 */
  skippedNonUtf8?: number
  /** rg 中途报过错(某个目录读不动之类)但仍有命中:结果不全,尾部通知带着第一条报错。 */
  partial?: boolean
}

const GREP_DESCRIPTION = `Search file contents for a pattern using the bundled ripgrep. Returns matching lines as \`<path>:<line>: <text>\`; context lines use \`<path>-<line>- <text>\`.

- Paths are relative to the session working directory, so any result can be passed straight to the read tool.
- Respects .gitignore, searches hidden files, and never descends into .git/. glob narrows the search within what .gitignore allows (without a "/" it matches file names at any depth, with a "/" it is anchored at path, a trailing "/" means everything under that directory); matching is case-insensitive and wildcards match dotfiles.
- Output is capped at 100 matches (raise with limit) and 50KB, whichever comes first. Single lines longer than 500 chars are cut with "... [truncated]" — use read for the full line.
- Prefer this over running grep or rg through bash: the search is killed as soon as the match limit is reached instead of streaming a whole repository into the conversation.
- pattern never reaches a shell, so a flag-shaped pattern such as "--pre=./x.sh" is searched as literal text.
- The search is killed after 60 seconds (raise with timeout). On a timeout, narrow path or glob instead of repeating the same call.`

export const GREP_CONTRACT = {
  name: "grep",
  label: "搜索",
  description: GREP_DESCRIPTION,
  parameters: grepParameters,
  guidelines: [
    "Search file contents with the grep tool instead of piping bash through grep/rg — it respects .gitignore, skips .git/, and caps its own output.",
    "When grep reports the match limit, narrow pattern, glob or path before raising limit.",
  ],
  summary: grepSummary,
} as const satisfies ToolContract<typeof grepParameters>

/** 卡片副标题:pattern,后面带上 glob(那是"搜了哪一片"唯一看得见的线索)。 */
export function grepSummary(input: Partial<GrepInput>): string {
  const pattern = input.pattern ?? ""
  if (!pattern) return ""
  return input.glob ? `${pattern} in ${input.glob}` : pattern
}
