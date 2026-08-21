/**
 * 汇总与报告。
 *
 * ## 三个 pass 指标不是一回事
 *
 * - **pass@1** = 单次通过率。它回答"随便跑一次,有多大机会对"。
 * - **pass@k** = k 次里至少一次通过。它回答"这题它够得着吗" —— 0 说明能力缺口,
 *   不是运气问题。
 * - **pass^k** = k 次全过。它回答"能不能靠它" —— pass@k 高而 pass^k 低就是不稳定,
 *   而不稳定的 agent 在无人值守场景里等于不能用(bench 那边一轮跑歪就得人来收拾)。
 *
 * 三个一起看才有意义:只看 pass@1 会把"稳定地对 70%"和"一半时间全对一半时间全错"
 * 混成同一个数。
 *
 * ## error 单列,不进分母
 *
 * 混进 fail 会把"API 抖了"记成"agent 笨"(文章叫 correlated failures:同一时段跑的
 * 所有题一起变差,而你以为是模型退化)。所以分母只有 pass + fail。
 * 一道题全是 error 时它的 pass 列是 `—`,而不是 0% —— 那两件事该长得不一样。
 *
 * ## 指标只记不判
 *
 * turns / tokens / 用时都不参与通过判定,也没有阈值。它们是给人看趋势的:
 * 2026-08-11 那次"107 条 assistant 消息、reasoning token 为 0"是读 transcript 才发现的,
 * 有这张表跑完一眼就看见。**reasoning 单列**正是为了它。
 */

import { readFile } from "node:fs/promises"
import path from "node:path"

import type { RunMeta } from "./run.ts"
import type { TrialRecord } from "./trial.ts"

export interface PassStats {
  /** 计分 trial 数(pass + fail)。 */
  n: number
  passes: number
  errors: number
  skips: number
  /** n 为 0 时是 undefined —— 报告里印 `—`,与 0% 区分开。 */
  pass1?: number
  passK?: number
  passPowK?: number
}

export interface Averages {
  turns: number
  tokensIn: number
  tokensOut: number
  tokensReasoning: number
  elapsedMs: number
  cost: number
}

export interface TaskAggregate extends PassStats {
  taskID: string
  tags: string[]
  averages: Averages
}

export interface TagAggregate extends PassStats {
  tag: string
  /** 这个 tag 下有几道题。 */
  tasks: number
}

const counted = (records: TrialRecord[]) =>
  records.filter((record) => record.status === "pass" || record.status === "fail")

/** 单题的三个 pass 指标。**per task** 才有 pass@k / pass^k 的语义:k 次说的是同一道题。 */
export function passStats(records: TrialRecord[]): PassStats {
  const scored = counted(records)
  const passes = scored.filter((record) => record.status === "pass").length
  const stats: PassStats = {
    n: scored.length,
    passes,
    errors: records.filter((record) => record.status === "error").length,
    skips: records.filter((record) => record.status === "skip").length,
  }
  if (scored.length) {
    stats.pass1 = passes / scored.length
    stats.passK = passes > 0 ? 1 : 0
    stats.passPowK = passes === scored.length ? 1 : 0
  }
  return stats
}

/** 平均值的分母是"真的跑过的" —— skip 从来没启动过,算进去会把 turns 平白拉低。 */
export function averages(records: TrialRecord[]): Averages {
  const ran = records.filter((record) => record.status !== "skip")
  const mean = (pick: (record: TrialRecord) => number) =>
    ran.length ? ran.reduce((sum, record) => sum + pick(record), 0) / ran.length : 0
  return {
    turns: mean((record) => record.metrics.turns),
    tokensIn: mean((record) => record.metrics.tokens.input),
    tokensOut: mean((record) => record.metrics.tokens.output),
    tokensReasoning: mean((record) => record.metrics.tokens.reasoning),
    elapsedMs: mean((record) => record.metrics.elapsedMs),
    cost: mean((record) => record.metrics.cost),
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const bucket = groups.get(key(item))
    if (bucket) bucket.push(item)
    else groups.set(key(item), [item])
  }
  return groups
}

export function aggregateTasks(records: TrialRecord[]): TaskAggregate[] {
  return [...groupBy(records, (record) => record.taskID)]
    .map(([taskID, group]) => ({
      taskID,
      tags: [...new Set(group.flatMap((record) => record.tags))],
      ...passStats(group),
      averages: averages(group),
    }))
    .sort((a, b) => a.taskID.localeCompare(b.taskID))
}

/**
 * 按 tag 汇总。一条 trial 有几个 tag 就进几个桶(L1 与 kicad 是两个正交的切法)。
 *
 * pass@k / pass^k 在 tag 这一级是**按题平均**的 —— 它们本来就是"对某一道题" 的
 * 断言,把不同题的 trial 混进一个池子再问"至少一次通过"没有意义。
 */
export function aggregateTags(records: TrialRecord[]): TagAggregate[] {
  const byTag = new Map<string, TrialRecord[]>()
  for (const record of records) {
    for (const tag of record.tags) {
      const bucket = byTag.get(tag)
      if (bucket) bucket.push(record)
      else byTag.set(tag, [record])
    }
  }
  return [...byTag]
    .map(([tag, group]) => {
      const perTask = aggregateTasks(group)
      const withScore = perTask.filter((task) => task.pass1 !== undefined)
      const mean = (pick: (task: TaskAggregate) => number) =>
        withScore.length ? withScore.reduce((sum, task) => sum + pick(task), 0) / withScore.length : undefined
      const stats = passStats(group)
      return {
        tag,
        tasks: perTask.length,
        ...stats,
        passK: mean((task) => task.passK ?? 0),
        passPowK: mean((task) => task.passPowK ?? 0),
      }
    })
    .sort((a, b) => a.tag.localeCompare(b.tag))
}

// ─── markdown ────────────────────────────────────────────────────────────────

const pct = (value?: number): string => (value === undefined ? "—" : `${Math.round(value * 100)}%`)
const num = (value: number, digits = 1): string => value.toFixed(digits)
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

function table(header: string[], rows: string[][]): string {
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`]
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`)
  return lines.join("\n")
}

function metaSection(meta?: RunMeta): string[] {
  if (!meta) return []
  return [
    "| 项 | 值 |",
    "|---|---|",
    `| 运行 | ${meta.runID} |`,
    `| 模型 | ${meta.model ?? "(内核按本机凭据挑)"} |`,
    `| 思考档位 | ${meta.thinking ?? "(内核默认)"} |`,
    `| k | ${meta.k} |`,
    `| filter | ${meta.filter ?? "(全部)"} |`,
    `| git | ${meta.gitSha ?? "—"} |`,
    `| tasks | ${meta.tasksDir} |`,
    `| engines | ${meta.enginesDir ?? "(未提供)"} |`,
    `| 会话 | ${meta.sessionsRoot} |`,
    `| 起止 | ${meta.startedAt} → ${meta.finishedAt ?? "(未完成)"} |`,
    "",
  ]
}

export function renderReport(records: TrialRecord[], meta?: RunMeta): string {
  const tasks = aggregateTasks(records)
  const overall = passStats(records)
  const overallAverages = averages(records)
  const lines: string[] = ["# 评测报告", ""]
  lines.push(...metaSection(meta))

  lines.push("## 总计", "")
  lines.push(
    table(
      ["题数", "trial", "计分", "pass@1", "pass@k(按题均)", "pass^k(按题均)", "error", "skip"],
      [
        [
          String(tasks.length),
          String(records.length),
          String(overall.n),
          pct(overall.pass1),
          pct(meanOf(tasks.map((task) => task.passK))),
          pct(meanOf(tasks.map((task) => task.passPowK))),
          String(overall.errors),
          String(overall.skips),
        ],
      ],
    ),
    "",
  )

  lines.push("## 按题", "")
  lines.push(
    table(
      ["题", "n", "pass@1", "pass@k", "pass^k", "error", "skip", "turns", "in", "out", "reasoning", "用时"],
      tasks.map((task) => [
        task.taskID,
        String(task.n),
        pct(task.pass1),
        pct(task.passK),
        pct(task.passPowK),
        String(task.errors),
        String(task.skips),
        num(task.averages.turns),
        num(task.averages.tokensIn, 0),
        num(task.averages.tokensOut, 0),
        num(task.averages.tokensReasoning, 0),
        seconds(task.averages.elapsedMs),
      ]),
    ),
    "",
  )

  const tags = aggregateTags(records)
  if (tags.length) {
    lines.push("## 按 tag", "")
    lines.push(
      table(
        ["tag", "题数", "n", "pass@1", "pass@k", "pass^k", "error", "skip"],
        tags.map((tag) => [
          tag.tag,
          String(tag.tasks),
          String(tag.n),
          pct(tag.pass1),
          pct(tag.passK),
          pct(tag.passPowK),
          String(tag.errors),
          String(tag.skips),
        ]),
      ),
      "",
    )
  }

  const failures = records.filter((record) => record.status === "fail")
  lines.push("## 未通过的 trial", "")
  if (!failures.length) lines.push("(没有)", "")
  for (const record of failures) {
    lines.push(`### ${record.taskID} #${record.trial}`, "")
    for (const verdict of record.graders) {
      lines.push(`- ${verdict.pass ? "✓" : "✗"} \`${verdict.type}\` —— ${verdict.detail}`)
    }
    if (record.answer.raw) lines.push("", "```json", record.answer.raw.trim(), "```")
    if (record.sessionFile) lines.push("", `会话:\`${record.sessionFile}\``)
    lines.push("")
  }

  const errored = records.filter((record) => record.status === "error")
  if (errored.length) {
    // 单列的理由见文件头:它不是"答错了",不该和能力缺口混在一张表里。
    lines.push("## 基础设施错误(不计入 pass 率)", "")
    for (const record of errored) {
      lines.push(`- **${record.taskID} #${record.trial}** —— ${record.error ?? "(没有说明)"}`)
      if (record.sessionFile) lines.push(`  会话:\`${record.sessionFile}\``)
    }
    lines.push("")
  }

  const skipped = records.filter((record) => record.status === "skip")
  if (skipped.length) {
    lines.push("## 跳过", "")
    const byTask = groupBy(skipped, (record) => record.taskID)
    for (const [taskID, group] of byTask) {
      lines.push(`- **${taskID}** ×${group.length} —— ${group[0]!.error ?? "(没有说明)"}`)
    }
    lines.push("")
  }

  lines.push(
    "---",
    "",
    `平均花费 ${overallAverages.cost.toFixed(4)} / trial,平均用时 ${seconds(overallAverages.elapsedMs)}。`,
    "",
    "指标只记不判:turns / tokens / 用时不参与通过判定。跑完至少抽 10 条 transcript 全文读 ——",
    "失败是真蠢还是 grader 冤枉了合法解法,只有读了才知道(README 出题纪律第 6 条)。",
    "",
  )
  return lines.join("\n")
}

function meanOf(values: (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : undefined
}

// ─── 读回一次运行 ─────────────────────────────────────────────────────────────

export const RESULTS_FILE = "results.jsonl"
export const RUN_FILE = "run.json"
export const SUMMARY_FILE = "summary.md"

/** 逐行读 results.jsonl。**跑到一半也读得动** —— 它是逐条追加的,末尾半行直接跳过。 */
export async function readResults(runDir: string): Promise<TrialRecord[]> {
  const text = await readFile(path.join(runDir, RESULTS_FILE), "utf8")
  const records: TrialRecord[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed) as TrialRecord)
    } catch {
      continue
    }
  }
  return records
}

export async function readRunMeta(runDir: string): Promise<RunMeta | undefined> {
  return readFile(path.join(runDir, RUN_FILE), "utf8")
    .then((text) => JSON.parse(text) as RunMeta)
    .catch(() => undefined)
}

export async function renderRunReport(runDir: string): Promise<string> {
  return renderReport(await readResults(runDir), await readRunMeta(runDir))
}
