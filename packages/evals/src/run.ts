/**
 * 一次运行:task × k → trials → results.jsonl / run.json / summary.md。
 *
 * ## 为什么逐条追加 results.jsonl
 *
 * 一次 run 是 task × k 次真实的模型调用,跑几十分钟很正常。**跑到一半也要能看** ——
 * 中途 Ctrl-C、机器睡了、某道题把配额烧光了,已经跑完的那些不该跟着一起没有。
 * 一行一个 JSON 于是既是产物也是进度条,`report <runDir>` 对半截文件照样成立。
 *
 * ## 并发池而不是 Promise.all
 *
 * 每个 trial 都是一个子进程 + 一个模型会话。全放出去的后果不是快,是 provider 限速
 * 和本机内存一起炸,而失败会被记成 `error` —— 一次基础设施抖动污染整张表。
 *
 * ## requires 的门是"不满足就跳过",不是"报错"
 *
 * v1 只有 `engines` 能被满足(而且只在 `<enginesDir>/bin` 真的在的时候)。
 * 其余(qemu / board / datasheet-server)一律跳过 —— 一台没插板子的开发机跑全量题库
 * 时,它该安静地少跑几道,而不是红一片。
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { renderReport, RESULTS_FILE, RUN_FILE, SUMMARY_FILE } from "./report.ts"
import { findRepoRoot } from "./repo.ts"
import { loadTasks, type Task } from "./task.ts"
import { runTrial, skippedTrial, type TrialRecord } from "./trial.ts"
import { synthesizeFaux } from "./faux-synth.ts"

const execFileAsync = promisify(execFile)

export const DEFAULT_CONCURRENCY = 4

export interface RunMeta {
  runID: string
  model?: string
  thinking?: string
  k: number
  filter?: string
  concurrency: number
  tasksDir: string
  enginesDir?: string
  configDir?: string
  sessionsRoot: string
  /** 拿不到就是 null(不是仓库、没装 git),不猜。 */
  gitSha: string | null
  startedAt: string
  finishedAt?: string
  taskIDs: string[]
  totals?: { pass: number; fail: number; error: number; skip: number }
}

export interface RunOptions {
  tasksDir: string
  filter?: string
  k?: number
  model?: string
  thinking?: string
  concurrency?: number
  /** `runs/<stamp>`。调用方定,便于 CLI 印路径。 */
  runDir: string
  enginesDir?: string
  configDir?: string
  /** 不给则落在 `<runDir>/sessions`;指到桌面端的 sessions 目录就能在桌面端回放。 */
  sessionsRoot?: string
  settleMs?: number
  onProgress?: (line: string) => void
}

export interface RunOutcome {
  meta: RunMeta
  records: TrialRecord[]
  /** 题目本身解析失败的(一道坏题不阻断其余,但要报出来)。 */
  taskErrors: { file: string; message: string }[]
  runDir: string
}

/** `2026-08-21T09-12-33-041Z` —— 可排序、跨平台可当目录名。 */
export function runStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-")
}

export async function gitSha(cwd: string): Promise<string | null> {
  return execFileAsync("git", ["rev-parse", "HEAD"], { cwd, env: process.env })
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null)
}

/**
 * 这道题的 requires 能不能被满足。返回 undefined = 能跑;返回字符串 = 跳过的理由。
 *
 * `engines` 认的是 `<enginesDir>/bin` **在不在**,而不是"传没传路径" —— worktree 里
 * `engines/bin` 是空的(根 .gitignore 忽略它),不查这一层的话网表题会跑起来然后
 * 每次都拿到一句"去跑 bun engines/build.ts",再被记成 fail。
 */
export function unmetRequirement(task: Task, context: { enginesDir?: string }): string | undefined {
  for (const need of task.requires) {
    if (need !== "engines") return `需要 ${need},v1 还提供不了(env 只有 none)`
    if (!context.enginesDir) return "需要 engines,但没有提供 --engines-dir"
    if (!existsSync(path.join(context.enginesDir, "bin"))) {
      return `需要 engines,但 ${context.enginesDir} 下没有 bin/(先跑 bun engines/build.ts,或用 --engines-dir 指到主检出)`
    }
  }
  return undefined
}

/** 定量并发。每个 trial 是一个子进程 + 一个模型会话,全放出去只会把 provider 打限速。 */
async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const lanes = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        await worker(items[index]!)
      }
    }),
  )
}

/**
 * 串行化的追加器。
 *
 * 并发池里几个 trial 会同时收工,而 `appendFile` 每次自己开关一次 fd —— 交错的写
 * 有机会把两行拼成一行(尤其 Windows 上 O_APPEND 是模拟的)。半行能被 readResults
 * 跳过,**拼起来的那行**却是合法 JSON 里塞了另一条记录的残骸,静默丢数据。
 * 一条 promise 链就解决了,不值得为此上文件锁。
 */
function serialAppender(file: string): (record: unknown) => Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  return (record) => {
    chain = chain.then(() => appendFile(file, `${JSON.stringify(record)}\n`))
    return chain
  }
}

function totalsOf(records: TrialRecord[]): NonNullable<RunMeta["totals"]> {
  return {
    pass: records.filter((record) => record.status === "pass").length,
    fail: records.filter((record) => record.status === "fail").length,
    error: records.filter((record) => record.status === "error").length,
    skip: records.filter((record) => record.status === "skip").length,
  }
}

async function finish(runDir: string, meta: RunMeta, records: TrialRecord[]): Promise<RunMeta> {
  const finished: RunMeta = { ...meta, finishedAt: new Date().toISOString(), totals: totalsOf(records) }
  await writeFile(path.join(runDir, RUN_FILE), `${JSON.stringify(finished, null, 2)}\n`)
  await writeFile(path.join(runDir, SUMMARY_FILE), renderReport(records, finished))
  return finished
}

export async function runEvals(options: RunOptions): Promise<RunOutcome> {
  const repoRoot = findRepoRoot()
  const k = options.k ?? 1
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const runDir = path.resolve(options.runDir)
  const sessionsRoot = options.sessionsRoot ?? path.join(runDir, "sessions")
  await mkdir(runDir, { recursive: true })
  await mkdir(sessionsRoot, { recursive: true })

  const { tasks, errors: taskErrors } = await loadTasks(options.tasksDir, options.filter)

  const meta: RunMeta = {
    runID: path.basename(runDir),
    model: options.model,
    thinking: options.thinking,
    k,
    filter: options.filter,
    concurrency,
    tasksDir: path.resolve(options.tasksDir),
    enginesDir: options.enginesDir,
    configDir: options.configDir,
    sessionsRoot,
    gitSha: await gitSha(repoRoot),
    startedAt: new Date().toISOString(),
    taskIDs: tasks.map((task) => task.id),
  }
  // 先落一份:跑到一半被打断时,runDir 里也要说得清"这是拿什么配置跑的"。
  await writeFile(path.join(runDir, RUN_FILE), `${JSON.stringify(meta, null, 2)}\n`)

  const append = serialAppender(path.join(runDir, RESULTS_FILE))
  const records: TrialRecord[] = []
  const say = options.onProgress ?? (() => {})

  const jobs: { task: Task; index: number }[] = []
  for (const task of tasks) {
    for (let index = 0; index < k; index += 1) jobs.push({ task, index })
  }

  await pool(jobs, concurrency, async ({ task, index }) => {
    const unmet = unmetRequirement(task, { enginesDir: options.enginesDir })
    if (unmet) {
      const record = skippedTrial(task, index, meta.runID, unmet)
      records.push(record)
      await append(record)
      say(`skip  ${task.id} #${index} —— ${unmet}`)
      return
    }
    const record = await runTrial({
      task,
      index,
      runID: meta.runID,
      runDir,
      sessionsRoot,
      model: options.model,
      thinking: options.thinking,
      enginesDir: options.enginesDir,
      configDir: options.configDir,
      repoRoot,
      settleMs: options.settleMs,
    })
    records.push(record)
    await append(record)
    say(`${record.status.padEnd(5)} ${task.id} #${index} —— ${summarize(record)}`)
  })

  return { meta: await finish(runDir, meta, records), records, taskErrors, runDir }
}

/** 一行进度。失败时把第一个红掉的 grader 亮出来 —— 那是人最想先看到的东西。 */
export function summarize(record: TrialRecord): string {
  if (record.status === "error") return record.error ?? "(没有说明)"
  const failed = record.graders.find((verdict) => !verdict.pass)
  const cost = record.metrics.cost ? `,$${record.metrics.cost.toFixed(4)}` : ""
  const head = `${record.metrics.turns} turns / ${record.metrics.toolCalls} 次工具${cost}`
  return failed ? `${head};${failed.type}:${failed.detail}` : head
}

// ─── selftest ────────────────────────────────────────────────────────────────

export interface SelftestCase {
  taskID: string
  kind: "good" | "bad"
  expected: "pass" | "fail"
  record: TrialRecord
  /** 期望与实得一致。skip 不算不一致(那是能力门控,不是题的问题)。 */
  ok: boolean
}

export interface SelftestOutcome {
  cases: SelftestCase[]
  taskErrors: { file: string; message: string }[]
  runDir: string
  ok: boolean
}

export interface SelftestOptions {
  tasksDir: string
  filter?: string
  concurrency?: number
  runDir: string
  enginesDir?: string
  /** 不传则自建一个临时目录 —— selftest 绝不能读开发机真实的 ~/.yoma。 */
  configDir?: string
  settleMs?: number
  onProgress?: (line: string) => void
}

/**
 * 参考解必须过,已知坏解必须不过。
 *
 * 假模型(零 key 零网络),其余全真:真 harness、真工具、真会话落盘。所以这一步验的是
 * 一整条 —— 夹具在不在、工具跑不跑得通、答案格式抽不抽得出来、grader 配没配对。
 *
 * **反向那一刀不能省**:只跑 good 的 selftest 证明不了 grader 会红,而一个永远亮绿的
 * 闸门比没有闸门更坏(它让人以为自己有防线)。
 */
export async function runSelftest(options: SelftestOptions): Promise<SelftestOutcome> {
  const repoRoot = findRepoRoot()
  const runDir = path.resolve(options.runDir)
  const sessionsRoot = path.join(runDir, "sessions")
  await mkdir(sessionsRoot, { recursive: true })
  // 隔离掉开发机真实的 ~/.yoma:否则 selftest 的结果取决于跑它的人装了什么技能。
  const configDir = options.configDir ?? (await mkdtemp(path.join(tmpdir(), "yoma-evals-selftest-")))

  const { tasks, errors: taskErrors } = await loadTasks(options.tasksDir, options.filter)
  const say = options.onProgress ?? (() => {})
  const append = serialAppender(path.join(runDir, RESULTS_FILE))
  const cases: SelftestCase[] = []

  const jobs = tasks.flatMap((task) => [
    { task, kind: "good" as const, index: 0 },
    { task, kind: "bad" as const, index: 1 },
  ])

  await pool(jobs, options.concurrency ?? DEFAULT_CONCURRENCY, async ({ task, kind, index }) => {
    const expected = kind === "good" ? ("pass" as const) : ("fail" as const)
    const unmet = unmetRequirement(task, { enginesDir: options.enginesDir })
    if (unmet) {
      const record = skippedTrial(task, index, "selftest", unmet)
      cases.push({ taskID: task.id, kind, expected, record, ok: true })
      await append(record)
      say(`skip  ${task.id} (${kind}) —— ${unmet}`)
      return
    }
    const record = await runTrial({
      task,
      index,
      runID: "selftest",
      runDir,
      sessionsRoot,
      configDir,
      enginesDir: options.enginesDir,
      faux: synthesizeFaux(task)[kind],
      repoRoot,
      settleMs: options.settleMs,
    })
    const ok = record.status === expected
    cases.push({ taskID: task.id, kind, expected, record, ok })
    await append(record)
    say(`${ok ? "ok   " : "BAD  "} ${task.id} (${kind}) 期望 ${expected} 实得 ${record.status} —— ${summarize(record)}`)
  })

  cases.sort((a, b) => a.taskID.localeCompare(b.taskID) || a.kind.localeCompare(b.kind))
  return { cases, taskErrors, runDir, ok: cases.every((entry) => entry.ok) && taskErrors.length === 0 }
}
