/**
 * git 交付。
 *
 * ## 纪律
 *
 * - **绝不动主干**:准备阶段就切到 `agent/<jobId>`,研发端全程在这条分支上干活。
 * - **每轮提交一次**:commit 是审计点 —— 它把"这一轮下发的固件"和"这一轮的代码"
 *   钉在一起。不 squash:研发 review 时能看到假设的演进,那正是最有价值的部分。
 * - **绝不 push 主干、绝不强推**:push 只推 job 声明的那条 agent 分支。
 *
 * 所有 git 调用都是 argv 直接 spawn 不过 shell —— 分支名和路径可能含中文和空格。
 */

import { spawn } from "node:child_process"

export interface GitOutcome {
  ok: boolean
  stdout: string
  stderr: string
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitOutcome>

/**
 * `close` 时对整段 stdout 做了 trim —— 谁要解析 `git status --porcelain`,第一行的
 * 前导空格已经没了(` M x.c` → `M x.c`),按固定列 `slice(3)` 会把文件名咬掉一个字符
 * (实测:main.c 变成 ain.c)。要解析就先逐行 trim 再剥状态码。
 */
export const runGitReal: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("error", (error) => resolve({ ok: false, stdout, stderr: error.message }))
    child.on("close", (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }))
  })

export interface GitContext {
  cwd: string
  run?: GitRunner
}

async function git(context: GitContext, ...args: string[]): Promise<GitOutcome> {
  return (context.run ?? runGitReal)(args, context.cwd)
}

export async function isRepo(context: GitContext): Promise<boolean> {
  return (await git(context, "rev-parse", "--is-inside-work-tree")).ok
}

export async function currentBranch(context: GitContext): Promise<string> {
  return (await git(context, "rev-parse", "--abbrev-ref", "HEAD")).stdout
}

export async function isClean(context: GitContext): Promise<boolean> {
  const status = await git(context, "status", "--porcelain")
  return status.ok && status.stdout === ""
}

/**
 * 准备工作分支。
 *
 * 起点由 `ref` 决定(不给就用当前 HEAD)。分支已存在就直接切过去 —— 打回续跑时
 * 正是这条路径,不能因为"分支已存在"就失败。
 */
export async function prepareBranch(
  context: GitContext,
  options: { branch: string; ref?: string },
): Promise<{ ok: boolean; message: string; baseCommit?: string }> {
  if (!(await isRepo(context))) return { ok: false, message: `${context.cwd} 不是一个 git 仓库` }
  if (!(await isClean(context))) {
    return { ok: false, message: "工作树不干净 —— 先提交或 stash,agent 的改动必须能和你的区分开" }
  }

  if (options.ref) {
    const checkout = await git(context, "checkout", options.ref)
    if (!checkout.ok) return { ok: false, message: `切到 ${options.ref} 失败:${checkout.stderr}` }
  }

  const exists = (await git(context, "rev-parse", "--verify", options.branch)).ok
  const switched = exists
    ? await git(context, "checkout", options.branch)
    : await git(context, "checkout", "-b", options.branch)
  if (!switched.ok) return { ok: false, message: `切到分支 ${options.branch} 失败:${switched.stderr}` }

  const head = await git(context, "rev-parse", "HEAD")
  return { ok: true, message: exists ? `复用已有分支 ${options.branch}` : `新建分支 ${options.branch}`, baseCommit: head.stdout }
}

/** 提交当前全部改动。没有改动时返回 committed:false,不是失败 —— agent 这轮可能只是看了看。 */
export async function commitAll(
  context: GitContext,
  options: { message: string; author?: { name: string; email: string } },
): Promise<{ committed: boolean; message: string; commit?: string }> {
  const add = await git(context, "add", "-A")
  if (!add.ok) return { committed: false, message: `git add 失败:${add.stderr}` }
  if (await isClean(context)) return { committed: false, message: "没有改动可提交" }

  const args = ["commit", "-m", options.message]
  if (options.author) {
    // -c 而不是改仓库配置:归属只作用于这一次提交,不污染工位机的 git 配置。
    args.unshift("-c", `user.name=${options.author.name}`, "-c", `user.email=${options.author.email}`)
  }
  const commit = await git(context, ...args)
  if (!commit.ok) return { committed: false, message: `git commit 失败:${commit.stderr}` }
  const head = await git(context, "rev-parse", "HEAD")
  return { committed: true, message: "已提交", commit: head.stdout }
}

/** 相对某个基线的 diff 统计,进报告。 */
export async function diffStat(context: GitContext, baseCommit: string): Promise<string> {
  const stat = await git(context, "diff", "--stat", `${baseCommit}..HEAD`)
  return stat.ok ? stat.stdout : ""
}

export async function diffNameStatus(context: GitContext, baseCommit: string): Promise<string[]> {
  const out = await git(context, "diff", "--name-status", `${baseCommit}..HEAD`)
  return out.ok && out.stdout ? out.stdout.split("\n") : []
}

export async function logSince(context: GitContext, baseCommit: string): Promise<string[]> {
  const out = await git(context, "log", "--oneline", `${baseCommit}..HEAD`)
  return out.ok && out.stdout ? out.stdout.split("\n") : []
}

/** 相对基线的完整补丁(unified diff)。信箱模式用它把改动搬给看不到工作树的母 agent。 */
export async function diffPatch(context: GitContext, baseCommit: string): Promise<string> {
  const out = await git(context, "diff", `${baseCommit}..HEAD`)
  return out.ok ? out.stdout : ""
}

export async function headCommit(context: GitContext): Promise<string> {
  return (await git(context, "rev-parse", "HEAD")).stdout
}

/** 只推 job 声明的那条分支,绝不 --force。 */
export async function pushBranch(
  context: GitContext,
  options: { branch: string; remote: string },
): Promise<{ ok: boolean; message: string }> {
  const push = await git(context, "push", "--set-upstream", options.remote, options.branch)
  return push.ok
    ? { ok: true, message: `已推送 ${options.remote}/${options.branch}` }
    : { ok: false, message: `推送失败:${push.stderr}` }
}
