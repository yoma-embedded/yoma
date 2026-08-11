#!/usr/bin/env bun
/**
 * `yoma-bench` —— 信箱调试台的命令行入口。
 *
 * 主形态是**信箱闭环**:两台机器、两个 agent、一个 git 仓当邮路。研发端有代码和构建
 * 环境,工位端有板子(而且**只有**板子 —— 它没有项目检出,拿到的东西全是附件)。
 */

import { homedir } from "node:os"
import path from "node:path"

import { kernelSelfCheck } from "@yoma-desktop/kernel/host"

import { JobSpecError } from "./job.ts"
import { activeRoleLocks } from "./mailbox/daemon.ts"
import { initMailbox } from "./mailbox/init.ts"
import { runMailboxMother } from "./mailbox/mother.ts"
import { cloneDirFor, defaultMailboxRoot } from "./mailbox/paths.ts"
import { runMailboxRunner } from "./mailbox/runner.ts"
import { runSim } from "./mailbox/sim.ts"
import { loadMailboxJob } from "./mailbox/spec.ts"
import { scanMailbox } from "./mailbox/store.ts"
import { ensureClone, pullReset } from "./mailbox/sync.ts"

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
  return path.join(path.resolve(import.meta.dir, "..", "..", ".."), "engines")
}

/** 只校验任务书与本机内核装配 —— 不碰信箱、不碰板子。 */
async function commandCheck(jobFile: string): Promise<void> {
  const { job } = await loadMailboxJob(jobFile)
  say(`${GREEN}✓${RESET} 任务书合法:${job.title} ${DIM}(${job.id})${RESET}`)
  if (job.bench.chip) say(`${DIM}  板卡 ${job.bench.board ?? "—"} · 芯片 ${job.bench.chip}${RESET}`)

  const enginesDir = defaultEnginesDir()
  try {
    const report = kernelSelfCheck({ enginesDir })
    if (report.tools.length < 10) fail(`内核只装配出 ${report.tools.length} 个工具,预期 10 个`)
    say(`${GREEN}✓${RESET} 内核装配出 ${report.tools.length} 个工具`)
  } catch (error) {
    fail(`内核加载失败:${(error as Error).message}`)
  }
}

// ─── mailbox:跨机器多轮闭环 ────────────────────────────────────────────────────

interface MailboxFlags {
  interval?: number
  branch?: string
  remote?: string
  root?: string
  timeoutMin?: number
  once: boolean
  fresh: boolean
  /** 本机的工程目录 —— 只有研发端(mother)要它,代码在它那儿。 */
  project?: string
  /** 工位端一次性工作目录的根。缺省是信箱克隆的兄弟目录。 */
  workRoot?: string
}

function parseMailboxArgs(args: string[]): { positionals: string[]; flags: MailboxFlags } {
  const flags: MailboxFlags = { once: false, fresh: false }
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
    else if (arg === "--project") flags.project = value()
    else if (arg === "--work-root") flags.workRoot = value()
    else if (arg === "--timeout-min") flags.timeoutMin = Number(value())
    else if (arg === "--once") flags.once = true
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
  const snapshot = await scanMailbox(clone)
  return snapshot.job?.mailbox.pollSeconds ?? 15
}

/**
 * 克隆目录的解析口径:**显式路径优先,否则按 `--remote` 落在规范位置并按需克隆。**
 *
 * 规范位置来自 `mailbox/paths.ts`,与桌面端是**同一个函数**。这一条不是整洁癖:
 * 单实例锁 `.yoma-lock/<role>.pid` 住在克隆目录里面,锁的是"这个物理目录"而不是
 * "这个信箱"。命令行和桌面端只要落在两个目录上,两把锁互不知情,同一个信箱同一个
 * 角色就能被跑起来两个守护 —— 同时推同一个远端、同时抢同一块板子。
 *
 * 显式路径这条逃生舱留着:CI 和已有脚本里写死过路径,而且"我就是要放这儿"是合理需求。
 */
async function resolveClone(role: string, target: string | undefined, flags: MailboxFlags): Promise<string> {
  if (target) return path.resolve(target)
  if (!flags.remote) fail(`不给信箱克隆目录时必须给 --remote —— 会落在 ${defaultMailboxRoot()} 下`)
  const clone = cloneDirFor(defaultMailboxRoot(), flags.remote!, role, flags.branch)
  await ensureClone(flags.remote!, clone, { branch: flags.branch })
  return clone
}

async function commandMailbox(sub: string | undefined, rest: string[]): Promise<void> {
  const { positionals, flags } = parseMailboxArgs(rest)
  const target = positionals[0]
  if (!sub) fail("用法:yoma-bench mailbox <init|runner|mother|status|sim> [目标] [旗标](不带参数看总用法)")

  if (sub === "init") {
    if (!target) fail("用法:yoma-bench mailbox init <mailbox-job.json> [信箱克隆目录] [--remote url]")
    const mailboxJob = await loadMailboxJob(target)
    // 入箱发生在研发机上,而随后接手的守护是 mother —— 用它的克隆,别再建第二个。
    const clone = await resolveClone("mother", positionals[1], flags)
    const outcome = await initMailbox({ clone, branch: flags.branch, mailboxJob })
    if (!outcome.initialized) fail(outcome.detail)
    say(`${GREEN}✓${RESET} ${outcome.detail}`)
    say(`${DIM}  克隆 ${clone}${RESET}`)
    return
  }

  if (sub === "runner") {
    const clone = await resolveClone("runner", target, flags)
    const outcome = await runMailboxRunner({
      clone,
      branch: flags.branch,
      sessionsRoot: defaultSessionsRoot(),
      workRoot: flags.workRoot,
      enginesDir: defaultEnginesDir(),
      onProgress: (message) => say(`${DIM}${message}${RESET}`),
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
    const clone = await resolveClone("mother", target, flags)
    const outcome = await runMailboxMother({
      clone,
      branch: flags.branch,
      sessionsRoot: defaultSessionsRoot(),
      projectDir: flags.project,
      enginesDir: defaultEnginesDir(),
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
    // **status 自己一个克隆**,绝不与守护共用目录:它要 pullReset,而 pullReset 是
    // `reset --hard + clean -fd` —— 撞上正在写这一轮的守护就是把它还没提交的
    // instruction/附件原地清掉,守护随后 commitPush 发现无改动,一整轮模型分析静默
    // 作废(daemon.ts 顶部那段讲的就是这件事)。多一个几 MB 的克隆换掉这个,值。
    const clone = await resolveClone("status", target, flags)
    // 上面那条只保得住默认路径。显式传路径的人完全可能指到守护的克隆上,所以再看一眼锁。
    const held = await activeRoleLocks(clone)
    if (held.length > 0) {
      say(`${YELLOW}这个克隆正被守护占着(${held.join("、")})—— 不碰它的工作树,下面是本地已有的状态${RESET}`)
    } else {
      await pullReset({ clone, branch: flags.branch, author: { name: "yoma-bench", email: "bench@yoma.local" } })
    }
    const snapshot = await scanMailbox(clone)
    if (snapshot.job) {
      const job = snapshot.job.job
      say(`${BOLD}${job.title}${RESET} ${DIM}(${job.id})${RESET}`)
    }
    for (const round of snapshot.rounds) {
      const bench = round.result?.error
        ? `⚠ ${round.result.error.slice(0, 50)}`
        : round.result
          ? "已回填"
          : "执行中/待执行"
      const decision = round.decision ? `${round.decision.decision}(${round.decision.by})` : "—"
      say(`  轮 ${round.round} · 指令 ${round.instruction?.issuedBy ?? "?"} · ${bench} · 裁决 ${decision}`)
    }
    const state = snapshot.state
    if (state.kind === "done") say(`${GREEN}${BOLD}终局 ${state.verdict.outcome}${RESET} —— ${state.verdict.reason}`)
    else if (state.kind === "awaiting-runner") say(`${YELLOW}等工位机执行第 ${state.round} 轮${RESET}`)
    else if (state.kind === "awaiting-mother") say(`${YELLOW}等研发端处理第 ${state.round} 轮${RESET}`)
    else if (state.kind === "empty") say(`${DIM}信箱是空的(等 init)${RESET}`)
    else if (state.kind === "kickoff") say(`${YELLOW}等研发端下发第一轮${RESET}`)
    else say(`${RED}信箱损坏:${state.detail}${RESET}`)
    return
  }

  if (sub === "sim") {
    if (!target) fail("用法:yoma-bench mailbox sim <mailbox-job.json> --project <工程目录> [--remote url]")
    const result = await runSim({
      jobFile: target,
      projectDir: flags.project,
      root: flags.root,
      remote: flags.remote,
      branch: flags.branch,
      pollSeconds: flags.interval,
      timeoutMin: flags.timeoutMin,
      fresh: flags.fresh,
      onOutput: (line) => say(line),
    })
    say("")
    say(`${result.verdict?.outcome === "passed" ? GREEN : RED}${BOLD}${result.detail}${RESET}`)
    say(`${DIM}信箱  ${result.mailboxDir}${RESET}`)
    if (result.reportFile) say(`${DIM}终报  ${result.reportFile}${RESET}`)
    process.exit(result.exitCode)
  }

  fail(`不认识的 mailbox 子命令 ${sub}`)
}

const [command, jobFile, ...rest] = process.argv.slice(2)

if (!command || !jobFile) {
  say(`用法:
  yoma-bench check <mailbox-job.json>                          只校验任务书与本机内核装配

跨机器多轮闭环(研发端决策与改码 ↔ 工位端上板,私有 git 仓当信箱):
  yoma-bench mailbox init   <mailbox-job.json> [信箱克隆]      任务入箱
  yoma-bench mailbox mother [信箱克隆] --project <工程目录>    研发端(有代码与构建环境)
  yoma-bench mailbox runner [信箱克隆]                          工位端(有板子;不需要工程代码)
  yoma-bench mailbox status [信箱克隆]                          看进度
  yoma-bench mailbox sim    <mailbox-job.json> [--remote url] [--fresh]
                                                               单机模拟整个闭环(两个真子进程,
                                                               只通过 git 通信;默认本地裸仓)

  **信箱克隆目录可以不给** —— 那就用 --remote,克隆会落在规范位置并按需建出来:
    ${defaultMailboxRoot()}/clones/<远端+分支哈希>/<角色>
  这和桌面端是同一个位置。落在别处的代价是实打实的:单实例锁住在克隆目录里面,
  两个目录 = 两把锁 = 同一个信箱同一个角色能被跑起来两个守护,同时抢同一块板子。

  --remote URL   信箱远端(不给克隆目录时必填)
  --interval S   轮询间隔(缺省取任务书里的 mailbox.pollSeconds)
  --branch B     信箱分支(缺省 main)
  --once         runner/mother 只走一步就退(cron 场景)
  --work-root D  工位端一次性工作目录的根(缺省是信箱克隆的兄弟目录)
  --fresh        sim 清掉上次模拟从头来(外部远端不受影响)`)
  process.exit(2)
}

try {
  if (command === "check") await commandCheck(jobFile)
  else if (command === "mailbox") await commandMailbox(jobFile, rest)
  else fail(`不认识的命令 ${command}`)
} catch (error) {
  if (error instanceof JobSpecError) fail(error.message)
  throw error
}
