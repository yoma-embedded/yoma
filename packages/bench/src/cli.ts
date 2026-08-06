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

import { gradeRepeated } from "./grader.ts"
import * as git from "./git.ts"
import { JobSpecError, loadJob, type Job } from "./job.ts"
import { renderReport } from "./report.ts"
import { runJob } from "./runner.ts"

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

  if (!(await Bun.file(path.join(workspace, ".git/HEAD")).exists())) {
    const isWorktree = await Bun.file(path.join(workspace, ".git")).exists()
    if (!isWorktree) issues.push(`${workspace} 不是 git 仓库(交付要开分支提交)`)
  }

  const needsProbe = job.success.checks.some(
    (check) => (check.type === "log_wait" || check.type === "log_absent") && (check.source?.kind ?? "rtt") === "rtt",
  )
  if (needsProbe && enginesDir) {
    const probeRs = path.join(enginesDir, "bin", process.platform === "win32" ? "probe-rs.exe" : "probe-rs")
    if (!(await Bun.file(probeRs).exists())) {
      issues.push(`判据要用 RTT 采日志,但 ${probeRs} 不在 —— 先在 my-pi 仓库跑 \`bun engines/build.ts\``)
    }
  }

  if (job.bench.knownGoodElf) {
    const elf = path.resolve(workspace, job.bench.knownGoodElf)
    if (!(await Bun.file(elf).exists())) issues.push(`known-good 固件不存在:${elf}(失败时无法回刷)`)
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

  process.exit(result.outcome === "passed" ? 0 : 1)
}

function indent(text: string): string {
  return text
    .split("\n")
    .slice(-20)
    .map((line) => `    ${line}`)
    .join("\n")
}

const [command, jobFile, ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((arg) => arg.startsWith("--")))

if (!command || !jobFile) {
  say(`用法:
  yoma-bench run   <job.json> [--yes] [--force] [--dry-run]   跑完整闭环
  yoma-bench grade <job.json>                                  只跑判据(研发复核用)
  yoma-bench check <job.json>                                  只校验 job spec 与环境

  --yes      不问人:所有需要裁决的动作一律拒绝,任务继续(夜间无人值守)
  --force    环境自检没过也开跑
  --dry-run  只做校验与准备,不真的跑`)
  process.exit(2)
}

try {
  if (command === "run") await commandRun(jobFile, flags)
  else if (command === "grade") await commandGrade(jobFile)
  else if (command === "check") await commandCheck(jobFile)
  else fail(`不认识的命令 ${command}`)
} catch (error) {
  if (error instanceof JobSpecError) fail(error.message)
  throw error
}
