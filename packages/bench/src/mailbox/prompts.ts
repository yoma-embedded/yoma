/**
 * 信箱两侧的话术。
 *
 * ## runner 侧:指令 + 证据分层
 *
 * 交给调试 agent 的每轮提示词由三段确定性拼装:被拒动作清单(有则)→ 母 agent 指令
 * 原文 → 上一轮判据证据。证据由 runner 从自己跑出的 grade 结果里取,**不信任 mother
 * 转述** —— 模型复述日志会漂移,而证据是 agent 下一步判断的地基。
 *
 * ## mother 侧:决定必须落在一个可校验的 JSON 里
 *
 * 母 agent 的输出是自由文本 + 结尾一个 ```json 围栏。只认围栏里的结构化决定,
 * 分析正文只进审计不进控制流 —— 控制流吃自然语言等于把状态机交给了随机性。
 * 校验规则(见 mother.ts)会拒绝"判据没过却说 success"这类越权:判据不归模型管,
 * 对调试 agent 如此,对母 agent 同样如此。
 */

import { blockedPrompt, describeChecks } from "../prompts.ts"
import type { GradeResult } from "../grader.ts"
import type { MailboxJob } from "./spec.ts"
import type { RoundFiles, RoundInstruction, RoundResultFile } from "./store.ts"

/** 拼一轮交给调试 agent 的完整提示词。 */
export function runnerRoundPrompt(
  instruction: RoundInstruction,
  previous?: { grade?: GradeResult; denied?: { tool: string; title: string; rule?: string }[] },
): string {
  const sections: string[] = []
  if (previous?.denied?.length) {
    sections.push(blockedPrompt(previous.denied.map((item) => ({ tool: item.tool, title: item.title, why: item.rule }))))
  }
  sections.push(instruction.prompt)
  if (previous?.grade) {
    const evidence = renderGradeEvidence(previous.grade)
    if (evidence) {
      sections.push(`## 上一轮判据结果(调试台独立执行,原始证据)\n\n${evidence}`)
    }
  }
  return sections.join("\n\n")
}

function renderGradeEvidence(grade: GradeResult): string {
  const parts = [grade.build, ...grade.checks]
    .filter((check) => check !== undefined)
    .map((check) => {
      const icon = { pass: "✓", fail: "✗", error: "⚠(没跑成,环境问题)", skip: "−(跳过)" }[check.outcome]
      const head = `${icon} ${check.summary}`
      return check.outcome !== "pass" && check.evidence ? `${head}\n\`\`\`\n${clip(check.evidence, 2000)}\n\`\`\`` : head
    })
  return parts.join("\n\n")
}

export interface MotherPromptInput {
  mailboxJob: MailboxJob
  round: number
  instruction: RoundInstruction
  result: RoundResultFile
  rounds: RoundFiles[]
  /** 预算余量,由代码算好递进来 —— 不让模型自己做算术。 */
  budget: { roundsUsed: number; maxRounds: number; tokensSpent: number; maxTokens: number }
  /** 本轮 patch.diff 在信箱内的相对路径(存在时给出,mother 可以用 read 工具细看)。 */
  patchPath?: string
}

/** 母 agent 的分析提示词。首轮带完整角色说明,后续轮走 followUp。 */
export function motherPrompt(input: MotherPromptInput): string {
  const { mailboxJob, round, instruction, result, budget } = input
  const job = mailboxJob.job

  const header = `# 你是这个调试闭环的指挥(母 agent)

一台工位机上的调试 agent 正在修下面这个嵌入式问题。它每执行一轮,你收到一次结果;
你的职责是**判断证据、决定下一步**,而不是亲自动手修代码。

## 总任务书

${job.task}

## 成功判据(由工位机独立执行 —— 你和调试 agent 都无权宣布"通过")

${describeChecks(job.success.checks)}

## 你每轮要给出的决定(最后必须是一个 \`\`\`json 围栏)

\`\`\`json
{
  "decision": "continue | fail | park",
  "analysis": "你对本轮证据的解读,两三句",
  "instruction": "decision 为 continue 时必填:下一轮给调试 agent 的完整指令",
  "reason": "decision 为 fail/park 时必填:为什么终止"
}
\`\`\`

规则:
- **continue**:还有可行的下一步。指令要具体到"验证哪个假设、改哪一处、怎么自证",
  一轮只准一个假设。判据证据会自动附在你的指令后面,不必复述日志原文。
- **fail**:证据表明按当前路径修不动了(假设空间穷尽、问题超出代码层)。
- **park**:需要人或硬件介入(探针掉了、要换板子、要人确认危险操作)。
- "判据通过"不由你说 —— 判据全绿时闭环会自动终止,轮到你的都是还没过的局面。
- 信箱里的文件你可以用 read 工具细看(轮次目录、patch.diff);不要试图改任何文件。`

  return `${header}\n\n${renderRoundBrief(input.rounds, round, instruction, result, budget, input.patchPath)}`
}

/** 后续轮:mother 会话延续,角色说明不重复,只给新一轮的简报。 */
export function motherFollowUpPrompt(input: MotherPromptInput): string {
  return renderRoundBrief(input.rounds, input.round, input.instruction, input.result, input.budget, input.patchPath)
}

function renderRoundBrief(
  rounds: RoundFiles[],
  round: number,
  instruction: RoundInstruction,
  result: RoundResultFile,
  budget: MotherPromptInput["budget"],
  patchPath?: string,
): string {
  const sections: string[] = []
  sections.push(`# 第 ${round} 轮结果已回填,等你裁决

预算:轮次 ${budget.roundsUsed}/${budget.maxRounds},token ${budget.tokensSpent.toLocaleString()}/${budget.maxTokens.toLocaleString()}(两侧合计)。`)

  sections.push(`## 本轮下发的指令(${instruction.issuedBy === "init" ? "首轮固定:只复现取证" : "你上次写的"})\n\n${quote(clip(instruction.prompt, 1200))}`)

  if (result.error) {
    sections.push(`## 轮级失败\n\n${result.error}`)
  }

  if (result.turn) {
    const tools = Object.entries(result.turn.toolCounts)
      .map(([tool, count]) => (count > 1 ? `${tool}×${count}` : tool))
      .join(" ")
    sections.push(`## 调试 agent 的自述(它说的,未经验证)\n\n${quote(clip(result.turn.text || "(这一轮没有正文)", 4000))}\n\n工具调用:${tools || "无"}${result.turn.stopReason ? `\n本轮中断:${result.turn.stopReason}` : ""}${result.turn.toolErrors.length ? `\n工具报错:\n${result.turn.toolErrors.map((error) => `- ${clip(error, 200)}`).join("\n")}` : ""}${result.turn.errors.length ? `\n轮内 provider 错误(模型侧故障,不是代码问题):\n${result.turn.errors.map((error) => `- ${clip(error, 200)}`).join("\n")}` : ""}`)
  }

  if (result.grade) {
    sections.push(`## 判据结果(工位机独立执行,可采信)\n\n${renderGradeEvidence(result.grade)}`)
  }

  if (result.denied.length) {
    sections.push(`## 被权限策略拦下的动作\n\n${result.denied.map((item) => `- \`${item.tool}\` ${item.title}${item.rule ? `(${item.rule})` : ""}`).join("\n")}`)
  }

  if (result.git) {
    const files = result.git.changedFiles.length ? result.git.changedFiles.map((file) => `- \`${file}\``).join("\n") : "(没有代码改动)"
    sections.push(`## 代码改动(相对任务基线,累计)\n\n${files}${result.git.diffStat ? `\n\`\`\`\n${clip(result.git.diffStat, 1500)}\n\`\`\`` : ""}${patchPath ? `\n完整补丁:\`${patchPath}\`(可用 read 工具细看)` : ""}`)
  }

  const history = rounds
    .filter((entry) => entry.round < round && entry.decision)
    .map((entry) => `- 第 ${entry.round} 轮 → ${entry.decision!.decision}${entry.decision!.analysis ? `:${clip(entry.decision!.analysis, 120)}` : ""}`)
  if (history.length) sections.push(`## 此前各轮的裁决\n\n${history.join("\n")}`)

  sections.push(`现在给出你的决定。先写两三句分析,**最后一个 \`\`\`json 围栏是唯一被机器读取的部分**。`)
  return sections.join("\n\n")
}

export function motherRetryPrompt(error: string): string {
  return `你上一条回复里的决定没法被机器读取:${error}

请重新给出决定:只需一个 \`\`\`json 围栏,字段与规则同前(decision / analysis / instruction / reason)。`
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
