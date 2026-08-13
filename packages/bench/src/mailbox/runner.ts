/**
 * 工位端 —— 板子所在那台机器上的常驻执行者。
 *
 * 每次轮询一步:同步信箱 → 推断状态 → 该干活就干一轮 → 结果回填并推送。
 *
 * ## 这一侧没有项目代码
 *
 * 工作目录是一个**一次性目录**,内容全部来自信箱:研发端每轮附过来的固件、脚本、
 * 数据落在这里,别的什么都没有。工位端读不到源码,它需要的背景由研发端写进指令
 * (见 prompts.ts 的两条话术纪律)。
 *
 * 于是这一侧不需要 git、不需要构建工具链、不需要工作树干净 —— 它就是一台连着板子的
 * 机器加一个信箱克隆。**工作目录必须在克隆之外**:`pullReset` 的 `clean -fd` 会把
 * 克隆里的一切非跟踪文件清掉,附件放在里面等于每轮被自己删一次。
 *
 * ## 一轮做什么
 *
 * 领指令与附件 → 调试台把附件落进工作目录(确定性动作,不经模型)→ 组提示词
 * (角色说明 + 附件清单 + 研发端指令)→ 子进程跑一轮 agent(探针清理靠进程边界)→
 * 收投递目录 → result 回填信箱。
 *
 * **怎么把新固件弄上板由 agent 自己定** —— 附件 + 一句人话就是全部机制。
 *
 * ## 投递目录:这一侧唯一的上行通道
 *
 * 工作目录下的 `outbox/` 是约定:agent 往里丢什么,调试台就把什么收进本轮的 `back/`
 * 送回研发端。**扫目录不经模型** —— 它是唯一挨着板子的一侧,给它加一个"必须写出
 * 可解析结构"的契约,等于在最不该失败的地方多一个解析失败模式。
 *
 * 收完就把文件移进 `outbox/.sent/NNN/`:不删(工位机本地留底,现场要复看),又保证
 * 下一轮不会把同一份数据再传一次。
 *
 * `outbox/ASK-HUMAN.txt` 是同一条通道上的特例:它不当附件传,而是抬成
 * `result.needsHuman` —— "这一轮卡在一个人得去板子边上做的动作上"。挂不挂起由研发端
 * 裁决(见 store.ts 的 DecisionKind)。
 *
 * ## 本地状态
 *
 * `<workRoot>/<jobId>/session.json` 只存会话指针。跨轮的 token 累计不落地 ——
 * 它只进终报,真相是信箱里每轮 result 的 `spentTokens`(累计值)。
 */

import { copyFile, mkdir, readdir, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"

import type { FauxScript } from "../faux.ts"
import { fileExists, readJsonFile } from "../fsx.ts"
import type * as git from "../git.ts"
import { runRoleDaemon } from "./daemon.ts"
import { runTurnInChildProcess, type TurnInput } from "../runner.ts"
import type { TurnResult } from "../turn.ts"
import { benchRolePrompt, runnerRoundPrompt } from "./prompts.ts"
import {
  collectBack,
  readToolchainManifest,
  roundArtifactsDir,
  scanMailbox,
  writeJson,
  writeRoundReport,
  writeRoundResult,
  type BackSkipped,
  type MailboxVerdict,
  type RoundArtifact,
  type RoundFiles,
  type RoundInstruction,
  type RoundResultFile,
} from "./store.ts"
import { commitPush, flushThenPullReset, type MailboxSyncContext } from "./sync.ts"
import type { MailboxJob } from "./spec.ts"

export interface MailboxRunnerOptions {
  /** 信箱克隆目录。 */
  clone: string
  branch?: string
  sessionsRoot: string
  /**
   * 工位端一次性工作目录的根。缺省是克隆的**兄弟**目录 —— 绝不能落在克隆里面,
   * `pullReset` 的 `clean -fd` 会把附件连同本地状态一起清掉。
   */
  workRoot?: string
  enginesDir?: string
  /** 打包态的 turn 子进程入口(见 TurnInput.turnEntry)。bun 开发态可缺省。 */
  turnEntry?: string
  /** 技能/上下文/凭据全局目录;演练与测试传临时目录隔离,生产缺省 ~/.my-pi。 */
  configDir?: string
  /** 本机演练的假模型脚本,按轮取 `fauxTurns[round-1]`。生产不传。 */
  fauxTurns?: FauxScript[]
  onProgress?: (message: string) => void
  /** 测试注入:替换子进程轮。 */
  runTurn?: (input: TurnInput, handlers: { onProgress?: (message: string) => void }) => Promise<TurnResult>
  gitRun?: git.GitRunner
  now?: () => number
}

export type RunnerStepOutcome =
  | { kind: "idle"; detail: string }
  | { kind: "ran"; round: number; error?: string }
  | { kind: "finalized"; verdict: MailboxVerdict }
  /** 挂起等人。工位机上多半就站着那个人 —— 这一侧的宿主要能把它显示出来。 */
  | { kind: "awaiting-human"; round: number; ask: string }
  | { kind: "blocked"; detail: string }

const RUNNER_AUTHOR = { name: "yoma-mailbox-runner", email: "bench@yoma.local" }

/** 工作目录下的投递目录(上行);`.sent/` 是收过的存档,扫描时跳过。 */
const OUTBOX_DIR = "outbox"
const SENT_DIR = ".sent"
/** 投递目录里的特例文件:它不当附件传,而是抬成"这轮卡在一个人工动作上"。 */
const ASK_HUMAN_FILE = "ask-human.txt"
/** 人工请求进通知和界面,长了没法看;截断只影响转达,原文仍在 .sent 里。 */
const ASK_MAX_CHARS = 4000

function syncContext(options: MailboxRunnerOptions): MailboxSyncContext {
  return { clone: options.clone, branch: options.branch, author: RUNNER_AUTHOR, run: options.gitRun }
}

/** 工位端这个任务的私有目录:工作区 + 会话指针。**在信箱克隆之外**(见文件头)。 */
function jobRoot(clone: string, workRoot: string | undefined, jobId: string): string {
  return path.join(workRoot ?? path.join(path.dirname(clone), "work"), jobId)
}


interface RunnerLocalState {
  sessionID?: string
}

async function readLocalState(root: string): Promise<RunnerLocalState> {
  const file = path.join(root, "session.json")
  if (!(await fileExists(file))) return {}
  return (await readJsonFile<RunnerLocalState>(file).catch(() => undefined)) ?? {}
}

async function saveLocalState(root: string, state: RunnerLocalState): Promise<void> {
  await writeJson(path.join(root, "session.json"), state)
}

/**
 * 把本轮附件从信箱拷进工作目录。
 *
 * **不清空目录**:某一轮没带附件不代表旧固件失效 —— 板子上跑的还是它。同名覆盖即可,
 * 那才是"新版本替换旧版本"的语义。
 */
async function stageIncoming(clone: string, round: number, workspace: string): Promise<string[]> {
  const source = roundArtifactsDir(clone, round)
  const entries = await readdir(source, { withFileTypes: true }).catch(() => [])
  const files = entries.filter((entry) => entry.isFile())
  if (!files.length) return []
  await mkdir(workspace, { recursive: true })
  const staged: string[] = []
  for (const file of files) {
    await copyFile(path.join(source, file.name), path.join(workspace, file.name))
    staged.push(file.name)
  }
  return staged
}

function outboxDir(workspace: string): string {
  return path.join(workspace, OUTBOX_DIR)
}

/** 投递目录里的文件,相对路径(posix 分隔)。跳过 `.sent/` 存档,排序保证轮与轮之间可比。 */
async function listOutbox(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const entry of entries) {
    if (entry.name === SENT_DIR) continue
    const next = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...(await listOutbox(root, next)))
    else if (entry.isFile()) found.push(next)
  }
  return found.sort()
}

/**
 * 归档一件收过的投递物:移进 `.sent/<轮次>[-skipped]/`。
 *
 * **移而不删** —— 工位机上留底,现场要复看采集原文;而留在 outbox 里会被下一轮再收一次。
 * 移不动(占用中、跨卷)时退成复制+删,再不行就只报告不失败:一件归档失败不该把
 * 整轮结果毙掉,代价只是下一轮重传一次。
 */
async function archiveSent(root: string, relative: string, bucket: string, progress: (m: string) => void): Promise<void> {
  const source = path.join(root, relative)
  const target = path.join(root, SENT_DIR, bucket, relative)
  await mkdir(path.dirname(target), { recursive: true })
  try {
    await rename(source, target)
  } catch {
    try {
      await copyFile(source, target)
      await rm(source, { force: true })
    } catch (error) {
      progress(`⚠ 归档 ${relative} 失败(下一轮会重传一次):${(error as Error).message}`)
    }
  }
}

/**
 * 收投递目录 —— 上行的全部机制。
 *
 * ASK-HUMAN 抬成人工请求(不当附件传),其余收进本轮 `back/`;超限的按 collectBack
 * 的规矩跳过并记账。
 *
 * **归档不在这里做**,而是交回一个 `archive()` 给调用方在**推送成功之后**调。
 * 顺序反了会丢数据:推送失败时下一次轮询的 `pullReset`(`clean -fd`)会把还没提交的
 * `back/` 连同 result.json 一起抹掉,而投递目录这时已经空了 —— 那一轮的采集就再也
 * 回不去研发端了(文件还在工位机的 .sent 里,但闭环看不见)。
 */
async function collectOutbox(
  clone: string,
  round: number,
  workspace: string,
  maxBytes: number,
  progress: (m: string) => void,
): Promise<{
  back?: RoundArtifact[]
  backSkipped?: BackSkipped[]
  needsHuman?: string
  archive: () => Promise<void>
}> {
  const noop = { archive: async () => {} }
  const root = outboxDir(workspace)
  const names = await listOutbox(root)
  if (!names.length) return noop

  const askName = names.find((name) => path.basename(name).toLowerCase() === ASK_HUMAN_FILE)
  let needsHuman: string | undefined
  if (askName) {
    const text = (await readFile(path.join(root, askName), "utf8").catch(() => "")).trim()
    needsHuman = text ? text.slice(0, ASK_MAX_CHARS) : undefined
    if (!needsHuman) progress(`⚠ ${askName} 是空的 —— 没东西可转达,当它不存在`)
  }

  const entries = names
    .filter((name) => name !== askName)
    .map((name) => ({ source: path.join(root, name), name }))
  const { back, skipped } = await collectBack(clone, round, entries, maxBytes)

  const bucket = String(round).padStart(3, "0")
  const archive = async () => {
    for (const item of back) await archiveSent(root, item.name, bucket, progress)
    // 跳过的也归档:留在投递目录里只会每一轮重报一次同样的"超限",而它已经记进结果了。
    for (const item of skipped) await archiveSent(root, item.name, `${bucket}-skipped`, progress)
    if (askName) await archiveSent(root, askName, bucket, progress)
  }

  if (back.length) progress(`回传 ${back.length} 件:${back.map((item) => item.name).join("、")}`)
  if (skipped.length) progress(`⚠ ${skipped.length} 件没送成(超上限),已记进本轮结果`)
  if (needsHuman) progress(`工位端请求人工动作:${needsHuman.split("\n")[0]}`)

  return {
    back: back.length ? back : undefined,
    backSkipped: skipped.length ? skipped : undefined,
    needsHuman,
    archive,
  }
}

/** 工位端的跨轮累计 = 最近一轮 result 的 spentTokens(它本身就是累计值,**不求和** —— 与 sumMotherTokens 相反)。为什么不落地见文件头「本地状态」。 */
function runnerTokensSoFar(rounds: RoundFiles[]): number {
  for (const entry of [...rounds].reverse()) {
    if (entry.result) return entry.result.spentTokens
  }
  return 0
}

/** 轮询一步。守护进程就是"这个函数 → 睡一觉"的循环。 */
export async function runnerStep(options: MailboxRunnerOptions): Promise<RunnerStepOutcome> {
  const progress = (message: string) => options.onProgress?.(message)

  // 同步失败要走 blocked 而不是裸抛:守护对 blocked 有指数退避,而未捕获的异常会一路
  // 冒到守护循环外面。"克隆停在别的分支""远端只读""网断了"都是这一类。
  try {
    await flushThenPullReset(syncContext(options))
  } catch (error) {
    return { kind: "blocked", detail: (error as Error).message }
  }
  const snapshot = await scanMailbox(options.clone)

  if (snapshot.state.kind === "corrupt") return { kind: "blocked", detail: snapshot.state.detail }
  if (snapshot.state.kind === "empty") return { kind: "idle", detail: "信箱还没有任务(等 init)" }
  if (!snapshot.job) return { kind: "blocked", detail: "有轮次但没有 job.json —— 信箱不完整" }
  if (snapshot.state.kind === "kickoff") return { kind: "idle", detail: "等研发端下发第一轮指令" }
  if (snapshot.state.kind === "done") return { kind: "finalized", verdict: snapshot.state.verdict }
  if (snapshot.state.kind === "awaiting-mother") {
    return { kind: "idle", detail: `第 ${snapshot.state.round} 轮结果已回填,等研发端处理` }
  }
  // 挂起等人。这一侧尤其要把它显示出来:要动手的人多半就站在这台机器旁边。
  if (snapshot.state.kind === "awaiting-human") {
    return { kind: "awaiting-human", round: snapshot.state.round, ask: snapshot.state.ask }
  }

  return runRound(options, snapshot.job, snapshot.state.instruction, snapshot.rounds, progress)
}

async function runRound(
  options: MailboxRunnerOptions,
  mailboxJob: MailboxJob,
  instruction: RoundInstruction,
  rounds: RoundFiles[],
  progress: (message: string) => void,
): Promise<RunnerStepOutcome> {
  const job = mailboxJob.job
  const now = options.now ?? Date.now
  const started = now()
  const sync = syncContext(options)
  const round = instruction.round
  const root = jobRoot(options.clone, options.workRoot, job.id)
  const workspace = runnerWorkspaceFor(options.clone, options.workRoot, job.id)
  let sessionID = (await readLocalState(root)).sessionID
  const spentBefore = runnerTokensSoFar(rounds)

  progress(`─── 信箱轮 ${round} ───`)

  const finishWithError = async (error: string): Promise<RunnerStepOutcome> => {
    await writeRoundResult(options.clone, {
      round,
      sessionID,
      spentTokens: spentBefore,
      error,
      at: new Date(started).toISOString(),
      elapsedMs: now() - started,
    })
    const pushed = await commitPush(sync, `round ${round}: 工位端失败回填 —— ${error.slice(0, 80)}`)
    if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "结果推不上去" }
    return { kind: "ran", round, error }
  }

  await mkdir(workspace, { recursive: true })
  // 投递目录先建出来:提示词里写了它,但一个不存在的目录很容易被读成"这条路没开"。
  await mkdir(outboxDir(workspace), { recursive: true })
  const incoming = await stageIncoming(options.clone, round, workspace)
  if (incoming.length) progress(`本轮附件已就位:${incoming.join("、")}`)

  // 工具链清单:研发端每轮随指令推过来,这一侧读原文灌进子进程。没有就算了 ——
  // 项目没声明工具链是常态,那条路径必须完全静默。
  const toolchainManifestText = await readToolchainManifest(options.clone)
  if (toolchainManifestText) progress("按工位端(runner)一侧核对工具链")

  const input: TurnInput = {
    job,
    workspace,
    sessionsRoot: options.sessionsRoot,
    stateDir: path.join(root, "state"),
    enginesDir: options.enginesDir,
    sessionID,
    prompt: runnerRoundPrompt(instruction, {
      role: sessionID ? undefined : benchRolePrompt(job, workspace),
      incoming,
    }),
    turnEntry: options.turnEntry,
    configDir: options.configDir,
    // 这一侧只有板子:核编译器毫无意义,而清单里那几条会一路报 MISSING 盖住真正缺的那条。
    toolchainSide: "runner",
    toolchainManifestText,
    faux: options.fauxTurns?.[round - 1],
  }

  let turn: TurnResult
  try {
    turn = await (options.runTurn ?? runTurnInChildProcess)(input, { onProgress: progress })
  } catch (error) {
    // 会话可能已不在(sessionsRoot 被清、桌面端删了会话)。丢掉延续指针,下一轮重开。
    await saveLocalState(root, {})
    return finishWithError(`agent 轮执行失败:${(error as Error).message}`)
  }

  sessionID = turn.sessionID
  await saveLocalState(root, { sessionID })
  const spentAfter = spentBefore + turn.usage.tokens.input + turn.usage.tokens.output

  // 旁证先落盘,result.json 最后写(见 store.ts 的「写入顺序即协议」):回传件与全文
  // 半途崩了,这一轮因为没有 result.json 而整个不算数,重跑时被同名覆盖。
  const collected = await collectOutbox(
    options.clone,
    round,
    workspace,
    mailboxJob.mailbox.maxBackBytes,
    progress,
  )
  if (turn.text) await writeRoundReport(options.clone, round, turn.text)

  const result: RoundResultFile = {
    round,
    sessionID,
    turn: {
      text: turn.text,
      toolCounts: countTools(turn),
      toolErrors: turn.toolCalls.filter((call) => call.error).map((call) => `${call.tool}: ${call.error}`),
      usage: turn.usage,
      stopReason: turn.stopReason,
      errors: turn.errors,
      elapsedMs: turn.elapsedMs,
    },
    incoming: incoming.length ? incoming : undefined,
    back: collected.back,
    backSkipped: collected.backSkipped,
    needsHuman: collected.needsHuman,
    spentTokens: spentAfter,
    at: new Date(started).toISOString(),
    elapsedMs: now() - started,
  }

  await writeRoundResult(options.clone, result)
  const pushed = await commitPush(sync, `round ${round}: ${turn.stopReason ?? "工位端已回填"}`)
  if (!pushed.pushed) return { kind: "blocked", detail: pushed.detail ?? "结果推不上去" }
  // 推上去了才归档投递目录:在此之前投递目录就是这一轮的底稿,重跑要靠它(见 collectOutbox)。
  await collected.archive()
  return { kind: "ran", round }
}

function countTools(turn: TurnResult): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const call of turn.toolCalls) counts[call.tool] = (counts[call.tool] ?? 0) + 1
  return counts
}

/** 常驻循环。`once` 给测试和 cron 场景(锁保证 cron 重叠时后来者干净退出)。 */
export async function runMailboxRunner(
  options: MailboxRunnerOptions & {
    pollSeconds: number
    once?: boolean
    /** 每步之后回调一次(含终局那步)。桌面端守护入口靠它发结构化事件。 */
    onStep?: (outcome: RunnerStepOutcome) => void
  },
): Promise<RunnerStepOutcome> {
  return runRoleDaemon<RunnerStepOutcome>({
    clone: options.clone,
    role: "runner",
    pollSeconds: options.pollSeconds,
    once: options.once,
    step: () => runnerStep(options),
    blocked: (detail) => ({ kind: "blocked", detail }),
    terminalKind: "finalized",
    onStep: options.onStep,
    onProgress: options.onProgress,
  })
}

/** 给宿主(桌面端/CLI)用:这个任务在本机的工作目录。会话回放的路由要它。 */
export function runnerWorkspaceFor(clone: string, workRoot: string | undefined, jobId: string): string {
  return path.join(jobRoot(clone, workRoot, jobId), "work")
}
