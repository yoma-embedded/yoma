#!/usr/bin/env bun
/**
 * `yoma-bench` —— 无人值守调试台的入口。
 *
 * ```
 * yoma-bench run   <job.json> [--yes] [--dry-run]   跑完整闭环
 * yoma-bench grade <job.json>                        只跑判据(研发复核用,不动代码)
 * yoma-bench check <job.json>                        只校验 job spec 与环境
 * ```
 *
 * 权限升级默认走终端问人(--yes 则一律拒绝并继续,适合真无人值守的夜间跑)。
 * 拒绝不是失败:agent 会在下一轮收到"此路不通",自己换条路。
 */

import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import type { PermissionRequest } from "@yoma-desktop/kernel"
import { kernelSelfCheck } from "@yoma-desktop/kernel/host"

import { fileExists } from "./fsx.ts"
import { gradeRepeated } from "./grader.ts"
import * as git from "./git.ts"
import { JobSpecError, loadJob, type Job } from "./job.ts"
import { renderReport } from "./report.ts"
import { runJob } from "./runner.ts"
import { initMailbox } from "./mailbox/init.ts"
import { runMailboxMother } from "./mailbox/mother.ts"
import { runMailboxRunner } from "./mailbox/runner.ts"
import { runSim } from "./mailbox/sim.ts"
import { loadMailboxJob } from "./mailbox/spec.ts"
import { scanMailbox } from "./mailbox/store.ts"
import { pullReset } from "./mailbox/sync.ts"

const RESET = "[0m"
const DIM = "[2m"
const BOLD = "[1m"
const RED = "[31m"
const GREEN = "[32m"
const YELLOW = "[33m"

function say(message: string): void {
  process.stderr.write(`${message}\n`)
}

function fail(message: string): never {
  say(`${RED}✗ ${message}${RESET}`)
  process.exit(1)
}

/** 会话根目录默认指向 desktop 的 userData —— 这样跑完就能在桌面端直接回放。 */
function defaultSessionsRoot(): string {
  if (process.env.YOMA_SESSIONS_ROOT) return process.env.YOMA_SESSIONS_ROOT
  if (process.platform === "darwin") return path.join(homedir(), "Library/Application Support/Yoma/sessions")
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? homedir(), "Yoma/sessions")
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "Yoma/sessions")
}

function defaultEnginesDir(): string | undefined {
  if (process.env.YOMA_ENGINES_DIR) return process.env.YOMA_ENGINES_DIR
  const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
  const candidate = path.join(repoRoot, "engines")
  return candidate
}

async function askHuman(request: PermissionRequest): Promise<"once" | "always" | "reject"> {
  say("")
  say(`${YELLOW}${BOLD}需要你裁决${RESET}  ${request.title}`)
  say(`${DIM}工具 ${request.tool} · ${JSON.stringify(request.input).slice(0, 300)}${RESET}`)
  process.stderr.write("允许一次(y)/ 本次任务内一直允许(a)/ 拒绝(n)> ")

  for await (const line of console) {
    const answer = line.trim().toLowerCase()
    if (answer === "y" || answer === "yes") return "once"
    if (answer === "a" || answer === "always") return "always"
    if (answer === "n" || answer === "no" || answer === "") return "reject"
    process.stderr.write("请输入 y / a / n > ")
  }
  return "reject"
}

async function checkEnvironment(job: Job, enginesDir?: string): Promise<string[]> {
  const issues: string[] = []
  const workspace = path.resolve(job.repo.directory)

  if (!(await fileExists(path.join(workspace, ".git/HEAD")))) {
    const isWorktree = await fileExists(path.join(workspace, ".git"))
    if (!isWorktree) issues.push(`${workspace} 不是 git 仓库(交付要开分支提交)`)
  }

  const needsProbe = job.success.checks.some(
    (check) => (check.type === "log_wait" || check.type === "log_absent") && (check.source?.kind ?? "rtt") === "rtt",
  )
  if (needsProbe && enginesDir) {
    const probeRs = path.join(enginesDir, "bin", process.platform === "win32" ? "probe-rs.exe" : "probe-rs")
    if (!(await fileExists(probeRs))) {
      issues.push(`判据要用 RTT 采日志,但 ${probeRs} 不在 —— 先跑 \`bun engines/build.ts\``)
    }
  }

  if (job.bench.knownGoodElf) {
    const elf = path.resolve(workspace, job.bench.knownGoodElf)
    if (!(await fileExists(elf))) issues.push(`known-good 固件不存在:${elf}(失败时无法回刷)`)
  }

  try {
    const report = kernelSelfCheck({ enginesDir })
    if (report.tools.length < 10) issues.push(`内核只装配出 ${report.tools.length} 个工具,预期 10 个`)
  } catch (error) {
    issues.push(`内核加载失败:${(error as Error).message}`)
  }

  return issues
}

async function commandCheck(jobFile: string): Promise<void> {
  const job = await loadJob(jobFile)
  say(`${GREEN}✓${RESET} job spec 合法:${job.title}`)
  say(`${DIM}  策略 ${job.policy} · 预算 ${job.budget.maxIterations} 轮 / ${job.budget.maxTokens} tokens / ${job.budget.wallClockMin} 分钟${RESET}`)
  say(`${DIM}  判据 ${job.success.checks.length} 条${job.success.repeat > 1 ? ` × ${job.success.repeat} 遍` : ""}${RESET}`)

  const issues = await checkEnvironment(job, defaultEnginesDir())
  if (!issues.length) {
    say(`${GREEN}✓${RESET} 环境自检通过`)
    return
  }
  for (const issue of issues) say(`${YELLOW}⚠${RESET} ${issue}`)
  process.exit(1)
}

async function commandGrade(jobFile: string): Promise<void> {
  const job = await loadJob(jobFile)
  const workspace = path.resolve(job.repo.directory)
  say(`${BOLD}只跑判据${RESET}(不动代码)· ${workspace}`)

  const graded = await gradeRepeated({
    job,
    workspace,
    enginesDir: defaultEnginesDir(),
    onProgress: (message) => say(`${DIM}  ${message}${RESET}`),
  })

  const last = graded.rounds[graded.rounds.length - 1]
  for (const check of [last?.build, ...(last?.checks ?? [])]) {
    if (!check) continue
    const icon = { pass: `${GREEN}✓${RESET}`, fail: `${RED}✗${RESET}`, error: `${YELLOW}⚠${RESET}`, skip: `${DIM}−${RESET}` }[
      check.outcome
    ]
    say(`${icon} ${check.summary}`)
    if (check.outcome !== "pass" && check.evidence) say(`${DIM}${indent(check.evidence)}${RESET}`)
  }
  say(graded.passed ? `${GREEN}${BOLD}判据全部通过${RESET}` : `${RED}${BOLD}判据未通过${RESET}`)
  process.exit(graded.passed ? 0 : 1)
}

async function commandRun(jobFile: string, flags: Set<string>): Promise<void> {
  const job = await loadJob(jobFile)
  const workspace = path.resolve(job.repo.directory)
  const enginesDir = defaultEnginesDir()
  const sessionsRoot = defaultSessionsRoot()
  const stateDir = path.join(workspace, ".bench", "state")
  const benchDir = path.join(workspace, ".bench")

  say(`${BOLD}${job.title}${RESET} ${DIM}(${job.id})${RESET}`)
  say(`${DIM}工作树 ${workspace}${RESET}`)
  say(`${DIM}会话   ${sessionsRoot}  ← 在 Yoma Desktop 里可实时回放${RESET}`)
  say(`${DIM}策略   ${job.policy} · 预算 ${job.budget.maxIterations} 轮 / ${job.budget.maxTokens} tokens / ${job.budget.wallClockMin} 分钟${RESET}`)

  const issues = await checkEnvironment(job, enginesDir)
  for (const issue of issues) say(`${YELLOW}⚠${RESET} ${issue}`)
  if (issues.length && !flags.has("--force")) fail("环境自检未过。修好,或加 --force 明知故犯。")

  if (flags.has("--dry-run")) {
    say(`${GREEN}✓${RESET} dry-run:job 与环境就绪,没有真的开跑。`)
    return
  }

  await mkdir(benchDir, { recursive: true })
  await mkdir(sessionsRoot, { recursive: true })

  // 开分支。交付纪律:agent 全程在 agent/<jobId> 上干活,主干永远不动。
  const gitContext = { cwd: workspace }
  const branch = job.repo.branch ?? `agent/${job.id}`
  const prepared = await git.prepareBranch(gitContext, { branch, ref: job.repo.ref })
  if (!prepared.ok) fail(prepared.message)
  say(`${GREEN}✓${RESET} ${prepared.message}`)

  const result = await runJob({
    job,
    workspace,
    sessionsRoot,
    stateDir,
    enginesDir,
    benchDir,
    onProgress: (message) => say(`${DIM}${message}${RESET}`),
    onEscalation: flags.has("--yes") ? undefined : askHuman,
  })

  // 提交:每一次判据绿过的状态都值得留一个审计点;没过也提交,便于研发看 agent 试到哪一步。
  const committed = await git.commitAll(gitContext, {
    message: `${result.outcome === "passed" ? "fix" : "wip"}: ${job.title}\n\n任务 ${job.id}(agent 自动调试)\n结论:${result.reason}`,
    author: { name: "yoma-bench", email: "bench@yoma.local" },
  })
  if (committed.committed) say(`${GREEN}✓${RESET} ${committed.message} ${DIM}${committed.commit?.slice(0, 8)}${RESET}`)

  const baseCommit = prepared.baseCommit
  const report = renderReport({
    result,
    branch,
    baseCommit,
    sessionsRoot,
    diffStat: baseCommit ? await git.diffStat(gitContext, baseCommit) : undefined,
    changedFiles: baseCommit ? await git.diffNameStatus(gitContext, baseCommit) : undefined,
    commits: baseCommit ? await git.logSince(gitContext, baseCommit) : undefined,
  })
  const reportFile = path.join(benchDir, `report-${job.id}.md`)
  await writeFile(reportFile, report)
  await writeFile(path.join(benchDir, `result-${job.id}.json`), JSON.stringify(result, null, 2))

  say("")
  say(result.outcome === "passed" ? `${GREEN}${BOLD}✓ ${result.reason}${RESET}` : `${RED}${BOLD}✗ ${result.reason}${RESET}`)
  say(`${DIM}报告 ${reportFile}${RESET}`)
  if (result.sessionID) say(`${DIM}会话 ${result.sessionID} —— 在 Yoma Desktop 里可回放全过程${RESET}`)

  if (job.deliver?.push && result.outcome === "passed") {
    const pushed = await git.pushBranch(gitContext, { branch, remote: job.deliver.remote ?? "origin" })
    say(pushed.ok ? `${GREEN}✓${RESET} ${pushed.message}` : `${YELLOW}⚠${RESET} ${pushed.message}`)
  }
  // 自动建 MR 还没做。静默忽略一个写进 job 的字段,等于让人以为 MR 已经建好了 ——
  // 宁可每次都说一句。分支和报告都在,手动开 MR 只差一步。
  if (job.deliver?.mr) {
    say(`${YELLOW}⚠${RESET} deliver.mr 尚未实现:分支已就位,请手动开 MR(报告可直接贴进描述)`)
  }

  process.exit(result.outcome === "passed" ? 0 : 1)
}

function indent(text: string): string {
  return text
    .split("\n")
    .slice(-20)
    .map((line) => `    ${line}`)
    .join("\n")
}

// ─── mailbox:跨机器多轮闭环 ────────────────────────────────────────────────────

/** mailbox 子命令的旗标:值旗标(--interval 5)与开关旗标(--once)混合。 */
interface MailboxFlags {
  interval?: number
  branch?: string
  remote?: string
  root?: string
  timeoutMin?: number
  once: boolean
  ask: boolean
  fresh: boolean
}

function parseMailboxArgs(args: string[]): { positionals: string[]; flags: MailboxFlags } {
  const flags: MailboxFlags = { once: false, ask: false, fresh: false }
  const positionals: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const value = () => {
      const next = args[index + 1]
      if (next === undefined || next.startsWith("--")) fail(`${arg} 需要一个值`)
      index += 1
      return next!
    }
    if (arg === "--interval") flags.interval = Number(value())
    else if (arg === "--branch") flags.branch = value()
    else if (arg === "--remote") flags.remote = value()
    else if (arg === "--root") flags.root = value()
    else if (arg === "--timeout-min") flags.timeoutMin = Number(value())
    else if (arg === "--once") flags.once = true
    else if (arg === "--ask") flags.ask = true
    else if (arg === "--fresh") flags.fresh = true
    else if (arg.startsWith("--")) fail(`不认识的旗标 ${arg}`)
    else positionals.push(arg)
  }
  if (flags.interval !== undefined && !(flags.interval >= 1)) fail("--interval 至少 1 秒")
  return { positionals, flags }
}

/** 轮询间隔:命令行 > 信箱里 job 声明 > 15s。克隆里还没有 job 时用兜底值,重启后自然收敛。 */
async function pollSecondsOf(clone: string, flags: MailboxFlags): Promise<number> {
  if (flags.interval !== undefined) return flags.interval
  try {
    const snapshot = await scanMailbox(clone)
    if (snapshot.job) return snapshot.job.mailbox.pollSeconds
  } catch {
    // 信箱损坏的报错留给守护进程去说,这里只管兜底。
  }
  return 15
}

async function commandMailbox(sub: string | undefined, rest: string[]): Promise<void> {
  const { positionals, flags } = parseMailboxArgs(rest)
  const target = positionals[0]
  if (!sub || !target) fail("用法:yoma-bench mailbox <init|runner|mother|status|sim> <目标> [旗标](不带参数看总用法)")

  if (sub === "init") {
    const clone = positionals[1]
    if (!clone) fail("用法:yoma-bench mailbox init <mailbox-job.json> <信箱克隆目录>(先 git clone 你的信箱仓)")
    const mailboxJob = await loadMailboxJob(target!)
    const outcome = await initMailbox({ clone: path.resolve(clone!), branch: flags.branch, mailboxJob })
    if (!outcome.initialized) fail(outcome.detail)
    say(`${GREEN}✓${RESET} ${outcome.detail}`)
    return
  }

  if (sub === "runner") {
    const clone = path.resolve(target)
    const outcome = await runMailboxRunner({
      clone,
      branch: flags.branch,
      sessionsRoot: defaultSessionsRoot(),
      enginesDir: defaultEnginesDir(),
      onProgress: (message) => say(`${DIM}${message}${RESET}`),
      onEscalation: flags.ask ? askHuman : undefined,
      pollSeconds: await pollSecondsOf(clone, flags),
      once: flags.once,
    })
    if (outcome.kind === "finalized") {
      say(`${GREEN}✓${RESET} 闭环终局:${outcome.verdict.outcome} —— ${outcome.verdict.reason}`)
      process.exit(outcome.verdict.outcome === "passed" ? 0 : 1)
    }
    process.exit(outcome.kind === "blocked" ? 1 : 0)
  }

  if (sub === "mother") {
    const clone = path.resolve(target)
    const outcome = await runMailboxMother({
      clone,
      branch: flags.branch,
      sessionsRoot: defaultSessionsRoot(),
      onProgress: (message) => say(`${DIM}${message}${RESET}`),
      pollSeconds: await pollSecondsOf(clone, flags),
      once: flags.once,
    })
    if (outcome.kind === "done") {
      say(`${GREEN}✓${RESET} 闭环终局:${outcome.verdict.outcome} —— ${outcome.verdict.reason}`)
      process.exit(outcome.verdict.outcome === "passed" ? 0 : 1)
    }
    process.exit(outcome.kind === "blocked" ? 1 : 0)
  }

  if (sub === "status") {
    const clone = path.resolve(target)
    await pullReset({ clone, branch: flags.branch, author: { name: "yoma-bench", email: "bench@yoma.local" } })
    const snapshot = await scanMailbox(clone)
    if (snapshot.job) {
      const job = snapshot.job.job
      say(`${BOLD}${job.title}${RESET} ${DIM}(${job.id})${RESET}`)
      say(`${DIM}轮数上限 ${snapshot.job.mailbox.maxRounds} · token 预算 ${job.budget.maxTokens.toLocaleString()}${RESET}`)
    }
    for (const round of snapshot.rounds) {
      const grade = round.result?.error
        ? `⚠ ${round.result.error.slice(0, 50)}`
        : round.result?.grade
          ? round.result.grade.passed
            ? "判据全过"
            : "判据未过"
          : round.result
            ? "无判据"
            : "执行中/待执行"
      const decision = round.decision ? `${round.decision.decision}(${round.decision.by})` : "—"
      say(`  轮 ${round.round} · 指令 ${round.instruction?.issuedBy ?? "?"} · ${grade} · 裁决 ${decision}`)
    }
    const state = snapshot.state
    if (state.kind === "done") say(`${GREEN}${BOLD}终局 ${state.verdict.outcome}${RESET} —— ${state.verdict.reason}`)
    else if (state.kind === "awaiting-runner") say(`${YELLOW}等工位机执行第 ${state.round} 轮${RESET}`)
    else if (state.kind === "awaiting-mother") say(`${YELLOW}等母 agent 裁决第 ${state.round} 轮${RESET}`)
    else if (state.kind === "empty") say(`${DIM}信箱是空的(等 init)${RESET}`)
    else say(`${RED}信箱损坏:${state.detail}${RESET}`)
    return
  }

  if (sub === "sim") {
    const result = await runSim({
      jobFile: target,
      root: flags.root,
      remote: flags.remote,
      branch: flags.branch,
      pollSeconds: flags.interval,
      timeoutMin: flags.timeoutMin,
      fresh: flags.fresh,
      onOutput: (line) => say(line),
    })
    say("")
    if (result.verdict) {
      const color = result.verdict.outcome === "passed" ? GREEN : result.verdict.outcome === "parked" ? YELLOW : RED
      say(`${color}${BOLD}${result.detail}${RESET}`)
    } else {
      say(`${RED}${BOLD}${result.detail}${RESET}`)
    }
    say(`${DIM}信箱  ${result.mailboxDir}${RESET}`)
    if (result.reportFile) say(`${DIM}终报  ${result.reportFile}${RESET}`)
    process.exit(result.exitCode)
  }

  fail(`不认识的 mailbox 子命令 ${sub}`)
}

const [command, jobFile, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((arg) => arg.startsWith("--")))

if (!command || !jobFile) {
  say(`用法:
  yoma-bench run   <job.json> [--yes] [--force] [--dry-run]   跑完整闭环(单机)
  yoma-bench grade <job.json>                                  只跑判据(研发复核用)
  yoma-bench check <job.json>                                  只校验 job spec 与环境

  --yes      不问人:所有需要裁决的动作一律拒绝,任务继续(夜间无人值守)
  --force    环境自检没过也开跑
  --dry-run  只做校验与准备,不真的跑

跨机器多轮闭环(母 agent 决策 ↔ 工位机执行,私有 git 仓当信箱):
  yoma-bench mailbox init   <mailbox-job.json> <信箱克隆>      任务入箱 + 下发第 1 轮
  yoma-bench mailbox runner <信箱克隆> [--interval S] [--ask]  工位机常驻执行者
  yoma-bench mailbox mother <信箱克隆> [--interval S]          母 agent 决策者
  yoma-bench mailbox status <信箱克隆>                          看进度
  yoma-bench mailbox sim    <mailbox-job.json> [--remote url] [--fresh]
                                                               单机模拟整个闭环(两个真子进程,
                                                               只通过 git 通信;默认本地裸仓)
  --once     runner/mother 只走一步就退(cron 场景)
  --ask      runner 侧有人守着:权限升级问终端(缺省无人值守,升级即拒绝)
  --fresh    sim 清掉上次模拟从头来(外部远端不受影响)`)
  process.exit(2)
}

try {
  if (command === "run") await commandRun(jobFile, flags)
  else if (command === "grade") await commandGrade(jobFile)
  else if (command === "check") await commandCheck(jobFile)
  else if (command === "mailbox") await commandMailbox(jobFile, rest)
  else fail(`不认识的命令 ${command}`)
} catch (error) {
  if (error instanceof JobSpecError) fail(error.message)
  throw error
}
