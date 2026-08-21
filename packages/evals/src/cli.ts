#!/usr/bin/env bun
/**
 * `yoma-evals` —— agent 评测的命令行入口。
 *
 * ```
 * bun packages/evals/src/cli.ts list     [--tasks <dir>] [--filter <子串或 tag>]
 * bun packages/evals/src/cli.ts selftest [--tasks …] [--filter …] [--concurrency 4] [--engines-dir …]
 * bun packages/evals/src/cli.ts run      [--tasks …] [--filter …] [--k 3] [--model provider/model]
 *                                        [--thinking <档位>] [--concurrency 4] [--out <dir>]
 *                                        [--engines-dir …] [--config-dir …] [--sessions-root …]
 * bun packages/evals/src/cli.ts report   <runDir>
 * ```
 *
 * 进度走 stderr,报告走 stdout —— `report` 于是可以直接重定向进文件而不掺进度行。
 */

import { mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"

import { THINKING_LEVELS } from "@yoma-desktop/kernel"

import { renderRunReport, RESULTS_FILE, SUMMARY_FILE } from "./report.ts"
import { defaultTasksDir, findRepoRoot } from "./repo.ts"
import { DEFAULT_CONCURRENCY, runEvals, runSelftest, runStamp, unmetRequirement } from "./run.ts"
import { loadTasks, TaskSpecError } from "./task.ts"

const RESET = "\x1b[0m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
const RED = "\x1b[31m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"

function say(message: string): void {
  process.stderr.write(`${message}\n`)
}

function fail(message: string): never {
  say(`${RED}✗ ${message}${RESET}`)
  process.exit(1)
}

interface Flags {
  tasks?: string
  filter?: string
  k?: number
  model?: string
  thinking?: string
  concurrency?: number
  out?: string
  enginesDir?: string
  configDir?: string
  sessionsRoot?: string
}

function parseFlags(args: string[]): { positionals: string[]; flags: Flags } {
  const flags: Flags = {}
  const positionals: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const value = () => {
      const next = args[index + 1]
      if (next === undefined || next.startsWith("--")) fail(`${arg} 需要一个值`)
      index += 1
      return next!
    }
    if (arg === "--tasks") flags.tasks = value()
    else if (arg === "--filter") flags.filter = value()
    else if (arg === "--k") flags.k = Number(value())
    else if (arg === "--model") flags.model = value()
    else if (arg === "--thinking") flags.thinking = value()
    else if (arg === "--concurrency") flags.concurrency = Number(value())
    else if (arg === "--out") flags.out = value()
    else if (arg === "--engines-dir") flags.enginesDir = value()
    else if (arg === "--config-dir") flags.configDir = value()
    else if (arg === "--sessions-root") flags.sessionsRoot = value()
    else if (arg.startsWith("--")) fail(`不认识的旗标 ${arg}`)
    else positionals.push(arg)
  }
  if (flags.k !== undefined && (!Number.isInteger(flags.k) || flags.k < 1)) fail("--k 必须是 >= 1 的整数")
  if (flags.concurrency !== undefined && (!Number.isInteger(flags.concurrency) || flags.concurrency < 1)) {
    fail("--concurrency 必须是 >= 1 的整数")
  }
  if (flags.thinking !== undefined && !THINKING_LEVELS.includes(flags.thinking)) {
    fail(`--thinking "${flags.thinking}" 不是合法档位(${THINKING_LEVELS.join(" / ")})`)
  }
  if (flags.model !== undefined && !/^[^/]+\/.+$/.test(flags.model)) fail("--model 要写成 provider/model")
  return { positionals, flags }
}

/**
 * engines 目录。**显式传**是硬规矩(CLAUDE.md"会咬人的地方"):不传的话 yoma 的
 * `enginesDir()` 会向上找一个"名字叫 engines 且存在"的目录,高高兴兴找到一个没有
 * `bin/` 的空壳,然后报"去跑 bun engines/build.ts",让人以为是没编译。
 *
 * 人显式指了路(旗标或 `YOMA_ENGINES_DIR`)却指错,是配置错误 —— 当场报错并指名旗标。
 * 落到仓内默认值而 `bin/` 是空的(worktree 就是这样,根 .gitignore 忽略 `engines/bin/`),
 * 那不是错误:路径照传,`requires: ["engines"]` 的题由门控安静跳过。
 */
function resolveEnginesDir(flag?: string): string | undefined {
  const explicit = flag ?? process.env.YOMA_ENGINES_DIR
  if (explicit) {
    const dir = path.resolve(explicit)
    if (!existsSync(dir)) fail(`--engines-dir 指向的 ${dir} 不存在`)
    if (!existsSync(path.join(dir, "bin"))) {
      fail(`--engines-dir 指向的 ${dir} 里没有 bin/ —— 先在那边跑 bun engines/build.ts,或把 --engines-dir 指到主检出`)
    }
    return dir
  }
  const fallback = path.join(findRepoRoot(), "engines")
  if (!existsSync(path.join(fallback, "bin"))) {
    say(`${DIM}(${fallback} 下没有 bin/,需要 engines 的题会跳过;要跑它们就用 --engines-dir 指到主检出)${RESET}`)
  }
  return fallback
}

function tasksDirOf(flags: Flags): string {
  return path.resolve(flags.tasks ?? defaultTasksDir())
}

function printTaskErrors(errors: { file: string; message: string }[]): void {
  for (const entry of errors) say(`${RED}✗ ${entry.message}${RESET}`)
}

async function commandList(flags: Flags): Promise<void> {
  const tasksDir = tasksDirOf(flags)
  const { tasks, errors } = await loadTasks(tasksDir, flags.filter)
  const enginesDir = resolveEnginesDir(flags.enginesDir)
  say(`${DIM}${tasksDir}${RESET}`)
  for (const task of tasks) {
    const unmet = unmetRequirement(task, { enginesDir })
    const gate = unmet ? ` ${YELLOW}[skip:${task.requires.join(",")}]${RESET}` : ""
    const graders = task.graders.map((spec) => spec.type).join(",")
    process.stdout.write(`${BOLD}${task.id}${RESET}${gate}  ${task.title}\n`)
    process.stdout.write(`${DIM}  tags ${task.tags.join(" ")} · graders ${graders}${RESET}\n`)
  }
  say(`${tasks.length} 道题`)
  printTaskErrors(errors)
  if (errors.length) process.exit(1)
}

async function commandSelftest(flags: Flags): Promise<void> {
  const tasksDir = tasksDirOf(flags)
  const runDir = path.resolve(flags.out ?? path.join(findRepoRoot(), "packages/evals/runs", `selftest-${runStamp()}`))
  await mkdir(runDir, { recursive: true })
  say(`${DIM}selftest(假模型,零 key 零网络)→ ${runDir}${RESET}`)

  const outcome = await runSelftest({
    tasksDir,
    filter: flags.filter,
    concurrency: flags.concurrency ?? DEFAULT_CONCURRENCY,
    runDir,
    enginesDir: resolveEnginesDir(flags.enginesDir),
    onProgress: (line) => say(`${DIM}${line}${RESET}`),
  })

  const good = outcome.cases.filter((entry) => entry.kind === "good")
  const bad = outcome.cases.filter((entry) => entry.kind === "bad")
  const count = (entries: typeof outcome.cases, status: string) =>
    entries.filter((entry) => entry.record.status === status).length
  say("")
  say(`期望 pass 实得 ${count(good, "pass")}/${good.length};期望 fail 实得 ${count(bad, "fail")}/${bad.length}`)

  const broken = outcome.cases.filter((entry) => !entry.ok)
  for (const entry of broken) {
    say(`${RED}✗ ${entry.taskID}(${entry.kind}):期望 ${entry.expected},实得 ${entry.record.status}${RESET}`)
    if (entry.record.error) say(`  ${DIM}${entry.record.error}${RESET}`)
    for (const verdict of entry.record.graders) {
      say(`  ${verdict.pass ? GREEN + "✓" : RED + "✗"}${RESET} ${verdict.type} —— ${verdict.detail}`)
    }
    if (entry.record.sessionFile) say(`  ${DIM}会话 ${entry.record.sessionFile}${RESET}`)
  }
  printTaskErrors(outcome.taskErrors)

  if (!outcome.ok) {
    // 0% pass@k 先怀疑题,再怀疑 agent —— selftest 红了就是"先怀疑题"的那一步在说话。
    fail(`selftest 不通过:${broken.length} 处不符`)
  }
  say(`${GREEN}✓ selftest 通过(${outcome.cases.length} 次)${RESET}`)
}

async function commandRun(flags: Flags): Promise<void> {
  const tasksDir = tasksDirOf(flags)
  const runDir = path.resolve(flags.out ?? path.join(findRepoRoot(), "packages/evals/runs", runStamp()))
  await mkdir(runDir, { recursive: true })
  const k = flags.k ?? 1
  say(`${DIM}${flags.model ?? "(本机第一个有凭据的模型)"} · k=${k} · → ${runDir}${RESET}`)

  const outcome = await runEvals({
    tasksDir,
    filter: flags.filter,
    k,
    model: flags.model,
    thinking: flags.thinking,
    concurrency: flags.concurrency ?? DEFAULT_CONCURRENCY,
    runDir,
    enginesDir: resolveEnginesDir(flags.enginesDir),
    // 不传就是 ~/.yoma —— 凭据/技能/上下文与桌面端同一份,评的就是用户的那个 agent。
    configDir: flags.configDir ? path.resolve(flags.configDir) : undefined,
    sessionsRoot: flags.sessionsRoot ? path.resolve(flags.sessionsRoot) : undefined,
    onProgress: (line) => say(`${DIM}${line}${RESET}`),
  })

  const totals = outcome.meta.totals!
  say("")
  say(
    `${GREEN}pass ${totals.pass}${RESET} · fail ${totals.fail} · ${YELLOW}error ${totals.error}${RESET} · skip ${totals.skip}`,
  )
  say(`${DIM}${path.join(runDir, SUMMARY_FILE)}${RESET}`)
  say(`${DIM}${path.join(runDir, RESULTS_FILE)}${RESET}`)
  printTaskErrors(outcome.taskErrors)
  // 分数低不是命令失败(评测的产品是那张表);题坏了才是。
  if (outcome.taskErrors.length) process.exit(1)
}

async function commandReport(runDir: string): Promise<void> {
  if (!runDir) fail("用法:report <runDir>")
  const dir = path.resolve(runDir)
  if (!existsSync(path.join(dir, RESULTS_FILE))) fail(`${dir} 下没有 ${RESULTS_FILE}`)
  process.stdout.write(await renderRunReport(dir))
}

const [command, ...rest] = process.argv.slice(2)
const { positionals, flags } = parseFlags(rest)

try {
  if (command === "list") await commandList(flags)
  else if (command === "selftest") await commandSelftest(flags)
  else if (command === "run") await commandRun(flags)
  else if (command === "report") await commandReport(positionals[0] ?? "")
  else {
    say("用法:yoma-evals <list | selftest | run | report>")
    say(`${DIM}  list     [--tasks <dir>] [--filter <子串或 tag>]${RESET}`)
    say(`${DIM}  selftest [--tasks …] [--filter …] [--concurrency 4] [--engines-dir …]${RESET}`)
    say(`${DIM}  run      [--tasks …] [--filter …] [--k 3] [--model provider/model] [--thinking <档位>]${RESET}`)
    say(
      `${DIM}           [--concurrency 4] [--out <dir>] [--engines-dir …] [--config-dir …] [--sessions-root …]${RESET}`,
    )
    say(`${DIM}  report   <runDir>${RESET}`)
    process.exit(command ? 1 : 0)
  }
} catch (error) {
  if (error instanceof TaskSpecError) fail(error.message)
  throw error
}
