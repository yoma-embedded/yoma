/**
 * 信箱两侧的话术。
 *
 * 分工见 spec.ts 头部(「工位端没有项目检出」这件事在 runner.ts 头部还有更细的一段)。
 * 两条由此而来、必须落在话术里的纪律:
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

import path from "node:path"

import type { Job } from "../job.ts"
import type { MailboxJob } from "./spec.ts"
import type { HumanAck, RoundArtifact, RoundFiles, RoundInstruction, RoundResultFile } from "./store.ts"
import { quote } from "./text.ts"

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

## 回传通道:\`${path.join(workDir, "outbox")}\`

**要研发端亲眼看的东西,丢进这个目录** —— 采集数据、完整日志、截图、脚本产出的
csv/npz,调试台会连同你的报告一起送回去,它那边有完整工具链,能自己画自己算。
文字复述过的数据它没法再算,曲线更不可能靠形容词传过去。

- 子目录随便建(\`capture/ch2.csv\` 这种很正常),同名不用担心 —— 每轮各存各的。
- 收过的会被移进 \`outbox/.sent/\`,所以**同一份数据不会重复传**;要再送一次就再丢一份。
- 有大小上限(信箱是个 git 仓,进去的东西瘦不回来)。原始采集先抽样或压缩再丢;
  超限的不会中断本轮,但研发端只会看到"有一件没送成"。
- 正文里说一句每个文件是什么、怎么读的 —— 一个 csv 没有列名说明,对面只能猜。

## 需要人动手时:\`outbox/ASK-HUMAN.txt\`

接电源、换负载、动机械、插拔线 —— 这些不是你能做的,也不是研发端能做的。把要人做的事
**写成一句人话**丢进这个文件,闭环会挂起、给人发通知,等回执再继续,**不会**一轮轮
空转地重复问。写清楚:做什么、做到什么程度、做完之后你要怎么验证。

写了它就照常把这一轮已经能做的事做完、如实回填 —— 挂起是研发端的裁决,不是你停手的理由。

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
  /**
   * 工位端这一轮回传的东西**落在研发机上哪儿**(相对工程根)。调试台落盘后填,
   * 不经模型 —— 与下行 `incoming` 同一条纪律:落点是事实,不该靠谁复述。
   */
  staged?: {
    files?: { name: string; bytes: number; localPath: string }[]
    /** 工位端自述全文的落点。提示词里只进节选,细节让它自己去读。 */
    reportPath?: string
  }
  /** 上一次 await-human 的回执。有它 = 这一轮是"人做完了,重新裁决"。 */
  humanAck?: HumanAck
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
5. **要原始数据,别要结论。** 工位端有一条回传通道(它的 \`outbox/\` 目录),你可以让它
   把采集、完整日志、脚本产出丢进去;送回来的文件已经落在你工程里的
   \`.my-pi/back/<轮次>/\`,路径每轮会列给你。**你有完整工具链** —— 自己读、自己画、
   自己算,比信一句"看起来收敛了"可靠得多。要它回传时说清格式(列名、单位、采样率),
   并提醒它先抽样或压缩(信箱是 git 仓,大文件进去就瘦不回来)。

## 你不做的

- **不碰硬件。** 板子根本不在这台机器上,\`flash\`/\`gdb\`/\`log\` 在你这儿只会得到
  "探针没找到"。要做的硬件动作写进指令。

## 什么时候停,也归你

**没有轮数上限、没有 token 上限、没有时间上限。** 闭环跑到你说 \`done\` 或 \`fail\` 为止。
"还有没有下一步值得试"完全是你的判断 —— 假设空间穷尽了就 \`fail\`,别靠换个说法再试
一遍来拖时间,那只是在烧钱。

判断"做完了"时你只有一份证据:**工位端的自述**。它是照着你的指令做的,但它可能看错、
可能只做了一半、也可能烧录失败了却接着测。所以指令要带**自证**:让它报出的数字本身能
说明问题(版本指纹、计数器增量、原文照抄的日志),而不是让它回答"好了吗"。

## 你每轮的输出:先分析,最后一个 \`\`\`json 围栏是唯一被机器读取的部分

\`\`\`json
{
  "decision": "continue | done | fail | await-human",
  "analysis": "你对证据的解读,两三句",
  "instruction": "decision 为 continue 时必填:给工位端的完整指令",
  "artifacts": ["build/Debug/firmware.elf"],
  "ask": "decision 为 await-human 时必填:要人去板子边上做什么,一句人话",
  "reason": "decision 为 done/fail 时必填:结论是什么 / 为什么放弃"
}
\`\`\`

规则:
- **continue**:还有可行的下一步。一轮只验一个假设,指令要具体到"怎么自证"。
- **artifacts**:可选。文件必须真的存在(构建完再写),路径相对工程根。改一次就附一次。
- **done**:证据表明问题已经解决。\`reason\` 里写清楚是哪条证据让你下这个结论。
- **fail**:按当前路径修不动了(假设空间穷尽、问题超出代码层、需要人换硬件)。
- **await-human**:下一步卡在一个**人的动作**上(接电源、换负载、动机械、插拔线),
  而且没有不依赖它的活可以先干。闭环会挂起、通知人、等回执,**期间两侧都不跑轮**。

  \`ask\` 会原样发给人,写清楚:做什么、做到什么程度、做完怎么算数。

  **同一个请求不要重复下发。** 上一轮已经转达过而人还没动手,正确动作是 \`await-human\`
  (挂起是零成本的),不是再写一遍"请转达……"—— 那只是把同一句话烧成 token。
  如果还有不依赖那个动作的事可以验,就照常 \`continue\` 去验,别空等。

## 关于"验收判据"

工位端报的现象常常只能证明**一部分**判据。你可以基于旁证下结论,但要在 \`reason\` 里
分开写:哪些是**照着原定判据字面验到的**,哪些是**推出来的**、还差什么条件才能验。
把推论写成"已验证"会让读终报的人以为板子上真跑出了那个结果 —— 那不是措辞问题,
是把没做完的验收当成做完了。`
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
  const { round, instruction, result, rounds } = input
  const sections: string[] = []
  sections.push(`# 第 ${round} 轮结果已回填,等你处理`)

  sections.push(
    `## 本轮下发的指令(你上次写的)\n\n${quote(clip(instruction.prompt, 1200))}${renderArtifactList(instruction.artifacts)}`,
  )

  if (result.error) {
    sections.push(`## 轮级失败\n\n${result.error}`)
  }

  if (result.turn) {
    const turn = result.turn
    const tools = Object.entries(turn.toolCounts)
      .map(([tool, count]) => (count > 1 ? `${tool}×${count}` : tool))
      .join(" ")
    const bullets = (items: string[]) => items.map((item) => `- ${clip(item, 200)}`).join("\n")
    // 四段的顺序是提示词的既定形状,别调。
    const meta = [`工具调用:${tools || "无"}`]
    if (turn.stopReason) meta.push(`本轮中断:${turn.stopReason}`)
    if (turn.toolErrors.length) meta.push(`工具报错:\n${bullets(turn.toolErrors)}`)
    if (turn.errors.length) meta.push(`轮内 provider 错误(模型侧故障,不是代码问题):\n${bullets(turn.errors)}`)
    // 自述是全篇里唯一会长到失控的一段:节选进提示词、全文进文件(见 clipEnds)。
    const full = input.staged?.reportPath
    if (full) meta.push(`自述全文(未截断):\`${full}\``)
    const text = clipEnds(
      turn.text || "(这一轮没有正文)",
      BENCH_TEXT_HEAD,
      BENCH_TEXT_TAIL,
      full ? `全文在 \`${full}\`` : "全文在信箱本轮目录的 bench-report.md",
    )
    sections.push(`## 工位端的自述\n\n${quote(text)}\n\n${meta.join("\n")}`)
  }

  sections.push(...renderBackSections(input))

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

/**
 * 上行三件事:回传件落在哪、有没有没送成的、有没有在等人。
 *
 * 回传件给的是**本机相对路径**而不是文件名 —— 研发端手上有完整工具链,路径是让它
 * 真去读、去画、去算的;只报个名字等于还是让它信工位端的文字描述。
 */
function renderBackSections(input: MotherPromptInput): string[] {
  const { result, humanAck } = input
  const sections: string[] = []
  const staged = input.staged?.files ?? []

  if (staged.length) {
    const lines = staged.map(
      (item) => `- \`${item.localPath}\`(${(item.bytes / 1024).toFixed(0)}KB${item.name === item.localPath ? "" : `,工位端叫它 ${item.name}`})`,
    )
    sections.push(
      `## 工位端回传的文件(已经在你机器上)\n\n${lines.join("\n")}\n\n` +
        `这是原始数据,不是它的复述 —— 自己读、自己画、自己算。`,
    )
  }
  if (result.backSkipped?.length) {
    const lines = result.backSkipped.map(
      (item) => `- \`${item.name}\`(${(item.bytes / 1024).toFixed(0)}KB):${item.reason}`,
    )
    sections.push(
      `## 它想回传但没送成的\n\n${lines.join("\n")}\n\n` +
        `这些东西**你没有**。要就让它抽样/压缩后重发,别当作已经看过。`,
    )
  }
  if (result.needsHuman) {
    sections.push(
      `## 工位端说需要人动手\n\n${quote(clip(result.needsHuman, 2000))}\n\n` +
        `这不是它偷懒 —— 接电源、换负载、动机械没人能替。你的选择:还有不依赖这个动作的事`
        + `可以验就照常 \`continue\` 去验;没有就 \`await-human\`,把要人做的事写进 \`ask\`。`
        + `**别再下发一轮"请转达……"**。`,
    )
  }
  if (humanAck) {
    const answer = humanAck.answer === "done" ? "人已经做完了" : "人做不了这件事"
    // 上一次挂起的请求要一起给:本轮自己那条裁决不在"此前各轮"里(它按 round < 当前轮
    // 过滤),不带上的话它看到的简报和挂起前一模一样,大概率原地再挂一次。
    const parked = input.rounds.find((entry) => entry.round === input.round)?.decision
    const ask = parked?.decision === "await-human" ? parked.ask : undefined
    sections.push(
      `## 人工动作的回执:${answer}\n\n` +
        (ask ? `你上一次请求的是:${quote(clip(ask, 600))}\n\n` : "") +
        `人的回话:${humanAck.note ? `\n\n${quote(clip(humanAck.note, 1000))}` : "(没留话)"}\n\n` +
        (humanAck.answer === "done"
          ? `条件已经具备,接着往下走 —— 这一轮由你重新裁决(挂起期间没有产生新的板上证据)。`
          : `这条路走不通了,换一条不依赖它的验证路径,或者据此收尾。`),
    )
  }
  return sections
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

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(截断)`
}

/**
 * 工位端自述进提示词的额度。**尾巴留得比头多** —— 汇总行、RESULT、结论永远在末尾,
 * 从头截断正好砍掉最该看的那半(实测:一次五轮的任务,每一轮的自述都超过当时 4000 字的
 * 上限,第一轮丢掉 44%,而丢掉的正是结论段)。
 *
 * 为什么不干脆全给:自述随会话一轮轮累积,全篇进上下文等于第 8 轮还背着前 7 轮的原始
 * 日志。全文另有文件,要细节自己读一次 —— 一次性成本,不进会话历史。
 */
const BENCH_TEXT_HEAD = 6000
const BENCH_TEXT_TAIL = 14000

/** 头尾都留的截断。`hint` 写清全文在哪 —— 只说"截断了"会让人以为剩下的没了。 */
function clipEnds(text: string, head: number, tail: number, hint: string): string {
  if (text.length <= head + tail) return text
  const dropped = text.length - head - tail
  return `${text.slice(0, head)}\n\n…(中间省略 ${dropped} 字,${hint})…\n\n${text.slice(-tail)}`
}
