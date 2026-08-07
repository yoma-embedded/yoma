/**
 * 守护进程的两件公共护具:单实例锁与 blocked 退避。
 *
 * ## 为什么必须有锁
 *
 * CLI 明示 `--once` 是给 cron 的,而调试轮动辄几十分钟、cron 周期是分钟级 ——
 * 不加锁的缺省结局就是重叠:第二个实例的 pullReset 会把第一个实例写了一半的轮
 * 结果清掉,两个内核子进程还会在同一块板子上抢探针(实测复现过,连本地
 * state.json 都会互相覆盖把预算记少)。锁住"每角色每信箱克隆一个实例"这个
 * sync.ts 整套论证赖以成立的前提。
 *
 * 锁文件住在克隆内自带 .gitignore 的目录里(与 .mother/ 同一套护身符:
 * pullReset 的 clean -fd 不删被 ignore 的文件),内容是 pid —— 持有者崩了不释放
 * 也没关系,下一个实例探测到 pid 已死就接管,不需要人工清锁。
 *
 * ## 为什么 blocked 要指数退避
 *
 * blocked 多半是"远端可读不可写"(deploy key 只读、分支保护)或网络故障,而
 * pullReset 会把没推上去的本地成果清掉 —— 于是每次轮询都在**整轮重跑**昂贵步骤
 * (模型 + 硬件动作)。花费如今两侧都记账,预算会收敛,但退避把"收敛前烧掉多少"
 * 从每 15 秒一轮压到分钟级,也把对远端的重试压力降下来。恢复正常一次即复位。
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
      const raw = await readTextFile(lockFile).catch(() => "")
      const holder = Number.parseInt(raw.trim(), 10)
      if (Number.isFinite(holder) && holder > 0 && isAlive(holder)) {
        return { ok: false, detail: `${role} 已有实例在跑(pid ${holder})—— 一个信箱克隆一个角色只能有一个实例` }
      }
      // 持有者已死:清掉尸体锁再抢一次。
      await unlink(lockFile).catch(() => {})
    }
  }
  return { ok: false, detail: `抢 ${role} 锁失败(与另一实例撞了两次)` }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** blocked 连击的退避:poll × 2^n,封顶 10 分钟。非 blocked 一次即复位。 */
export function backoffSeconds(pollSeconds: number, consecutiveBlocked: number): number {
  if (consecutiveBlocked <= 0) return pollSeconds
  return Math.min(pollSeconds * 2 ** consecutiveBlocked, 600)
}
