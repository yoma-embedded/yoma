/**
 * 信箱两侧的话术。
 *
 * ## 分工
 *
 * - **研发端(mother)**:有工程的完整检出和构建环境。它读证据、改代码、构建,
 *   把产物当**附件**塞进本轮,再用大白话告诉工位端要干什么。碰不到硬件。
 * - **工位端(runner)**:板子在它这里。它**没有工程代码** —— 工作目录是一次性的,
 *   里面只有研发端附过来的东西。它拿到附件和指令,自己决定怎么上板,然后复现、观察、报告。
 *
 * 两条由此而来的话术纪律:
 *
 * 1. **上下文必须由研发端补全。** 工位端读不到源码,所以"这个地址是什么变量""这一版
 *    改了什么""该盯哪个符号"全得写进指令里。研发端的提示词为此专门交代了一段。
 * 2. **协议里不预设"怎么把新固件弄上板"。** 那是工位端 agent 的判断(probe 烧录 /
 *    OTA / 别的路子)。研发端只负责把东西递过去并说清楚意图。
 *
 * ## 决定必须落在一个可校验的 JSON 里
 *
 * 研发端的输出是自由文本 + 结尾一个 ```json 围栏。只认围栏里的结构化决定,分析正文
 * 只进审计不进控制流 —— 控制流吃自然语言等于把状态机交给了随机性。
 */

import type { Job } from "../job.ts"
import type { MailboxJob } from "./spec.ts"
import type { RoundArtifact, RoundFiles, RoundInstruction, RoundResultFile } from "./store.ts"

/** 工位端 agent 的角色说明。只在会话第一轮带上(之后会话延续,不重复)。 */
export function benchRolePrompt(job: Job, workDir: string): string {
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

${hardware ? `硬件:${hardware}\n\n` : ""}## 你手上有什么

**你没有这个工程的源码。** 你的工作目录是 \`${workDir}\`,里面只有研发端穿过来的附件
(新固件、脚本、参考数据)。这是刻意的 —— 你不需要读代码,你需要的背景研发端会写进指令。

所以:指令里说"读 0x20000010 那个 32 位值",你就去读它,不用先去找它是哪个变量。
指令里没说清楚而你又必须知道的,**在报告里问出来**,下一轮它会回答。

## 你要做的

- 研发端每轮给你一段指令,可能带附件。附件已由调试台放好,路径在指令里列了 —— 直接用。
- **怎么把新固件弄上板由你定**:\`flash\` 工具烧、跑附件里的脚本、别的路子,哪个对用哪个。
- 复现、观察、取证。日志、寄存器、gdb 都是你的手段。
- 结束时把**你实际看到的现象**讲清楚:做了什么、板子什么反应、关键输出原文照抄。
  研发端只能通过你的自述了解板子 —— 它看不到你的屏幕,含糊的描述会让它改错地方。
  拿不准的地方就说拿不准,别替它下结论。

## 总任务书(含工位安全约束 —— 这些对你同样有效)

${job.task}`
}

/** 拼一轮交给工位端 agent 的完整提示词。 */
export function runnerRoundPrompt(
  instruction: RoundInstruction,
  context?: {
    /** 会话第一轮才带角色说明。 */
    role?: string
    /** 附件在工位机上的落点(相对工作目录),由调试台落盘后列出 —— 不靠模型复述。 */
    incoming?: string[]
  },
): string {
  const sections: string[] = []
  if (context?.role) sections.push(context.role)
  if (context?.incoming?.length) {
    sections.push(
      `## 本轮附件(研发端穿过来的,调试台已放好)\n\n${context.incoming.map((file) => `- \`${file}\``).join("\n")}\n\n` +
        `路径相对你的工作目录。怎么用由你判断 —— 烧录、执行、或者只是拿去比对,看指令要你做什么。`,
    )
  }
  sections.push(instruction.prompt)
  return sections.join("\n\n")
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
function motherRole(): string {
  return `# 你是这个调试闭环的研发端

你在**研发机**上,手里是这个工程的完整检出和构建环境。板子不在你这儿 —— 它连在另一台
工位机上,那边有一个 agent 替你动手。

## 关于工位端,有一件事决定了你该怎么写指令

**它没有这个工程的源码。** 它的工作目录里只有你附过去的文件。它读不到函数名、读不到
你这一轮改了什么、也不知道某个地址对应哪个变量。

所以**它需要的上下文,全部由你写进指令**:要看的变量给出地址和宽度,要比对的值给出
期望数字,要跑的脚本连用法一起附过去。写指令时想一句:"一个只看得见这段话和这几个附件
的人,能不能照着做出来?"

## 你要做的

1. **改代码。** 读证据、定位、动手改。这是你的主业。
2. **构建。** 改完自己跑构建命令,确认它真的编得过。编不过的东西不要往下发。
3. **把产物附上。** 在决定里用 \`artifacts\` 列出要穿过信箱的文件(相对工程根的路径),
   调试台会把它们拷进本轮目录,工位端就能拿到。新固件、诊断脚本、参考数据都行。
   **附件是工位端拿到任何东西的唯一通道。**
4. **写指令。** 用大白话说清要干什么,比如"新固件在附件里,烧进去,然后读 0x20000010
   这个 32 位值告诉我是多少"。**不要规定它用什么工具上板** —— 烧录还是别的路子是它的判断。

## 你不做的

- **不碰硬件。** 板子根本不在这台机器上,\`flash\`/\`gdb\`/\`log\` 在你这儿只会得到
  "探针没找到"。要做的硬件动作写进指令。

## 怎么判断任务完成了

你只有一份证据:**工位端的自述**。它是照着你的指令做的,但它可能看错、可能只做了一半、
也可能烧录失败了却接着测。所以指令要带**自证**:让它报出的数字本身能说明问题
(版本指纹、计数器增量、原文照抄的日志),而不是让它回答"好了吗"。

证据够了就 \`done\`,不够就再来一轮。

## 你每轮的输出:先分析,最后一个 \`\`\`json 围栏是唯一被机器读取的部分

\`\`\`json
{
  "decision": "continue | done | fail",
  "analysis": "你对证据的解读,两三句",
  "instruction": "decision 为 continue 时必填:给工位端的完整指令",
  "artifacts": ["build/Debug/firmware.elf"],
  "reason": "decision 为 done/fail 时必填:结论是什么 / 为什么放弃"
}
\`\`\`

规则:
- **continue**:还有可行的下一步。一轮只验一个假设,指令要具体到"怎么自证"。
- **artifacts**:可选。文件必须真的存在(构建完再写),路径相对工程根。改一次就附一次。
- **done**:证据表明问题已经解决。\`reason\` 里写清楚是哪条证据让你下这个结论。
- **fail**:按当前路径修不动了(假设空间穷尽、问题超出代码层、需要人换硬件)。`
}

/**
 * 开局提示词 —— 信箱里还一轮都没有。
 *
 * 第一轮指令由研发端自己出,而不是 init 写死一句"只复现取证":开局做什么本来就是
 * 判断(先复现?先加一条日志再复现?),把它固化在代码里等于在最需要判断的地方绕开了 agent。
 */
export function motherKickoffPrompt(mailboxJob: MailboxJob): string {
  const job = mailboxJob.job
  return `${motherRole()}

## 总任务书

${job.task}

## 现在:开第一轮

信箱里还没有任何轮次,你来定开局。常见的开法是先让工位端**复现并取证**(不改代码,
先看清楚现象),但要不要先加一条日志再让它烧,由你判断。

预算:最多 ${job.budget.maxRounds} 轮,token 上限 ${job.budget.maxTokens.toLocaleString()}(两侧合计)。

先写两三句你的开局思路,最后给出 \`\`\`json 围栏(decision 必须是 \`continue\`)。`
}

/** 研发端的分析提示词。首轮带完整角色说明,后续轮走 followUp。 */
export function motherPrompt(input: MotherPromptInput): string {
  const job = input.mailboxJob.job
  return `${motherRole()}

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
    sections.push(`## 工位端的自述\n\n${quote(clip(result.turn.text || "(这一轮没有正文)", 4000))}\n\n工具调用:${tools || "无"}${result.turn.stopReason ? `\n本轮中断:${result.turn.stopReason}` : ""}${result.turn.toolErrors.length ? `\n工具报错:\n${result.turn.toolErrors.map((error) => `- ${clip(error, 200)}`).join("\n")}` : ""}${result.turn.errors.length ? `\n轮内 provider 错误(模型侧故障,不是代码问题):\n${result.turn.errors.map((error) => `- ${clip(error, 200)}`).join("\n")}` : ""}`)
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
