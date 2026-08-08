/**
 * 信箱守护的宿主逻辑 —— 桌面端产品形态的引擎侧入口。
 *
 * 桌面端 main 进程 spawn 打包产物 `mailbox-host.mjs <config.json>`(薄壳在
 * host-entry.ts),本文件是壳下面可测的全部逻辑。五个角色一个入口:
 *
 * - `runner` / `mother`:今天 CLI 里的那两个常驻守护,一字不差地复用;
 * - `init`:任务入箱(校验 spec → 写 job.json → 下发第 1 轮指令),一次性;
 * - `status`:扫一眼信箱发快照就退,给 UI 拿初始状态;
 * - `sim`:本机演练 —— 复用 sim 引擎,**以自身为入口自我 spawn** 两个角色子进程,
 *   于是演练走的就是生产的那条打包代码路径,不是一条"演练专用"的旁路。
 *
 * ## 事件协议:stdout 上的 `@@event {json}` 行
 *
 * 与 turn-entry 的 `@@escalate` 同款小而蠢:进程输出即事件,main 逐行解析转发给
 * renderer。事件与错误全是**普通对象** —— 它们最终要过 contextBridge,Error 在那道
 * 序列化边界会被剥得只剩 message(根 CLAUDE.md"会咬人的地方")。
 *
 * ## 快照的口径
 *
 * snapshot 事件是**裁剪过的** UI 视图(长文本截断、去掉与轮次重复的 state 载荷),
 * 完整真相永远在信箱文件与两侧会话里 —— UI 要细节就打开会话观战,不靠事件流搬运。
 */

import { spawn, type ChildProcess } from "node:child_process"
import { writeFileSync } from "node:fs"
import path from "node:path"

import type { FauxScript } from "../faux.ts"
import { fauxResolveModels } from "../faux.ts"
import { readTextFile } from "../fsx.ts"
import type { GradeResult } from "../grader.ts"
import { initMailbox } from "./init.ts"
import { loadMailboxJob } from "./spec.ts"
import { runMailboxMother, type MotherStepOutcome } from "./mother.ts"
import { runMailboxRunner, type RunnerStepOutcome } from "./runner.ts"
import { runSim } from "./sim.ts"
import { REPORT_FILE, scanMailbox, type MailboxSnapshot, type MailboxVerdict, type RoundFiles } from "./store.ts"
import { ensureClone } from "./sync.ts"

export type MailboxHostRole = "runner" | "mother" | "init" | "status" | "sim"

export interface MailboxHostConfig {
  role: MailboxHostRole
  /** 信箱克隆目录(runner/mother/init/status)。 */
  clone?: string
  /** git 远端。给了就 ensureClone(缺克隆则建,origin 不符则报错);sim 里是演练远端。 */
  remote?: string
  branch?: string
  pollSeconds?: number
  once?: boolean
  /** 会话 JSONL 根(桌面端传 userData/sessions,回放观战靠它)。runner/mother/sim 必填。 */
  sessionsRoot?: string
  enginesDir?: string
  /** 技能/上下文/凭据全局目录。生产不传(默认 ~/.my-pi);演练与测试传临时目录。 */
  configDir?: string
  /** 打包态 turn 子进程入口(mailbox-turn-entry.mjs 绝对路径)。非 bun 运行时必填。 */
  turnEntry?: string
  /** sim 自我 spawn 的宿主入口。缺省 process.argv[1](host-entry 场景天然正确)。 */
  hostEntry?: string
  /** init/sim:任务书 JSON 路径。 */
  jobFile?: string
  /** sim:模拟根目录。 */
  root?: string
  /** sim:墙钟上限(分钟),缺省取 job.budget.wallClockMin。 */
  timeoutMin?: number
  /** sim:清掉上次演练从头来。 */
  fresh?: boolean
  /** 假模型脚本(本机演练/冒烟):runner 按轮取 turns[round-1],mother 整段一条队列。 */
  faux?: { turns?: FauxScript[]; mother?: FauxScript }
}

/** 与轮次载荷解耦的轻状态 —— 重载荷(指令/结果)在 rounds 里,不重复搬。 */
export type MailboxUiState =
  | { kind: "empty" }
  | { kind: "corrupt"; detail: string }
  | { kind: "awaiting-runner"; round: number }
  | { kind: "awaiting-mother"; round: number }
  | { kind: "done"; verdict: MailboxVerdict }

export interface MailboxUiSnapshot {
  state: MailboxUiState
  job?: { id: string; title: string; directory: string; maxRounds: number; maxTokens: number; wallClockMin: number }
  rounds: RoundFiles[]
  /** 终局后附上的 report.md 原文(截断过)—— 终报页直接渲染,不再回信箱取。 */
  report?: string
}

export type MailboxHostEvent =
  | { type: "hello"; role: MailboxHostRole; pid: number }
  | { type: "progress"; message: string }
  | { type: "step"; outcome: RunnerStepOutcome | MotherStepOutcome }
  | { type: "snapshot"; snapshot: MailboxUiSnapshot }
  /** sim 角色转发的两个子进程的结构化事件(它们各自也说 @@event)。 */
  | { type: "child"; role: "runner" | "mother"; event: MailboxHostEvent }
  | { type: "done"; exitCode: number; detail: string; verdict?: MailboxVerdict }

export type EmitMailboxEvent = (event: MailboxHostEvent) => void

/** 跑一个角色到自然终点,返回进程退出码。done 事件由这里统一发。 */
export async function runMailboxHost(config: MailboxHostConfig, emit: EmitMailboxEvent): Promise<number> {
  emit({ type: "hello", role: config.role, pid: process.pid })
  const progress = (message: string) => emit({ type: "progress", message })
  const branch = config.branch ?? "main"

  const finish = (exitCode: number, detail: string, verdict?: MailboxVerdict): number => {
    emit({ type: "done", exitCode, detail, verdict })
    return exitCode
  }

  if (config.role === "sim") {
    const result = await runSim({
      jobFile: required(config.jobFile, "jobFile"),
      root: config.root,
      remote: config.remote,
      branch,
      pollSeconds: config.pollSeconds,
      timeoutMin: config.timeoutMin,
      fresh: config.fresh,
      onOutput: (line) => {
        // 子进程的 @@event 行升格成结构化 child 事件,其余原样当进度转发。
        const match = /^\[(runner|mother)\] @@event (.*)$/.exec(line)
        if (match) {
          try {
            emit({ type: "child", role: match[1] as "runner" | "mother", event: JSON.parse(match[2]!) as MailboxHostEvent })
            return
          } catch {
            // 掉进普通进度行,别丢内容。
          }
        }
        progress(line)
      },
      spawnRole: selfSpawn(config),
    })
    return finish(result.exitCode, result.detail, result.verdict)
  }

  const clone = path.resolve(required(config.clone, "clone"))
  if (config.remote) await ensureClone(config.remote, clone, { branch })
  const emitSnapshot = makeSnapshotEmitter(clone, emit)

  if (config.role === "status") {
    await emitSnapshot()
    return finish(0, "快照已发")
  }

  if (config.role === "init") {
    const mailboxJob = await loadMailboxJob(required(config.jobFile, "jobFile"))
    const outcome = await initMailbox({ clone, branch, mailboxJob })
    await emitSnapshot()
    return finish(outcome.initialized ? 0 : 1, outcome.detail)
  }

  if (config.role === "runner") {
    const outcome = await runMailboxRunner({
      clone,
      branch,
      sessionsRoot: required(config.sessionsRoot, "sessionsRoot"),
      enginesDir: config.enginesDir,
      configDir: config.configDir,
      turnEntry: config.turnEntry,
      fauxTurns: config.faux?.turns,
      pollSeconds: config.pollSeconds ?? 15,
      once: config.once,
      onProgress: progress,
      onStep: (step) => {
        emit({ type: "step", outcome: step })
        void emitSnapshot()
      },
    })
    await emitSnapshot(true)
    if (outcome.kind === "finalized") {
      return finish(outcome.verdict.outcome === "passed" ? 0 : 2, `终局 ${outcome.verdict.outcome}`, outcome.verdict)
    }
    if (outcome.kind === "blocked") return finish(3, outcome.detail)
    return finish(0, outcome.kind === "ran" ? `第 ${outcome.round} 轮已回填` : outcome.detail)
  }

  const outcome = await runMailboxMother({
    clone,
    branch,
    sessionsRoot: required(config.sessionsRoot, "sessionsRoot"),
    configDir: config.configDir,
    resolveModels: config.faux?.mother ? fauxResolveModels(config.faux.mother) : undefined,
    pollSeconds: config.pollSeconds ?? 15,
    once: config.once,
    onProgress: progress,
    onStep: (step) => {
      emit({ type: "step", outcome: step })
      void emitSnapshot()
    },
  })
  await emitSnapshot(true)
  if (outcome.kind === "done") {
    return finish(outcome.verdict.outcome === "passed" ? 0 : 2, `终局 ${outcome.verdict.outcome}`, outcome.verdict)
  }
  if (outcome.kind === "blocked") return finish(3, outcome.detail)
  return finish(0, outcome.kind === "decided" ? `第 ${outcome.round} 轮已裁决` : outcome.detail)
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === "") throw new Error(`守护配置缺 ${name}`)
  return value as T
}

/**
 * sim 的自我 spawn:两个角色子进程用同一个宿主入口、各自一份配置文件。
 * 演练与生产因此是同一条代码路径 —— 差别只剩远端是本地裸仓还是真仓库。
 */
function selfSpawn(config: MailboxHostConfig) {
  return (role: "runner" | "mother", clone: string, context: { root: string; branch: string; pollSeconds: number }): ChildProcess => {
    const hostEntry = config.hostEntry ?? process.argv[1]
    if (!hostEntry) throw new Error("sim 自我 spawn 需要 hostEntry(process.argv[1] 不可用时必须显式传)")
    const childConfig: MailboxHostConfig = {
      role,
      clone,
      branch: context.branch,
      pollSeconds: context.pollSeconds,
      sessionsRoot: config.sessionsRoot,
      enginesDir: config.enginesDir,
      configDir: config.configDir,
      turnEntry: config.turnEntry,
      hostEntry,
      faux:
        role === "runner"
          ? config.faux?.turns
            ? { turns: config.faux.turns }
            : undefined
          : config.faux?.mother
            ? { mother: config.faux.mother }
            : undefined,
    }
    const file = path.join(context.root, `host-${role}.json`)
    writeFileSync(file, JSON.stringify(childConfig, null, 2) + "\n")
    return spawn(process.execPath, [hostEntry, file], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: context.root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    })
  }
}

/**
 * 快照发射器:去重(内容不变不发)、防重入(扫描在飞就跳过,下一步会再扫)。
 *
 * `force` 是给**终局那一发**用的:守护循环最后一步的 onStep 会 `void emitSnapshot()`,
 * 那次扫描往往还在飞,循环就返回了 —— 收尾的 `await emitSnapshot()` 撞上防重入门
 * 直接空转,于是"带 verdict 与终报的最后一张快照"永远发不出去,UI 停在倒数第二张。
 * force 会等在飞的那次跑完再扫一遍,保证终局状态一定送达。
 */
function makeSnapshotEmitter(clone: string, emit: EmitMailboxEvent): (force?: boolean) => Promise<void> {
  let last = ""
  let inflight: Promise<void> | undefined
  const run = async (force?: boolean): Promise<void> => {
    if (inflight) {
      if (!force) return
      await inflight.catch(() => {})
    }
    const started = doScan()
    inflight = started
    try {
      await started
    } finally {
      if (inflight === started) inflight = undefined
    }
  }
  const doScan = async (): Promise<void> => {
    try {
      const snapshot = await scanMailbox(clone)
      const report =
        snapshot.state.kind === "done"
          ? await readTextFile(path.join(clone, REPORT_FILE))
              .then((text) => clip(text, REPORT_CAP))
              .catch(() => undefined)
          : undefined
      const ui = trimSnapshot(snapshot, report)
      const serialized = JSON.stringify(ui)
      if (serialized !== last) {
        last = serialized
        emit({ type: "snapshot", snapshot: ui })
      }
    } catch {
      // 快照失败不致命:信箱可能正被同步,下一步自然重扫。
    }
  }
  return run
}

const PROMPT_CAP = 8000
const TEXT_CAP = 8000
const EVIDENCE_CAP = 1500
const REPORT_CAP = 64_000

function trimSnapshot(snapshot: MailboxSnapshot, report?: string): MailboxUiSnapshot {
  const job = snapshot.job
    ? {
        id: snapshot.job.job.id,
        title: snapshot.job.job.title,
        // 观战跳转要用:会话路由是 (目录, sessionID) 二元组。
        directory: snapshot.job.job.repo.directory,
        maxRounds: snapshot.job.mailbox.maxRounds,
        maxTokens: snapshot.job.job.budget.maxTokens,
        wallClockMin: snapshot.job.job.budget.wallClockMin,
      }
    : undefined
  const rounds = snapshot.rounds.map((entry) => ({
    ...entry,
    instruction: entry.instruction ? { ...entry.instruction, prompt: clip(entry.instruction.prompt, PROMPT_CAP) } : undefined,
    result: entry.result
      ? {
          ...entry.result,
          turn: entry.result.turn ? { ...entry.result.turn, text: clip(entry.result.turn.text, TEXT_CAP) } : undefined,
          grade: entry.result.grade ? trimGrade(entry.result.grade) : undefined,
        }
      : undefined,
  }))
  return { state: trimState(snapshot.state), job, rounds, report }
}

function trimState(state: MailboxSnapshot["state"]): MailboxUiState {
  switch (state.kind) {
    case "empty":
      return { kind: "empty" }
    case "corrupt":
      return { kind: "corrupt", detail: state.detail }
    case "done":
      return { kind: "done", verdict: state.verdict }
    case "awaiting-runner":
      return { kind: "awaiting-runner", round: state.round }
    case "awaiting-mother":
      return { kind: "awaiting-mother", round: state.round }
  }
}

function trimGrade(grade: GradeResult): GradeResult {
  const trimCheck = <T extends { evidence: string }>(check: T): T => ({ ...check, evidence: clip(check.evidence, EVIDENCE_CAP) })
  return {
    ...grade,
    build: grade.build ? trimCheck(grade.build) : undefined,
    checks: grade.checks.map(trimCheck),
  }
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…(截断,完整内容在信箱文件里)`
}
