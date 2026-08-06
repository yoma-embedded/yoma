/**
 * 测试报告 —— 给研发看的东西。
 *
 * 报告的读者是那个"本来要自己调这个 bug"的人。他要在两分钟内判断:
 * **能不能信、要不要合**。所以顺序是固定的:
 *
 *   结论 → 改了什么 → 为什么(根因)→ 证据链 → 过程与代价 → 怎么复核
 *
 * 一条纪律:**证据必须是 runner 自己跑出来的**。agent 的自述放在"过程"里,
 * 且明确标注是它自己说的。判据结果、diff、决策日志三样才是可采信的部分 ——
 * 报告的结构本身要把这个区别摆出来,而不是让读者自己去分辨。
 */

import type { CheckResult, GradeResult } from "./grader.ts"
import type { Iteration, RunnerResult } from "./runner.ts"

export interface ReportInput {
  result: RunnerResult
  /** 相对基线的改动统计。 */
  diffStat?: string
  changedFiles?: string[]
  commits?: string[]
  branch?: string
  baseCommit?: string
  /** 会话 JSONL 的位置,研发可以在 desktop 里回放。 */
  sessionsRoot?: string
  generatedAt?: number
}

const OUTCOME_LABEL: Record<RunnerResult["outcome"], string> = {
  passed: "✅ 判据全部通过",
  failed: "❌ 未能通过判据",
  parked: "⏸️ 已挂起,需要人介入",
  error: "💥 执行出错",
}

export function renderReport(input: ReportInput): string {
  const { result } = input
  const job = result.job
  const sections: string[] = []

  sections.push(`# 调试报告:${job.title}

**结论:${OUTCOME_LABEL[result.outcome]}** —— ${result.reason}

| | |
|---|---|
| 任务 | \`${job.id}\` |
| 分支 | \`${input.branch ?? job.repo.branch ?? "(未开分支)"}\` |
| 板卡 | ${job.bench.board ?? "—"}${job.bench.chip ? ` (${job.bench.chip})` : ""} |
| 迭代 | ${result.iterations.length} / ${job.budget.maxIterations} 轮 |
| 用量 | ${result.totalTokens.toLocaleString()} tokens${result.totalCost ? ` · $${result.totalCost.toFixed(4)}` : ""} |
| 耗时 | ${formatDuration(result.elapsedMs)} |
| 权限策略 | \`${job.policy}\` |
${result.restored !== undefined ? `| 回刷 known-good | ${result.restored ? "已回刷" : "**回刷失败,板子状态未知**"} |\n` : ""}`)

  sections.push(renderChanges(input))
  sections.push(renderRootCause(result))
  sections.push(renderEvidence(result))
  sections.push(renderPermissions(result))
  sections.push(renderProcess(result))
  sections.push(renderReplay(input))

  return sections.filter(Boolean).join("\n\n") + "\n"
}

function renderChanges(input: ReportInput): string {
  const lines = ["## 改了什么"]
  if (!input.diffStat && !input.changedFiles?.length) {
    lines.push("\n(没有代码改动 —— 这一轮只做了观测。)")
    return lines.join("\n")
  }
  if (input.changedFiles?.length) {
    lines.push("")
    for (const file of input.changedFiles) lines.push(`- \`${file}\``)
  }
  if (input.diffStat) lines.push(`\n\`\`\`\n${input.diffStat}\n\`\`\``)
  if (input.commits?.length) {
    lines.push("\n提交(每一条都是判据绿过的状态):\n")
    for (const commit of input.commits) lines.push(`- \`${commit}\``)
  }
  return lines.join("\n")
}

/** 根因取最后一轮 agent 的自述 —— 明确标注是它说的,不是验证过的。 */
function renderRootCause(result: RunnerResult): string {
  const last = result.iterations[result.iterations.length - 1]
  if (!last?.turn.text) return ""
  return `## 根因分析(agent 自述,未经独立验证)

${quote(clip(last.turn.text, 2000))}`
}

function renderEvidence(result: RunnerResult): string {
  const last = result.iterations[result.iterations.length - 1]
  if (!last?.grade) return ""
  const lines = ["## 证据:判据执行结果", "", "> 以下全部由调试台独立执行,不经模型。", ""]
  const grade = last.grade
  if (grade.build) lines.push(renderCheck(grade.build))
  for (const check of grade.checks) lines.push(renderCheck(check))
  return lines.join("\n")
}

function renderCheck(check: CheckResult): string {
  const icon = { pass: "✅", fail: "❌", error: "⚠️", skip: "⏭️" }[check.outcome]
  const head = `### ${icon} ${check.summary}`
  if (!check.evidence) return `${head}\n`
  return `${head}\n\n\`\`\`\n${clip(check.evidence, 2500)}\n\`\`\`\n`
}

function renderPermissions(result: RunnerResult): string {
  if (!result.decisions.length) return ""
  const denied = result.decisions.filter((decision) => decision.verdict === "deny")
  const byHuman = result.decisions.filter((decision) => decision.by === "human")
  const lines = [
    "## 权限与审计",
    "",
    `共 ${result.decisions.length} 次工具裁决:自动放行 ${result.decisions.length - denied.length - byHuman.length} 次` +
      `,人工裁决 ${byHuman.length} 次,拒绝 ${denied.length} 次。完整记录见 \`.bench/decisions.jsonl\`。`,
  ]
  if (denied.length) {
    lines.push("", "被拒绝的动作:", "")
    for (const decision of denied.slice(0, 20)) {
      lines.push(`- \`${decision.tool}\` ${decision.title} —— ${decision.rule ?? decision.by}`)
    }
  }
  return lines.join("\n")
}

function renderProcess(result: RunnerResult): string {
  const lines = ["## 过程", "", "| 轮 | 工具调用 | 判据 | 耗时 |", "|---|---|---|---|"]
  for (const iteration of result.iterations) {
    lines.push(
      `| ${iteration.index} | ${describeTools(iteration)} | ${describeGrade(iteration.grade)} | ${formatDuration(iteration.turn.elapsedMs)} |`,
    )
  }
  const errors = result.iterations.flatMap((iteration) => iteration.turn.errors)
  if (errors.length) {
    lines.push("", "过程中的错误:", "")
    for (const error of [...new Set(errors)].slice(0, 10)) lines.push(`- ${error}`)
  }
  return lines.join("\n")
}

function describeTools(iteration: Iteration): string {
  if (!iteration.turn.toolCalls.length) return "—"
  const counts = new Map<string, number>()
  for (const call of iteration.turn.toolCalls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1)
  return [...counts]
    .map(([tool, count]) => (count > 1 ? `${tool}×${count}` : tool))
    .join(" ")
}

function describeGrade(grade?: GradeResult): string {
  if (!grade) return "—"
  if (grade.passed) return "✅ 全过"
  const failed = [grade.build, ...grade.checks].filter((check) => check && check.outcome === "fail").length
  const errored = [grade.build, ...grade.checks].filter((check) => check && check.outcome === "error").length
  return [failed ? `❌ ${failed} 项未过` : "", errored ? `⚠️ ${errored} 项没跑成` : ""].filter(Boolean).join(" ")
}

function renderReplay(input: ReportInput): string {
  const lines = ["## 怎么复核", "", "1. 看上面的 diff 和证据;"]
  if (input.result.sessionID) {
    lines.push(
      `2. 在 Yoma Desktop 里打开会话 \`${input.result.sessionID}\` 回放完整过程(每一次工具调用、每一条日志都在里面);`,
    )
  }
  lines.push(
    `${input.result.sessionID ? "3" : "2"}. 判据可以自己复跑:\`yoma-bench grade <job.json>\`(只跑判据,不动代码)。`,
  )
  if (input.sessionsRoot) lines.push("", `会话文件:\`${input.sessionsRoot}\``)
  return lines.join("\n")
}

/** MR 标题:一眼看出结论和任务。 */
export function mrTitle(result: RunnerResult): string {
  const prefix = result.outcome === "passed" ? "" : "[未通过] "
  return `${prefix}${result.job.title} (agent ${result.job.id})`
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(截断)`
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${seconds % 60}s`
}
