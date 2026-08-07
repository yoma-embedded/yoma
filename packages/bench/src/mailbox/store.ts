/**
 * 信箱的文件布局与状态推断 —— 协议的"数据面"。只碰文件,不碰 git(那是 sync.ts 的事)。
 *
 * ## 布局
 *
 * ```
 * <信箱根>/
 *   job.json                    总任务书(MailboxJob 原文)
 *   rounds/001/instruction.json mother → runner:本轮指令
 *   rounds/001/result.json      runner → mother:轮结果(最后写 —— 它的存在 = 本轮完成)
 *   rounds/001/patch.diff       相对基线的完整补丁(母 agent 看代码改动的唯一途径)
 *   rounds/001/decision.json    本轮裁决(mother 或确定性守卫)
 *   verdict.json                终局(出现即整个任务结束)
 *   report.md                   终报(与 verdict 同一次提交写入)
 * ```
 *
 * ## 状态是**推断**出来的,不落盘
 *
 * 没有 state.json:状态 = "最大的一个有 instruction 的轮次处在哪一步"。单独维护一份
 * 状态文件意味着它可能和轮次文件失配,而失配时该信谁没有答案。文件的存在性本身就是
 * 状态机:instruction 有而 result 无 → 等 runner;result 有而 decision 无 → 等 mother;
 * verdict 有 → 结束。
 *
 * ## 写入顺序即协议
 *
 * runner 一轮的产物里 **result.json 必须最后写**;mother 的 decision + 下轮 instruction
 * 必须**同一次提交**。配合 sync.ts 的 pullReset(工作树永远等于远端已推的真相),
 * 崩溃在任何一步都只会退回"重跑本步",不会出现两边看到的状态互相矛盾。
 */

import { mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { PermissionDecision } from "@yoma-desktop/kernel/host"

import { fileExists, readJsonFile } from "../fsx.ts"

import type { GradeResult } from "../grader.ts"
import type { TurnUsage } from "../turn.ts"
import { parseMailboxJob, type MailboxJob } from "./spec.ts"

export interface RoundInstruction {
  round: number
  /** 交给调试 agent 的完整指令文本。runner 会在其后自动附上上一轮判据证据。 */
  prompt: string
  issuedBy: "init" | "mother"
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
  grade?: GradeResult
  /** 只带被拒的裁决 —— mother 要知道哪些路 agent 走不通。 */
  denied: { tool: string; title: string; rule?: string }[]
  git?: RoundGit
  /** runner 侧跨轮累计的 token(含本轮)。预算强制的输入。 */
  spentTokens: number
  /** 轮级失败(环境没过、子进程没产出结果)。有它时 turn/grade 可能缺失。 */
  error?: string
  at: string
  elapsedMs: number
}

export type DecisionKind = "continue" | "success" | "fail" | "park"

export interface RoundDecision {
  round: number
  /**
   * 裁决者。`policy` = 确定性守卫(判据通过、预算耗尽、环境错误)—— 代码定的,
   * 不是模型;`mother` = 母 agent 真判断过。审计不能伪造裁决者,这里同理。
   */
  by: "mother" | "policy"
  decision: DecisionKind
  /** mother 的分析自述(policy 裁决时缺省)。 */
  analysis?: string
  reason?: string
  usage?: TurnUsage
  motherSessionID?: string
  at: string
}

export interface MailboxVerdict {
  outcome: "passed" | "failed" | "parked"
  reason: string
  rounds: number
  totalRunnerTokens: number
  totalMotherTokens: number
  decidedBy: "mother" | "policy"
  at: string
}

export interface RoundFiles {
  round: number
  instruction?: RoundInstruction
  result?: RoundResultFile
  decision?: RoundDecision
}

export type MailboxState =
  | { kind: "done"; verdict: MailboxVerdict }
  | { kind: "awaiting-runner"; round: number; instruction: RoundInstruction }
  | { kind: "awaiting-mother"; round: number; instruction: RoundInstruction; result: RoundResultFile }
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

export async function writeInstruction(root: string, instruction: RoundInstruction): Promise<void> {
  await writeJson(path.join(roundDir(root, instruction.round), "instruction.json"), instruction)
}

/** patch/报告等旁证先落盘,result.json 最后写 —— 它的存在就是"本轮完成"的信号。 */
export async function writeRoundResult(
  root: string,
  result: RoundResultFile,
  extras?: { patch?: string },
): Promise<void> {
  const dir = roundDir(root, result.round)
  await mkdir(dir, { recursive: true })
  if (extras?.patch !== undefined) await writeFile(path.join(dir, "patch.diff"), extras.patch)
  await writeJson(path.join(dir, "result.json"), result)
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
  return {
    round,
    instruction: await readJson<RoundInstruction>(path.join(dir, "instruction.json")),
    result: await readJson<RoundResultFile>(path.join(dir, "result.json")),
    decision: await readJson<RoundDecision>(path.join(dir, "decision.json")),
  }
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
    const rounds: RoundFiles[] = []
    for (const number of numbers) rounds.push(await readRound(root, number))

    if (verdict) return { job, state: { kind: "done", verdict }, rounds }
    if (!job || rounds.length === 0) return { job, state: { kind: "empty" }, rounds }

    const last = rounds[rounds.length - 1]!
    if (!last.instruction) {
      return { job, state: { kind: "corrupt", detail: `轮 ${last.round} 有目录但没有 instruction.json` }, rounds }
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

/** 把 TurnResult 级的裁决压成 mother 需要的"哪些路被拒了"。 */
export function summarizeDenied(decisions: PermissionDecision[]): RoundResultFile["denied"] {
  return decisions
    .filter((decision) => decision.verdict === "deny")
    .map((decision) => ({ tool: decision.tool, title: decision.title, rule: decision.rule }))
}
