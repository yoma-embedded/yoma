/**
 * ls 工具的契约:菜单那一半。
 *
 * 四个文件工具里最便宜的一个 —— 它不起子进程、不碰发动机,厨房那半只是一次
 * `env.listDir`。但它在清单里的位置是承重的:find 走 `rg --files`,只出文件不出目录,
 * 于是"这个目录里有什么""那个目录在不在"这两问只有 ls 能答。description 里那句
 * "the only tool that reports directories" 不是客套,是把模型从"find 找不到就当不存在"
 * 那条岔路上拦下来。
 *
 * 门规同 flash(boundary.test.ts 第 3、5 条):界面只许走
 * `@yoma-desktop/kernel/tools/ls/contract`,而这个文件只许 import typebox 与工具目录内的
 * 相对路径。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

const lsParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: the session working directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
})

export type LsInput = Static<typeof lsParameters>

/**
 * 截断账单。为什么自己写一份而不是 import 内核的 TruncationResult:契约门只许 import typebox,
 * 而那个类型住在 `@earendil-works/pi-agent-core` —— Node 侧的包一旦被契约牵进来,餐厅就打不开了
 * (boundary.test.ts 第 5 条机器执行)。字段是 TruncationResult 的子集,所以 session.ts 可以
 * 直接把真账单赋过来;**故意少了 content** —— details 跨进程后原样成为卡片 metadata,再带一份
 * 正文等于把输出传两遍。
 */
export interface OutputTruncation {
  truncated: boolean
  truncatedBy: "lines" | "bytes" | null
  totalLines: number
  totalBytes: number
  outputLines: number
  outputBytes: number
}

export interface LsDetails {
  truncation?: OutputTruncation
  /** 到顶时记的是那个 limit 值本身(不是被丢掉的条数):卡片和尾部通知据此劝模型翻倍重试。 */
  entryLimitReached?: number
}

const LS_DESCRIPTION = `List the contents of one directory. Entries are sorted alphabetically (case-insensitive) with a '/' suffix for directories; dotfiles are included. Output is truncated to 500 entries or 50KB (whichever is hit first).

- This is the only tool that reports directories: find matches files, so "where is that directory" is an ls question, not a find question.
- One level only, never recursive. Use find with a glob to walk the tree, grep to search file contents.
- Symlinks are listed by name with no suffix and are not followed — a link pointing at a directory looks like a plain entry.`

export const LS_CONTRACT = {
  name: "ls",
  label: "列目录",
  description: LS_DESCRIPTION,
  parameters: lsParameters,
  guidelines: [],
  summary: lsSummary,
} as const satisfies ToolContract<typeof lsParameters>

/** 卡片副标题:列的是哪个目录。参数可能还在流式拼,path 缺席就是会话 cwd。 */
export function lsSummary(input: Partial<LsInput>): string {
  return input.path?.trim() || "."
}
