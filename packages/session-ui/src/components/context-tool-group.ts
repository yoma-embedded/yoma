import type { Part, ToolPart } from "@yoma-desktop/kernel"

/**
 * 只读的「找东西」四件。一轮里它们常常一连十几次,逐张摆开会把真正要看的那几张(烧录、调试器、示波器)
 * 挤到屏幕外,所以连着出现时在时间线上并成一行(`message-part` 的 `groupParts`),展开才是逐张卡片。
 * 会动硬件、会改文件的工具一律不进这个清单 —— 它们每一次都该让人看见。
 */
export const CONTEXT_GROUP_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"])

export function isContextGroupTool(part: Part): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

export type ContextToolSummary = {
  read: number
  search: number
  list: number
  /** 折叠着也得看得见:一次 read 报错(文件不存在)往往就是模型接下来走偏的原因。 */
  failed: number
  /** 还有没跑完的(参数没拼完或正在跑)。 */
  active: boolean
}

export function contextToolSummary(parts: readonly ToolPart[]): ContextToolSummary {
  const summary: ContextToolSummary = { read: 0, search: 0, list: 0, failed: 0, active: false }
  for (const part of parts) {
    if (part.tool === "read") summary.read += 1
    if (part.tool === "grep" || part.tool === "find") summary.search += 1
    if (part.tool === "ls") summary.list += 1
    if (part.state.status === "error") summary.failed += 1
    if (part.state.status === "pending" || part.state.status === "running") summary.active = true
  }
  return summary
}
