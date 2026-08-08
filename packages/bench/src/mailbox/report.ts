/**
 * 信箱闭环的终报 —— 与 verdict 同一次提交写进信箱根部。
 *
 * 读者还是那个"本来要自己调这个 bug"的人,顺序不变:结论 → 过程 → 证据在哪 → 怎么复核。
 * 与单机报告的差别:多了"每轮谁指挥、裁决是谁做的"这一层 —— 信箱模式的审计重点
 * 恰恰是**决策链**,不是单轮细节(细节在轮次目录和会话回放里)。
 */

import type { MailboxJob } from "./spec.ts"
import type { MailboxVerdict, RoundFiles } from "./store.ts"

const OUTCOME_LABEL: Record<MailboxVerdict["outcome"], string> = {
  passed: "✅ 判据全部通过",
  failed: "❌ 未能通过判据",
  parked: "⏸️ 已挂起,需要人介入",
}

export interface MailboxReportInput {
  mailboxJob: MailboxJob
  verdict: MailboxVerdict
  rounds: RoundFiles[]
  sessionsRoot?: string
}

export function renderMailboxReport(input: MailboxReportInput): string {
  const { mailboxJob, verdict, rounds } = input
  const job = mailboxJob.job
  const sections: string[] = []

  sections.push(`# 信箱闭环报告:${job.title}

**结论:${OUTCOME_LABEL[verdict.outcome]}** —— ${verdict.reason}

| | |
|---|---|
| 任务 | \`${job.id}\` |
| 轮次 | ${verdict.rounds} / ${mailboxJob.mailbox.maxRounds} |
| 终局裁决 | ${verdict.decidedBy === "policy" ? "确定性守卫(代码)" : "研发端"} |
| 用量 | 工位端 ${verdict.totalRunnerTokens.toLocaleString()} tokens · 研发端 ${verdict.totalMotherTokens.toLocaleString()} tokens |
| 板卡 | ${job.bench.board ?? "—"}${job.bench.chip ? ` (${job.bench.chip})` : ""} |
| 权限策略 | \`${job.policy}\` |`)

  sections.push(renderRounds(rounds))
  sections.push(renderLastWords(rounds))
  sections.push(renderReplay(input))

  return sections.filter(Boolean).join("\n\n") + "\n"
}

function renderRounds(rounds: RoundFiles[]): string {
  const lines = [
    "## 决策链(每轮:研发端给了什么 → 工位端跑出什么 → 谁裁决了什么)",
    "",
    "| 轮 | 附件 | 判据 | 研发端改动 | 裁决 |",
    "|---|---|---|---|---|",
  ]
  for (const round of rounds) {
    const grade = round.result?.error
      ? `⚠ ${clip(round.result.error, 60)}`
      : round.result?.grade
        ? round.result.grade.passed
          ? "✅ 全过"
          : `❌ ${[round.result.grade.build, ...round.result.grade.checks].filter((check) => check && check.outcome !== "pass" && check.outcome !== "skip").length} 项未过`
        : round.result?.turn?.stopReason
          ? `⚠ ${clip(round.result.turn.stopReason, 60)}`
          : "—"
    // 改动记在**裁决**上:研发端是在裁决那一步动的代码,产出随下一轮指令发出去。
    const changed = round.decision?.git?.changedFiles.length ?? 0
    const decision = round.decision
      ? `${round.decision.decision}(${round.decision.by === "policy" ? "守卫" : "研发端"})`
      : "—"
    const artifacts = round.instruction?.artifacts?.length
      ? round.instruction.artifacts.map((item) => `\`${item.name}\``).join("<br>")
      : "—"
    lines.push(`| ${round.round} | ${artifacts} | ${grade} | ${changed ? `${changed} 个文件` : "无"} | ${decision} |`)
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
  const dirty = [...rounds].reverse().find((round) => round.result?.workspace?.dirty.length)
  if (dirty?.result?.workspace?.dirty.length) {
    sections.push(
      `## ⚠ 工位机的工作树在第 ${dirty.round} 轮被改动过\n\n${dirty.result.workspace.dirty.map((file) => `- \`${file}\``).join("\n")}\n\n` +
        `工位端不该改源码 —— 判据是在这棵被改过的树上跑的,该轮证据要打折看。`,
    )
  }
  return sections.join("\n\n")
}

function renderReplay(input: MailboxReportInput): string {
  const lines = [
    "## 怎么复核",
    "",
    "1. 看轮次目录:`rounds/NNN/` 里有每轮的指令、结果、补丁与裁决;",
    "2. 判据可以自己复跑:`yoma-bench grade <job.json>`(只跑判据,不动代码);",
  ]
  const sessions = new Set<string>()
  for (const round of input.rounds) {
    if (round.result?.sessionID) sessions.add(round.result.sessionID)
    if (round.decision?.motherSessionID) sessions.add(round.decision.motherSessionID)
  }
  if (sessions.size) {
    lines.push(`3. 在 Yoma Desktop 里回放会话:${[...sessions].map((id) => `\`${id}\``).join("、")}(调试轮与母 agent 的完整过程都在)。`)
  }
  if (input.sessionsRoot) lines.push("", `会话文件:\`${input.sessionsRoot}\``)
  return lines.join("\n")
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…(截断)`
}
