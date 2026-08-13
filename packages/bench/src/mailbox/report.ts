/**
 * 信箱闭环的终报 —— 与 verdict 同一次提交写进信箱根部。
 *
 * 读者是那个"本来要自己调这个 bug"的人,顺序:结论 → 过程 → 证据在哪 → 怎么复核。
 * 重点是**决策链**(每轮谁指挥、裁决是谁做的),不是单轮细节 —— 细节在轮次目录
 * 和会话回放里。
 */

import type { MailboxJob } from "./spec.ts"
import type { MailboxVerdict, RoundDecision, RoundFiles } from "./store.ts"
import { quote } from "./text.ts"

const OUTCOME_LABEL: Record<MailboxVerdict["outcome"], string> = {
  passed: "✅ 研发端判定已解决",
  failed: "❌ 未解决",
}

/**
 * 穷举 Record —— 决定种类多一个,这里就编译报错。
 * `await-human` 会出现在中间轮次里(它不是终局),读决策链的人要一眼看出
 * "这一轮没往前走,是在等人"。
 */
const DECISION_LABEL: Record<RoundDecision["decision"], string> = {
  continue: "continue",
  done: "done",
  fail: "fail",
  "await-human": "await-human(等人)",
}

export interface MailboxReportInput {
  mailboxJob: MailboxJob
  verdict: MailboxVerdict
  rounds: RoundFiles[]
  sessionsRoot?: string
}

export function renderMailboxReport(input: MailboxReportInput): string {
  const job = input.mailboxJob.job
  const { verdict, rounds } = input
  const sections: string[] = []

  sections.push(`# 信箱闭环报告:${job.title}

**结论:${OUTCOME_LABEL[verdict.outcome]}** —— ${verdict.reason}

| | |
|---|---|
| 任务 | \`${job.id}\` |
| 轮次 | ${verdict.rounds} |
| 终局裁决 | ${verdict.decidedBy === "policy" ? "预算守卫(代码)" : "研发端"} |
| 用量 | 工位端 ${verdict.totalRunnerTokens.toLocaleString()} tokens · 研发端 ${verdict.totalMotherTokens.toLocaleString()} tokens |
| 板卡 | ${job.bench.board ?? "—"}${job.bench.chip ? ` (${job.bench.chip})` : ""} |`)

  sections.push(renderRounds(rounds))
  sections.push(renderLastWords(rounds))
  sections.push(renderReplay(input))

  return sections.filter(Boolean).join("\n\n") + "\n"
}

function renderRounds(rounds: RoundFiles[]): string {
  const lines = [
    "## 决策链(每轮:研发端给了什么 → 工位端跑出什么 → 谁裁决了什么)",
    "",
    "| 轮 | 附件 | 工位端 | 回传 | 研发端改动 | 裁决 |",
    "|---|---|---|---|---|---|",
  ]
  for (const round of rounds) {
    const bench = round.result?.error
      ? `⚠ ${clip(round.result.error, 60)}`
      : round.result?.turn?.stopReason
        ? `⚠ ${clip(round.result.turn.stopReason, 60)}`
        : round.result
          ? "已回填"
          : "—"
    // 回传件与"没送成"分开记:后者是**研发端没看到的东西**,复核的人必须知道。
    const back = [
      round.result?.back?.length ? `${round.result.back.length} 件` : "",
      round.result?.backSkipped?.length ? `⚠ ${round.result.backSkipped.length} 件没送成` : "",
      round.humanAck ? (round.humanAck.answer === "done" ? "人已照做" : "人做不了") : "",
    ]
      .filter(Boolean)
      .join("<br>")
    // 改动记在**裁决**上:研发端是在裁决那一步动的代码,产出随下一轮指令发出去。
    const changed = round.decision?.git?.changedFiles.length ?? 0
    const decision = round.decision
      ? `${DECISION_LABEL[round.decision.decision]}(${round.decision.by === "policy" ? "守卫" : "研发端"})`
      : "—"
    const artifacts = round.instruction?.artifacts?.length
      ? round.instruction.artifacts.map((item) => `\`${item.name}\``).join("<br>")
      : "—"
    lines.push(
      `| ${round.round} | ${artifacts} | ${bench} | ${back || "—"} | ${changed ? `${changed} 个文件` : "无"} | ${decision} |`,
    )
  }
  return lines.join("\n")
}

/** 最后一轮的两份自述:工位端与研发端,都明确标注"是它说的"。 */
function renderLastWords(rounds: RoundFiles[]): string {
  const last = rounds[rounds.length - 1]
  if (!last) return ""
  const sections: string[] = []
  if (last.result?.turn?.text) {
    sections.push(`## 工位端的最后自述(未经独立验证)\n\n${quote(clip(last.result.turn.text, 2000))}`)
  }
  const analysed = [...rounds].reverse().find((round) => round.decision?.analysis)
  if (analysed?.decision?.analysis) {
    sections.push(`## 研发端的最后分析(未经独立验证)\n\n${quote(clip(analysed.decision.analysis, 1500))}`)
  }
  return sections.join("\n\n")
}

function renderReplay(input: MailboxReportInput): string {
  const lines = [
    "## 怎么复核",
    "",
    "1. 看轮次目录:`rounds/NNN/` 里有每轮的指令、结果、补丁与裁决;",
    "2. 结论出自研发端对工位端自述的判断 —— 两边的原话都在下面,要复核就照着复现一遍;",
  ]
  const sessions = new Set<string>()
  for (const round of input.rounds) {
    if (round.result?.sessionID) sessions.add(round.result.sessionID)
    if (round.decision?.motherSessionID) sessions.add(round.decision.motherSessionID)
  }
  if (sessions.size) {
    lines.push(`3. 在 Yoma Desktop 里回放会话:${[...sessions].map((id) => `\`${id}\``).join("、")}(两侧的完整过程都在)。`)
  }
  if (input.sessionsRoot) lines.push("", `会话文件:\`${input.sessionsRoot}\``)
  return lines.join("\n")
}

// 截断标记**不带换行**:一半调用点在 markdown 表格单元格里,换行会把表格劈开。
// (prompts.ts 那份带换行,它进的是提示词正文,不是表格。)
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…(截断)`
}
