/**
 * `tool-called` —— 判路径,所以**慎用**。
 *
 * 文章里说得很直白:判路径会冤枉合法解法。只有当"用这个工具"本身就是题面要求的产出
 * 时才该用它(比如"请用 netlist 工具的 part 模式核对一遍"),而不是用来表达
 * "我觉得它应该先看网表"。
 */

import type { Grader, GraderContext, GraderVerdict, ToolCalledGraderSpec } from "./types.ts"
import { str } from "./types.ts"

export function validateToolCalledSpec(
  raw: Record<string, unknown>,
  fieldPath: string,
  issues: string[],
): ToolCalledGraderSpec {
  const tool = str(raw.tool)
  if (!tool) issues.push(`${fieldPath}.tool 必填(工具名,如 netlist)`)
  const spec: ToolCalledGraderSpec = { type: "tool-called", tool: tool ?? "" }
  if (raw.minCount !== undefined) {
    if (typeof raw.minCount !== "number" || !Number.isInteger(raw.minCount) || raw.minCount < 1) {
      issues.push(`${fieldPath}.minCount 必须是 >= 1 的整数`)
    } else spec.minCount = raw.minCount
  }
  const status = str(raw.status)
  if (raw.status !== undefined && !status) issues.push(`${fieldPath}.status 必须是非空字符串(completed / error)`)
  spec.status = status
  return spec
}

export function createToolCalledGrader(spec: ToolCalledGraderSpec): Grader {
  const minCount = spec.minCount ?? 1
  return {
    type: "tool-called",
    grade(context: GraderContext): GraderVerdict {
      const matched = context.transcript.toolCalls.filter(
        (call) => call.name === spec.tool && (!spec.status || call.status === spec.status),
      )
      const qualifier = spec.status ? `(${spec.status})` : ""
      if (matched.length >= minCount) {
        return { type: "tool-called", pass: true, detail: `${spec.tool}${qualifier} 调了 ${matched.length} 次` }
      }
      const used = [...new Set(context.transcript.toolCalls.map((call) => call.name))]
      return {
        type: "tool-called",
        pass: false,
        detail: `${spec.tool}${qualifier} 只调了 ${matched.length} 次(要求 ≥ ${minCount});本轮用过:${used.join(", ") || "(没调过任何工具)"}`,
      }
    },
  }
}
