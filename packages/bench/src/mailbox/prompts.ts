/**
 * 信箱两侧的话术。
 *
 * ## 分工(2026-08 起)
 *
 * - **研发端(mother)**:有工程的完整检出和构建环境。它读证据、改代码、构建,
 *   把产物当**附件**塞进本轮,再用大白话告诉工位端要干什么。碰不到硬件。
 * - **工位端(runner)**:板子在它这里。它拿到附件和指令,**自己决定怎么上板**
 *   (probe 烧录 / OTA 脚本 / 别的路子),然后复现、观察、报告。不改源码。
 *
 * 协议里不预设"怎么把新固件弄上板"这件事 —— 那是工位端 agent 的判断。研发端只负责
 * 把东西递过去并说清楚意图,换成 OTA 或远端 CI 产物时,变的只是指令里的那句话。
 *
 * ## 证据分层
 *
 * 交给工位端的每轮提示词是确定性拼装的:被拒动作 → 附件清单(由**代码**列,不是模型
 * 复述)→ 研发端指令原文 → 上一轮判据证据(取自调试台自己跑出的 grade)。模型转述
 * 会漂移,而证据是下一步判断的地基。
 *
 * ## 决定必须落在一个可校验的 JSON 里
 *
 * 研发端的输出是自由文本 + 结尾一个 ```json 围栏。只认围栏里的结构化决定,分析正文
 * 只进审计不进控制流 —— 控制流吃自然语言等于把状态机交给了随机性。校验规则
 * (见 mother.ts)会拒绝"判据没过却说 success":判据不归模型管,两侧一视同仁。
 */

import { blockedPrompt, describeChecks } from "../prompts.ts"
import type { GradeResult } from "../grader.ts"
import type { Job } from "../job.ts"
import type { MailboxJob } from "./spec.ts"
import type { RoundArtifact, RoundFiles, RoundInstruction, RoundResultFile } from "./store.ts"

/** 工位端 agent 的角色说明。只在会话第一轮带上(之后会话延续,不重复)。 */
export function benchRolePrompt(job: Job, incomingDir: string): string {
  const hardware = [
    job.bench.board && `板卡:${job.bench.board}`,
    job.bench.chip && `芯片:${job.bench.chip}`,
    job.bench.probe && `探针:${job.bench.probe}`,
  ]
    .filter(Boolean)
    .join(" · ")

  return `# 你是这个调试闭环的工位端

板子在你这台机器上。另一端是研发端 agent:它有工程的完整检出和构建环境,负责**改代码**;
你负责**把它给的东西弄上板、复现、观察、如实报告**。

${hardware ? `硬件:${hardware}\n\n` : ""}## 总任务书(含工位安全约束 —— 这些对你同样有效)

${job.task}

## 你要做的

- 研发端每轮会给你一段指令,可能带**附件**(新构建的固件等)。附件已经由调试台放在
  \`${incomingDir}/\` 下,路径在指令里列好了 —— 直接用,不用去别处找。
- **怎么把新固件弄上板由你定**:用 \`flash\` 工具烧、跑工程里的 OTA 脚本、或者别的
  路子,哪个对用哪个。指令里通常只说"有新固件,上板然后复现 X"。
- 复现、观察、取证。日志、寄存器、gdb 都是你的手段。
- 结束时把**你实际看到的现象**讲清楚:做了什么、板子什么反应、关键日志原文。
  研发端只能通过你的自述了解板子,含糊的描述会让它改错地方。

## 你不做的

- **不改源码。** \`edit\`/\`write\` 会被策略直接拒掉,这不是失误是设计:代码归研发端。
  发现要改什么,写进你的报告里,下一轮它会把新产物附过来。
- **不宣布判据通过。** 判据由调试台在你这轮结束后独立执行,你说"好了"不算数。

## 成功判据(调试台跑,你和研发端都无权宣布通过)

${describeChecks(job.success.checks)}`
}

/** 拼一轮交给工位端 agent 的完整提示词。 */
export function runnerRoundPrompt(
  instruction: RoundInstruction,
  context?: {
    /** 会话第一轮才带角色说明。 */
    role?: string
    /** 附件在工位机上的落点(相对工作区),由调试台落盘后列出 —— 不靠模型复述。 */
    incoming?: string[]
    previous?: { grade?: GradeResult; denied?: { tool: string; title: string; rule?: string }[] }
  },
): string {
  const sections: string[] = []
  if (context?.role) sections.push(context.role)
  if (context?.previous?.denied?.length) {
    sections.push(
      blockedPrompt(context.previous.denied.map((item) => ({ tool: item.tool, title: item.title, why: item.rule }))),
    )
  }
  if (context?.incoming?.length) {
    sections.push(
      `## 本轮附件(研发端穿过来的,调试台已放好)\n\n${context.incoming.map((file) => `- \`${file}\``).join("\n")}\n\n` +
        `路径相对你的工作目录。怎么用由你判断 —— 烧录、OTA、或者只是拿去比对,看指令要你做什么。`,
    )
  }
  sections.push(instruction.prompt)
  if (context?.previous?.grade) {
    const evidence = renderGradeEvidence(context.previous.grade)
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
}

/** 研发端的角色说明 —— 开局和分析轮共用同一段,保证两条路径说的是同一件事。 */
function motherRole(job: Job): string {
  return `# 你是这个调试闭环的研发端

你在**研发机**上,手里是这个工程的完整检出和构建环境。板子不在你这儿 —— 它连在另一台
工位机上,那边有一个 agent 替你动手。

## 你要做的

1. **改代码。** 读证据、定位、动手改。这是你的主业,工位端不改代码。
2. **构建。** 改完自己跑构建命令,确认它真的编得过。编不过的东西不要往下发。
3. **把产物附上。** 在决定里用 \`artifacts\` 列出要穿过信箱的文件(相对工程根的路径),
   调试台会把它们拷进本轮目录,工位端就能拿到。新固件、烧录脚本、临时的诊断工具都行。
4. **写指令。** 用大白话告诉工位端要干什么,比如"新固件在附件里,烧进去,然后发 rpm 1000
   盯 30 秒日志看有没有 timeout"。**不要规定它用什么工具上板** —— 烧录还是 OTA 是它的判断。

## 你不做的

- **不碰硬件。** \`flash\`/\`gdb\`/\`log\` 在你这边会被直接拒掉(板子根本不在这台机器上)。
  要做的硬件动作写进指令。
- **不宣布判据通过。** 判据由工位端调试台独立执行;全绿时闭环自动终止,轮到你出手的
  局面都是还没过的。

## 成功判据(工位端调试台跑,你无权宣布通过)

${describeChecks(job.success.checks)}

## 你每轮的输出:先分析,最后一个 \`\`\`json 围栏是唯一被机器读取的部分

\`\`\`json
{
  "decision": "continue | fail | park",
  "analysis": "你对证据的解读,两三句",
  "instruction": "decision 为 continue 时必填:给工位端的完整指令",
  "artifacts": ["build/Debug/firmware.elf"],
  "reason": "decision 为 fail/park 时必填:为什么终止"
}
\`\`\`

规则:
- **continue**:还有可行的下一步。一轮只验一个假设,指令要具体到"怎么自证"。
  判据证据会自动附在指令后面,不必复述日志原文。
- **artifacts**:可选。文件必须真的存在(构建完再写),路径相对工程根。同一个文件
  改一次就附一次 —— 工位端只能看到你附过去的东西。
- **fail**:证据表明按当前路径修不动了(假设空间穷尽、问题超出代码层)。
- **park**:需要人或硬件介入(探针掉了、要换板子、要人确认危险操作)。`
}

/**
 * 开局提示词 —— 信箱里还一轮都没有。
 *
 * 第一轮指令由研发端自己出,而不是 init 写死一句"只复现取证":开局做什么本来就是
 * 判断(先复现?先加一条日志再复现?先烧 known-good 排除环境?),把它固化在代码里
 * 等于在最需要判断的地方绕开了 agent。
 */
export function motherKickoffPrompt(mailboxJob: MailboxJob): string {
  const job = mailboxJob.job
  return `${motherRole(job)}

## 总任务书

${job.task}

## 现在:开第一轮

信箱里还没有任何轮次,你来定开局。常见的开法是先让工位端**复现并取证**(不改代码,
先看清楚现象),但要不要先加一条日志、先烧 known-good 排除环境问题,由你判断。

预算:最多 ${mailboxJob.mailbox.maxRounds} 轮,token 上限 ${job.budget.maxTokens.toLocaleString()}(两侧合计)。

先写两三句你的开局思路,最后给出 \`\`\`json 围栏(decision 必须是 \`continue\`)。`
}

/** 研发端的分析提示词。首轮带完整角色说明,后续轮走 followUp。 */
export function motherPrompt(input: MotherPromptInput): string {
  const job = input.mailboxJob.job
  return `${motherRole(job)}

## 总任务书

${job.task}

${renderRoundBrief(input)}`
}

/** 后续轮:会话延续,角色说明不重复,只给新一轮的简报。 */
export function motherFollowUpPrompt(input: MotherPromptInput): string {
  return renderRoundBrief(input)
}

function renderRoundBrief(input: MotherPromptInput): string {
  const { round, instruction, result, budget, rounds } = input
  const sections: string[] = []
  sections.push(`# 第 ${round} 轮结果已回填,等你处理

预算:轮次 ${budget.roundsUsed}/${budget.maxRounds},token ${budget.tokensSpent.toLocaleString()}/${budget.maxTokens.toLocaleString()}(两侧合计)。`)

  sections.push(
    `## 本轮下发的指令(你上次写的)\n\n${quote(clip(instruction.prompt, 1200))}${renderArtifactList(instruction.artifacts)}`,
  )

  if (result.error) {
    sections.push(`## 轮级失败\n\n${result.error}`)
  }

  if (result.turn) {
    const tools = Object.entries(result.turn.toolCounts)
      .map(([tool, count]) => (count > 1 ? `${tool}×${count}` : tool))
      .join(" ")
    sections.push(`## 工位端的自述(它说的,未经验证)\n\n${quote(clip(result.turn.text || "(这一轮没有正文)", 4000))}\n\n工具调用:${tools || "无"}${result.turn.stopReason ? `\n本轮中断:${result.turn.stopReason}` : ""}${result.turn.toolErrors.length ? `\n工具报错:\n${result.turn.toolErrors.map((error) => `- ${clip(error, 200)}`).join("\n")}` : ""}${result.turn.errors.length ? `\n轮内 provider 错误(模型侧故障,不是代码问题):\n${result.turn.errors.map((error) => `- ${clip(error, 200)}`).join("\n")}` : ""}`)
  }

  if (result.grade) {
    sections.push(`## 判据结果(工位端调试台独立执行,可采信)\n\n${renderGradeEvidence(result.grade)}`)
  }

  if (result.denied.length) {
    sections.push(`## 被权限策略拦下的动作\n\n${result.denied.map((item) => `- \`${item.tool}\` ${item.title}${item.rule ? `(${item.rule})` : ""}`).join("\n")}`)
  }

  if (result.workspace?.dirty.length) {
    sections.push(
      `## ⚠ 工位机的工作树被改动了\n\n${result.workspace.dirty.map((file) => `- \`${file}\``).join("\n")}\n\n` +
        `工位端不该改源码。这些改动不在你的仓里,而且判据是在这棵被改过的树上跑的 —— 证据要打折看。`,
    )
  }

  const history = rounds
    .filter((entry) => entry.round < round && entry.decision)
    .map((entry) => `- 第 ${entry.round} 轮 → ${entry.decision!.decision}${entry.decision!.analysis ? `:${clip(entry.decision!.analysis, 120)}` : ""}`)
  if (history.length) sections.push(`## 此前各轮的裁决\n\n${history.join("\n")}`)

  sections.push(
    `现在决定下一步。要改代码就直接改、改完构建、在 \`artifacts\` 里附上产物;` +
      `最后写一个 \`\`\`json 围栏 —— **只有它会被机器读取**。`,
  )
  return sections.join("\n\n")
}

function renderArtifactList(artifacts?: RoundArtifact[]): string {
  if (!artifacts?.length) return ""
  const lines = artifacts.map((item) => `- \`${item.name}\`(${(item.bytes / 1024).toFixed(0)}KB${item.from ? `,来自 ${item.from}` : ""})`)
  return `\n\n随这轮附过去的文件:\n${lines.join("\n")}`
}

export function motherRetryPrompt(error: string): string {
  return `你上一条回复里的决定没法被机器读取:${error}

请重新给出决定:只需一个 \`\`\`json 围栏,字段与规则同前(decision / analysis / instruction / artifacts / reason)。`
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
