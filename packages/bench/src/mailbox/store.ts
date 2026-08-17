/**
 * 信箱的文件布局与状态推断 —— 协议的"数据面"。只碰文件,不碰 git(那是 sync.ts 的事)。
 *
 * ## 布局
 *
 * ```
 * <信箱根>/
 *   job.json                    总任务书(MailboxJob 原文)
 *   toolchain.json              项目工具链清单的副本(研发端每轮刷新;工位端没有检出,
 *                               这是它唯一读得到清单的途径)
 *   rounds/001/instruction.json 研发端 → 工位端:本轮指令(自然语言)
 *   rounds/001/artifacts/*      研发端 → 工位端:本轮附件(新构建的固件、脚本…)
 *   rounds/001/patch.diff       研发端为本轮做的代码改动(审计与终报用)
 *   rounds/001/back/*           工位端 → 研发端:本轮回传件(采集数据、日志、图)
 *   rounds/001/bench-report.md  工位端 → 研发端:本轮自述**全文**(提示词里只进节选)
 *   rounds/001/result.json      工位端 → 研发端:轮结果(最后写 —— 它的存在 = 本轮完成)
 *   rounds/001/decision.json    本轮裁决(研发端 mother;拿不到它的决定时由代码代写)
 *   rounds/001/human-ack.json   人 → 闭环:await-human 挂起时的回执(谁都可以写)
 *   verdict.json                终局(出现即整个任务结束)
 *   report.md                   终报(与 verdict 同一次提交写入)
 * ```
 *
 * ## 两个方向都要有附件
 *
 * 下行(`artifacts/`)是工位端拿到东西的唯一通道;上行(`back/`)是研发端拿到**原始数据**
 * 的唯一通道。没有上行时,工位端采到的波形只能用文字复述,而复述过的数据不能再算 ——
 * 研发端手上有完整工具链,让它自己读自己算,比信一句"看起来收敛了"强得多。
 *
 * 上行不设"声明"这一步(下行的 `artifacts: [...]` 是研发端在决定 JSON 里声明的):
 * 工位端是唯一挨着板子的一侧,给它加一个"必须写出可解析结构"的契约等于在最不该失败的
 * 地方多一个解析失败模式。约定一个投递目录、由调试台扫,才是确定性的。
 *
 * **一轮的输入是一整包**:指令 + 附件 + 补丁同住 `rounds/NNN/`,同一次提交推出去。
 * 附件是这条邮路的重点 —— 研发端改完代码自己构建,把产物塞进 `artifacts/`,
 * 用大白话告诉工位端"有新固件,烧进去然后复现 X";怎么上板(probe 烧录 / OTA /
 * 别的)由工位端那个 agent 自己定,协议里不预设机制。
 *
 * ## 状态是**推断**出来的,不落盘
 *
 * 没有 state.json:状态 = "最大的一个有 instruction 的轮次处在哪一步"。单独维护一份
 * 状态文件意味着它可能和轮次文件失配,而失配时该信谁没有答案。文件的存在性本身就是
 * 状态机:一个轮次都没有 → 等研发端开第一轮(kickoff);instruction 有而 result 无
 * → 等工位端;result 有而 decision 无 → 等研发端裁决;verdict 有 → 结束。
 * 多一条:decision 是 `await-human` 而 human-ack.json 还没出现 → 挂起等人,**两侧都不跑轮**
 * (等人是零成本的;这条不存在时,"等人"表现为研发端一轮轮重复转达同一句请求)。
 * 回执到了就自然回到"result 有而 decision 无"那一格 —— 研发端拿着回执重新裁决同一轮。
 *
 * 工位端**没有项目检出** —— 它的工作目录是一次性的,内容全部来自附件。所以这条邮路
 * 不只是通信,它同时是工位端拿到一切东西(固件、脚本、数据)的唯一途径。
 *
 * ## 写入顺序即协议
 *
 * 工位端一轮的产物里 **result.json 必须最后写**(回传件 `back/*` 与全文 `bench-report.md`
 * 都在它之前);研发端的 decision + 下轮 instruction + 附件必须**同一次提交**。配合
 * sync.ts 的 pullReset(工作树永远等于远端已推的真相),崩溃在任何一步都只会退回
 * "重跑本步",不会出现两边看到的状态互相矛盾 —— 半拷完的 back/ 因为没有 result.json
 * 而整轮不算数,重跑时被同名覆盖。
 */

import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"

// 清单在工程里的相对位置只有一个真源 —— 抄一份的结果会是"研发端读 .yoma/toolchain.json、
// 信箱复制的是别处",而两边都不报错。
import { MANIFEST_RELATIVE } from "@yoma/coding-agent"

import { fileExists, readJsonFile } from "../fsx.ts"

import type { TurnUsage } from "../turn.ts"
import { parseMailboxJob, type MailboxJob } from "./spec.ts"

/**
 * 一件附件。`bytes` 由写入端记下,收件端可以据此核对自己拿到的是不是同一份。
 * 两个方向共用这副形状:下行是 `artifacts/`,上行是 `back/`。
 */
export interface RoundArtifact {
  /** 相对 `artifacts/` 或 `back/` 的路径。下行永远是纯文件名;上行允许带子目录。 */
  name: string
  bytes: number
  /** 来源路径,给人看:下行是研发端仓库里的路径,上行是工位机投递目录里的路径。 */
  from?: string
}

/**
 * 工位端想回传但没送成的东西。**必须让研发端看见** —— 静默丢弃会让它以为"工位端
 * 什么都没给",于是照着一份不存在的证据继续推理。
 */
export interface BackSkipped {
  name: string
  bytes: number
  reason: string
}

export interface RoundInstruction {
  round: number
  /** 交给工位端 agent 的完整指令文本。收件端会在其前面自动附上附件清单。 */
  prompt: string
  issuedBy: "init" | "mother"
  /** 本轮随指令一起穿过来的附件(内容在同目录的 `artifacts/` 下)。 */
  artifacts?: RoundArtifact[]
  at: string
}

/** 轮结果里 turn 的摘要 —— 全量 TurnResult 里对 mother 有用的部分。 */
export interface RoundTurnSummary {
  text: string
  toolCounts: Record<string, number>
  toolErrors: string[]
  usage: TurnUsage
  stopReason?: string
  errors: string[]
  elapsedMs: number
}

/** 研发端在项目仓里为某一轮做的代码改动。相对任务基线,累计。 */
export interface RoundGit {
  baseCommit: string
  headCommit: string
  diffStat: string
  changedFiles: string[]
  commits: string[]
}

export interface RoundResultFile {
  round: number
  sessionID?: string
  turn?: RoundTurnSummary
  /** 本轮附件在工位机上被放到了哪儿(相对工作目录),由调试台落盘、不经模型。 */
  incoming?: string[]
  /** 工位端这一轮回传的文件(内容在同轮的 `back/` 下),由调试台扫投递目录得到。 */
  back?: RoundArtifact[]
  /** 想回传但被上限挡下的。见 BackSkipped —— 它进提示词,不是只进日志。 */
  backSkipped?: BackSkipped[]
  /**
   * 工位端说这一轮卡在一个**人工动作**上(原话)。它只是"报告有这么件事",挂不挂起
   * 由研发端裁决 —— 板子边上的人也许正好在,或者还有不依赖这个动作的活可以先干。
   */
  needsHuman?: string
  /** 工位端跨轮累计的 token(含本轮)。只进终报的参考数字,没有任何门限依赖它。 */
  spentTokens: number
  /** 轮级失败(子进程没产出结果)。有它时 turn 缺失。 */
  error?: string
  at: string
  elapsedMs: number
}

/**
 * `await-human` 不是终局:它是"这一轮到此为止,等一个人去板子边上动手"。
 *
 * 为什么要有它:板子那侧的很多事(接电源、换负载、机械复位)不是任何 agent 能做的。
 * 没有这个值时,研发端唯一能表达"我在等人"的方式是再下发一轮"请转达……",于是
 * 一轮轮空转 —— 实测一次任务里 5 轮有 3 轮是这么烧掉的。挂起是零成本的,重复下发不是。
 */
export type DecisionKind = "continue" | "done" | "fail" | "await-human"

export interface RoundDecision {
  round: number
  /**
   * 裁决者。`mother` = 研发端 agent 真判断过;`policy` = 代码代它写的,只发生在
   * "拿不到它的决定"时(轮执行失败、轮被中断、决定 JSON 重试后仍读不出来)——
   * 那不是裁决,是没法把它的话变成动作。**没有任何门限会产生 policy**(轮数 /
   * token / 墙钟三个上限在 2026-08 一并删了)。裁决者不能伪造。
   */
  by: "mother" | "policy"
  decision: DecisionKind
  /** 研发端的分析自述(policy 裁决时缺省)。 */
  analysis?: string
  reason?: string
  /** `await-human` 时必填:要人去做的那件事,一句人话。它会原样进通知和界面。 */
  ask?: string
  usage?: TurnUsage
  motherSessionID?: string
  /** 研发端为下一轮做的代码改动(它自己提交的)。 */
  git?: RoundGit
  at: string
}

export interface MailboxVerdict {
  outcome: "passed" | "failed"
  reason: string
  rounds: number
  totalRunnerTokens: number
  totalMotherTokens: number
  decidedBy: "mother" | "policy"
  at: string
}

/**
 * 人对一次 `await-human` 的回执。**两台机器都能写** —— 要动手的人多半就站在板子边上,
 * 逼他跑回研发机去点一下毫无道理;信箱是共享的,谁写谁推。
 *
 * `answer: "cannot"` 同样是回执:做不了也是信息,研发端据此换一条不依赖它的路,
 * 总好过继续挂着。
 */
export interface HumanAck {
  answer: "done" | "cannot"
  /** 人补的一句话("电源已设 24V" / "这台没有程控电源")。它会进研发端下一轮的提示词。 */
  note?: string
  /** 谁回的,自愿填(桌面端填机器名/用户名,CLI 填 --by)。 */
  by?: string
  at: string
}

export interface RoundFiles {
  round: number
  instruction?: RoundInstruction
  result?: RoundResultFile
  decision?: RoundDecision
  /** 本轮的人工回执(只在 decision 是 await-human 时有意义)。 */
  humanAck?: HumanAck
}

export type MailboxState =
  | { kind: "done"; verdict: MailboxVerdict }
  /** job.json 在,一个轮次都还没有 —— 等研发端开第一轮(它可能要先改代码、先构建)。 */
  | { kind: "kickoff" }
  | { kind: "awaiting-runner"; round: number; instruction: RoundInstruction }
  | { kind: "awaiting-mother"; round: number; instruction: RoundInstruction; result: RoundResultFile }
  /**
   * 研发端判了 `await-human`,回执还没来。两侧守护看到它都停手 —— 挂起不烧 token,
   * 而"再问一遍"烧。回执一到,状态自己变回 awaiting-mother(见 scanMailbox)。
   */
  | { kind: "awaiting-human"; round: number; ask: string; decision: RoundDecision }
  | { kind: "empty" }
  | { kind: "corrupt"; detail: string }

export interface MailboxSnapshot {
  job?: MailboxJob
  state: MailboxState
  rounds: RoundFiles[]
}

export const JOB_FILE = "job.json"
export const VERDICT_FILE = "verdict.json"
export const REPORT_FILE = "report.md"
/**
 * 项目工具链清单在信箱里的副本。
 *
 * **工位端没有项目检出**,`<工程>/.yoma/toolchain.json` 不在它那儿,于是它对"这台
 * 机器该有什么、缺了怎么装"一无所知 —— 表现是照着指令跑脚本、撞一个
 * ModuleNotFoundError,再把它当成"脚本坏了"报回去。清单本身是项目配置(跟着仓库走、
 * 零绝对路径),所以原样复制一份进信箱是安全的:两台机器读同一份声明,各自对着自己的
 * 账本解析。
 *
 * 放信箱**根**而不是某一轮下面:它不是这一轮的东西,而是整个任务期间都成立的事实。
 * 研发端每次下发轮次时刷新(幂等),于是它中途给清单加一条工具,下一轮工位端就看得到。
 */
export const TOOLCHAIN_FILE = "toolchain.json"

export function roundDir(root: string, round: number): string {
  return path.join(root, "rounds", String(round).padStart(3, "0"))
}

async function readJson<T>(file: string): Promise<T | undefined> {
  if (!(await fileExists(file))) return undefined
  return readJsonFile<T>(file)
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2) + "\n")
}

export function roundArtifactsDir(root: string, round: number): string {
  return path.join(roundDir(root, round), "artifacts")
}

/** 上行的落点。与 `artifacts/` 同级、名字对仗 —— 一眼能看出这一轮两个方向各走了什么。 */
export function roundBackDir(root: string, round: number): string {
  return path.join(roundDir(root, round), "back")
}

/**
 * 工位端本轮自述的**全文**。
 *
 * 提示词里只进节选(见 prompts.ts 的 clipEnds):自述会随会话一轮轮累积,把整篇塞进
 * 上下文等于让第 8 轮还背着前 7 轮的原始日志。全文落成文件、提示词里给路径,研发端
 * 要看细节自己读一次 —— 一次性成本,不进会话历史。
 */
export const ROUND_REPORT_FILE = "bench-report.md"

export function roundReportPath(root: string, round: number): string {
  return path.join(roundDir(root, round), ROUND_REPORT_FILE)
}

export async function writeRoundReport(root: string, round: number, text: string): Promise<void> {
  await mkdir(roundDir(root, round), { recursive: true })
  await writeFile(roundReportPath(root, round), text.endsWith("\n") ? text : `${text}\n`)
}

/** 本轮的人工回执。谁写都行(桌面端按钮 / CLI),写完照常提交推送。 */
export const HUMAN_ACK_FILE = "human-ack.json"

export async function writeHumanAck(root: string, round: number, ack: HumanAck): Promise<void> {
  await writeJson(path.join(roundDir(root, round), HUMAN_ACK_FILE), ack)
}

/**
 * 把研发端的产物拷进本轮的 `artifacts/`。
 *
 * 附件是工位端拿到东西的**唯一**通道 —— 它没有项目检出,新固件、临时脚本、参考数据
 * 全靠这条路过去。agent 在决定里声明要附哪些文件,拷贝由代码做:声明是判断,执行是代码。
 *
 * 大小上限不是不信任 agent,是 git 的物理性质:信箱不忘事,附错一次大文件它会一直大下去。
 * 同名附件后来者覆盖(同一轮里重复声明同一个文件是笔误,不是两件东西)。
 */
export async function attachArtifacts(
  root: string,
  round: number,
  entries: { source: string; name: string; from?: string }[],
  maxBytes: number,
): Promise<{ ok: true; artifacts: RoundArtifact[] } | { ok: false; error: string }> {
  const dir = roundArtifactsDir(root, round)
  const artifacts: RoundArtifact[] = []
  let total = 0
  for (const entry of entries) {
    const bytes = await stat(entry.source)
      .then((info) => info.size)
      .catch(() => undefined)
    if (bytes === undefined) {
      return { ok: false, error: `要附的文件不存在:${entry.from ?? entry.source}(先构建出来再附)` }
    }
    total += bytes
    if (total > maxBytes) {
      return {
        ok: false,
        error:
          `本轮附件合计 ${(total / 1024 / 1024).toFixed(1)}MB,超过上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB —— ` +
          `信箱是个 git 仓,塞进去的大文件永远瘦不回来。只附这一轮真正要用的东西`,
      }
    }
    await mkdir(dir, { recursive: true })
    await copyFile(entry.source, path.join(dir, entry.name))
    artifacts.push({ name: entry.name, bytes, from: entry.from })
  }
  return { ok: true, artifacts }
}

/**
 * 把工位端投递目录里的东西收进本轮的 `back/`。
 *
 * 与 attachArtifacts 有三处不同,都是方向决定的:
 *
 * 1. **超限是跳过,不是错误。** 下行超限该把研发端拦住(它有别的办法把东西送过去);
 *    上行拦住就等于连整轮结果一起毙掉 —— 板子上跑出来的现象比那个大文件贵得多。
 *    跳过的进 `backSkipped`,让研发端看得见"它想给我但没给成"。
 * 2. **允许子目录。** 工位端的采集脚本自然会写出 `capture/ch2.csv` 这种形状,
 *    逼它拍平只会换来一堆重名。
 * 3. **没有"声明"这一步。** 扫目录是确定性动作,不经模型(见文件头)。
 */
export async function collectBack(
  root: string,
  round: number,
  entries: { source: string; name: string }[],
  maxBytes: number,
): Promise<{ back: RoundArtifact[]; skipped: BackSkipped[] }> {
  const dir = roundBackDir(root, round)
  const back: RoundArtifact[] = []
  const skipped: BackSkipped[] = []
  let total = 0
  for (const entry of entries) {
    const bytes = await stat(entry.source)
      .then((info) => info.size)
      .catch(() => undefined)
    if (bytes === undefined) {
      skipped.push({ name: entry.name, bytes: 0, reason: "读不到这个文件(被删了?还在写?)" })
      continue
    }
    if (total + bytes > maxBytes) {
      skipped.push({
        name: entry.name,
        bytes,
        reason:
          `本轮回传合计会超过上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB —— ` +
          `信箱是个 git 仓,进去的大文件永远瘦不回来。先抽样/压缩再回传`,
      })
      continue
    }
    total += bytes
    const target = path.join(dir, entry.name)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(entry.source, target)
    back.push({ name: entry.name, bytes, from: entry.name })
  }
  return { back, skipped }
}

/** 一轮的输入是一整包:指令 + 补丁 + 附件。instruction.json 最后写。 */
export async function writeInstruction(
  root: string,
  instruction: RoundInstruction,
  extras?: { patch?: string },
): Promise<void> {
  const dir = roundDir(root, instruction.round)
  await mkdir(dir, { recursive: true })
  if (extras?.patch !== undefined) await writeFile(path.join(dir, "patch.diff"), extras.patch)
  await writeJson(path.join(dir, "instruction.json"), instruction)
}

/**
 * 把研发端检出里的工具链清单复制进信箱根。返回是否写了。
 *
 * 项目没有清单是常态(绝大多数项目根本没声明工具链),那就什么都不做 —— 也**不删**
 * 信箱里已有的那份:删了等于让工位端在某一轮突然失明,而"清单文件这轮读不到"更可能是
 * 研发端工作树的临时状态,不是"这个项目不再需要工具了"。
 */
export async function syncToolchainManifest(root: string, workspace: string): Promise<boolean> {
  const source = path.join(workspace, MANIFEST_RELATIVE)
  const text = await readFile(source, "utf8").catch(() => undefined)
  if (text === undefined) return false
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, TOOLCHAIN_FILE), text)
  return true
}

/** 读信箱里的清单原文,交给工位端的 `resolveToolchain({ manifestText })`。 */
export async function readToolchainManifest(root: string): Promise<string | undefined> {
  return readFile(path.join(root, TOOLCHAIN_FILE), "utf8").catch(() => undefined)
}

/** 旁证先落盘,result.json 最后写 —— 它的存在就是"本轮完成"的信号。 */
export async function writeRoundResult(root: string, result: RoundResultFile): Promise<void> {
  await writeJson(path.join(roundDir(root, result.round), "result.json"), result)
}

export async function writeDecision(root: string, decision: RoundDecision): Promise<void> {
  await writeJson(path.join(roundDir(root, decision.round), "decision.json"), decision)
}

export async function writeVerdict(root: string, verdict: MailboxVerdict, report?: string): Promise<void> {
  if (report !== undefined) await writeFile(path.join(root, REPORT_FILE), report)
  await writeJson(path.join(root, VERDICT_FILE), verdict)
}

export async function readVerdict(root: string): Promise<MailboxVerdict | undefined> {
  return readJson<MailboxVerdict>(path.join(root, VERDICT_FILE))
}

async function listRoundNumbers(root: string): Promise<number[]> {
  const entries = await readdir(path.join(root, "rounds"), { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{3}$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b)
}

export async function readRound(root: string, round: number): Promise<RoundFiles> {
  const dir = roundDir(root, round)
  // 四个读互不依赖,一批发出去 —— 文件都不在(kickoff 之前)时尤其明显。
  const [instruction, result, decision, humanAck] = await Promise.all([
    readJson<RoundInstruction>(path.join(dir, "instruction.json")),
    readJson<RoundResultFile>(path.join(dir, "result.json")),
    readJson<RoundDecision>(path.join(dir, "decision.json")),
    readJson<HumanAck>(path.join(dir, HUMAN_ACK_FILE)),
  ])
  return { round, instruction, result, decision, humanAck }
}

/**
 * 扫出信箱全貌。损坏(JSON 不合法、指令缺失)报 corrupt 而不是抛 —— 守护进程的
 * 轮询循环不该被一个坏文件打死,它要把 detail 打给人看然后停在原地。
 */
export async function scanMailbox(root: string): Promise<MailboxSnapshot> {
  let job: MailboxJob | undefined
  try {
    const rawJob = await readJson<unknown>(path.join(root, JOB_FILE))
    if (rawJob) job = parseMailboxJob(rawJob)
  } catch (error) {
    return { state: { kind: "corrupt", detail: `job.json 读不出来:${(error as Error).message}` }, rounds: [] }
  }

  try {
    const verdict = await readVerdict(root)
    const numbers = await listRoundNumbers(root)
    const rounds = await Promise.all(numbers.map((number) => readRound(root, number)))

    if (verdict) return { job, state: { kind: "done", verdict }, rounds }
    if (!job) return { state: { kind: "empty" }, rounds }
    // job 在但零轮次:第一轮指令由研发端出(它先看任务书,可能先改代码再附上产物)。
    // 老版本由 init 直接写死第一轮"只复现取证",那等于把开局的判断从 agent 手里拿走。
    if (rounds.length === 0) return { job, state: { kind: "kickoff" }, rounds }

    const last = rounds[rounds.length - 1]!
    if (!last.instruction) {
      return { job, state: { kind: "corrupt", detail: `轮 ${last.round} 有目录但没有 instruction.json` }, rounds }
    }
    // 挂起先于"等研发端裁决":这一轮它已经裁过了(结论是"等人"),回执没来之前
    // 再叫它一次只会得到同一句话。回执一到,这个 if 不成立,状态自动落回下面那格,
    // 研发端拿着回执重新裁决同一轮 —— 挂起因此不需要任何额外的唤醒机制。
    if (last.decision?.decision === "await-human" && !last.humanAck) {
      return {
        job,
        state: {
          kind: "awaiting-human",
          round: last.round,
          ask: last.decision.ask ?? last.decision.reason ?? "(研发端没写清要人做什么)",
          decision: last.decision,
        },
        rounds,
      }
    }
    if (last.result) {
      return { job, state: { kind: "awaiting-mother", round: last.round, instruction: last.instruction, result: last.result }, rounds }
    }
    return { job, state: { kind: "awaiting-runner", round: last.round, instruction: last.instruction }, rounds }
  } catch (error) {
    return { job, state: { kind: "corrupt", detail: `信箱扫描失败:${(error as Error).message}` }, rounds: [] }
  }
}

/** mother 跨轮累计花费:从历轮 decision 汇总。runner 的累计走 result.spentTokens。 */
export function sumMotherTokens(rounds: RoundFiles[]): number {
  let total = 0
  for (const { decision } of rounds) {
    if (!decision?.usage) continue
    total += decision.usage.tokens.input + decision.usage.tokens.output
  }
  return total
}
