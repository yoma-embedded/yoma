/**
 * 守护进程的两件公共护具:单实例锁与 blocked 退避。
 *
 * ## 为什么必须有锁
 *
 * CLI 明示 `--once` 是给 cron 的,而调试轮动辄几十分钟、cron 周期是分钟级 ——
 * 不加锁的缺省结局就是重叠:第二个实例的 pullReset 会把第一个实例写了一半的轮
 * 结果清掉,两个内核子进程还会在同一块板子上抢探针(实测复现过,连研发端本地的
 * state.json —— 会话指针与任务基线 —— 都会互相覆盖)。锁住"每角色每信箱克隆一个
 * 实例"这个 sync.ts 整套论证赖以成立的前提。
 *
 * 锁文件住在克隆内自带 .gitignore 的目录里(与 .mother/ 同一套护身符:
 * pullReset 的 clean -fd 不删被 ignore 的文件),内容是 pid —— 持有者崩了不释放
 * 也没关系,下一个实例探测到 pid 已死就接管,不需要人工清锁。
 *
 * ## 为什么 blocked 要指数退避
 *
 * blocked 多半是"远端可读不可写"(deploy key 只读、分支保护)或网络故障,而
 * pullReset 会把没推上去的本地成果清掉 —— 于是每次轮询都在**整轮重跑**昂贵步骤
 * (模型 + 硬件动作)。而这条路上没有任何预算兜底(上限整套已删),退避就是唯一的
 * 刹车:把烧钱速度从每 15 秒一轮压到分钟级,也把对远端的重试压力降下来。
 * 恢复正常一次即复位。
 */

import { mkdir, unlink, writeFile } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import path from "node:path"

import { fileExists, readTextFile } from "../fsx.ts"

const LOCK_DIR = ".yoma-lock"

export type RoleLock = { ok: true; release: () => Promise<void> } | { ok: false; detail: string }

export async function acquireRoleLock(clone: string, role: "runner" | "mother"): Promise<RoleLock> {
  const dir = path.join(clone, LOCK_DIR)
  await mkdir(dir, { recursive: true })
  const ignore = path.join(dir, ".gitignore")
  if (!(await fileExists(ignore))) {
    await writeFile(ignore, "# 守护进程的单实例锁,不进信箱(含自身)\n*\n")
  }

  const lockFile = path.join(dir, `${role}.pid`)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // wx:已存在即抛 —— 这就是锁的原子性所在。
      writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" })
      return { ok: true, release: async () => unlink(lockFile).catch(() => {}) }
    } catch {
      const holder = await livingHolder(lockFile)
      if (holder !== undefined) {
        return { ok: false, detail: `${role} 已有实例在跑(pid ${holder})—— 一个信箱克隆一个角色只能有一个实例` }
      }
      // 持有者已死:清掉尸体锁再抢一次。
      await unlink(lockFile).catch(() => {})
    }
  }
  return { ok: false, detail: `抢 ${role} 锁失败(与另一实例撞了两次)` }
}

/**
 * 这个克隆当前被哪些角色的守护占着(pid 还活着的才算)。
 *
 * 给**只读命令**用的。`mailbox status` 会 pullReset,而那是 `reset --hard + clean -fd`:
 * 撞上正在写这一轮的守护,就是把它还没提交的 instruction/附件/patch 原地清掉 ——
 * 守护随后 commitPush 发现无改动,一整轮模型分析静默作废,而报出来的是
 * "第一轮指令推不上去",完全指不到真凶。这正是本文件顶部那段说的事,只是 status
 * 不该去**抢**锁(它不是守护、不该把守护挤掉),而该看一眼就让开。
 */
export async function activeRoleLocks(clone: string): Promise<string[]> {
  const held: string[] = []
  for (const role of ["runner", "mother"] as const) {
    const holder = await livingHolder(path.join(clone, LOCK_DIR, `${role}.pid`))
    if (holder !== undefined) held.push(`${role}(pid ${holder})`)
  }
  return held
}

/** 锁文件里那个**还活着**的持有者 pid;文件不在、内容不是 pid、进程已死都返回 undefined。 */
async function livingHolder(lockFile: string): Promise<number | undefined> {
  const raw = await readTextFile(lockFile).catch(() => "")
  const pid = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(pid) && pid > 0 && isAlive(pid) ? pid : undefined
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 守护进程的轮询循环。两个角色的这段从前一字不差地各写一份,只差三处:角色名、
 * 步函数、终态 kind。本文件顶上那两件"公共护具"(锁 + 退避)本来就在这儿,唯独把
 * 它们粘起来的循环留在了外面。
 *
 * `blocked` 用工厂传进来而不是就地造:泛型表达不了"T 的联合里含 blocked 分支"。
 * 进度串(`(空闲)…` 与 `⚠ …(Ns 后重试)`)是桌面端事件里看得见的文本,逐字保留。
 */
export async function runRoleDaemon<T extends { kind: string; detail?: string }>(params: {
  clone: string
  role: "runner" | "mother"
  pollSeconds: number
  once?: boolean
  step: () => Promise<T>
  blocked: (detail: string) => T
  /** 见到它就返回退出(runner 是 "finalized",mother 是 "done")。 */
  terminalKind: T["kind"]
  onStep?: (outcome: T) => void
  onProgress?: (message: string) => void
}): Promise<T> {
  const lock = await acquireRoleLock(params.clone, params.role)
  if (!lock.ok) return params.blocked(lock.detail)
  let blockedStreak = 0
  try {
    for (;;) {
      let outcome: T
      try {
        outcome = await params.step()
      } catch (error) {
        outcome = params.blocked((error as Error).message)
      }
      params.onStep?.(outcome)
      if (outcome.kind === "idle") params.onProgress?.(`(空闲)${outcome.detail}`)
      if (outcome.kind === params.terminalKind || params.once) return outcome
      blockedStreak = outcome.kind === "blocked" ? blockedStreak + 1 : 0
      const delay = backoffSeconds(params.pollSeconds, blockedStreak)
      if (outcome.kind === "blocked") params.onProgress?.(`⚠ ${outcome.detail}(${delay}s 后重试)`)
      await new Promise((resolve) => setTimeout(resolve, delay * 1000))
    }
  } finally {
    await lock.release()
  }
}

/** blocked 连击的退避:poll × 2^n,封顶 10 分钟。非 blocked 一次即复位。 */
export function backoffSeconds(pollSeconds: number, consecutiveBlocked: number): number {
  if (consecutiveBlocked <= 0) return pollSeconds
  return Math.min(pollSeconds * 2 ** consecutiveBlocked, 600)
}
