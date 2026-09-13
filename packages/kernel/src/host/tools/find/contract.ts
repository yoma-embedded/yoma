/**
 * find 工具的契约:菜单那一半(门规与 flash 的 contract.ts 同注,不重抄)。
 *
 * 2026-09-12 从 pi 移回来时换了引擎:上游用 fd,yoma 不打包 fd,改 `rg --files`。能力账在
 * session.ts 的头注释里,只有一条会咬模型,所以 description 与 guidelines 里各写一遍:
 * **只出文件,不出目录** —— 上游的 fd 会把目录也作为结果,"某个目录在哪"这类用法换成 rg 之后
 * 会静默变成 "No files found"。要看目录结构用 ls。
 *
 * 1000 结果 / 50KB 是字面量:契约门不许 import `@earendil-works/pi-agent-core`(Node 侧依赖),
 * 真值住在 session.ts。改一边要改两边。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

const findParameters = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'.",
  }),
  path: Type.Optional(
    Type.String({ description: "Directory to search in (default: the session working directory)." }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of results (default 1000). The search stops once the limit is hit." }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Seconds before the search is killed (default 60, clamped to 1-600)." }),
  ),
})

export type FindInput = Static<typeof findParameters>

/** 与 grep 那份同义、同样不含 content(见 grep/contract.ts 的注释);两个工具各留一份,契约之间不互相 import。 */
export interface FindTruncation {
  truncated: boolean
  truncatedBy: "lines" | "bytes" | null
  totalLines: number
  totalBytes: number
  outputLines: number
  outputBytes: number
}

export interface FindDetails {
  truncation?: FindTruncation
  /** 到顶的那个 limit 值(不是命中总数 —— 被杀掉的 rg 并不知道总数)。 */
  resultLimitReached?: number
  /** rg 中途报过错(某个目录读不动)但仍列出了文件:清单不全,尾部通知带着第一条报错。 */
  partial?: boolean
}

const FIND_DESCRIPTION = `Find files by glob pattern using the bundled ripgrep. Returns one path per line, sorted, relative to the session working directory, so any result can be passed straight to the read tool.

- Only files are returned, never directories. To look at directory structure, use the ls tool.
- Lists hidden files, never descends into .git/, and respects .gitignore (build/, node_modules/, *.log stay out even when pattern would match them).
- pattern follows gitignore glob rules: without a "/" it matches the file name at any depth ('*.c' finds src/main.c), with a "/" it is anchored at the search root ('src/**/*.spec.ts'); "**" crosses directories; a trailing "/" means everything under that directory ('Core/Src/'). Matching is case-insensitive and wildcards match dotfiles ('*.cproject' finds .cproject).
- Output is capped at 1000 results (raise with limit) and 50KB, whichever comes first.
- The search is killed after 60 seconds (raise with timeout). On a timeout, narrow path or pattern instead of repeating the same call.`

export const FIND_CONTRACT = {
  name: "find",
  label: "找文件",
  description: FIND_DESCRIPTION,
  parameters: findParameters,
  guidelines: [
    "Locate files with the find tool instead of shelling out to bash — it respects .gitignore, skips .git/, and caps its own output.",
    "find only returns files; use ls to inspect directories.",
  ],
  summary: findSummary,
} as const satisfies ToolContract<typeof findParameters>

/** 卡片副标题就是 pattern:path 多半是缺省的 cwd,写上去只会挤掉真正要看的那半行。 */
export function findSummary(input: Partial<FindInput>): string {
  return input.pattern ?? ""
}
