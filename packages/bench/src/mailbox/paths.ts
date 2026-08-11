/**
 * 信箱本地克隆的**规范位置** —— 桌面端与命令行必须算出同一个目录。
 *
 * ## 为什么这件事有牙齿
 *
 * 单实例锁(daemon.ts 的 `.yoma-lock/<role>.pid`)住在**克隆目录里面**,锁的是
 * "这个物理目录",不是"这个信箱"。于是只要桌面端和命令行落在两个不同的克隆上,
 * 两边的 `acquireRoleLock` 各自成功 —— 同一个信箱同一个角色被跑起来两个守护,
 * 同时 pullReset/push 同一个远端、同时对同一块板子下手,而"另一个实例正在跑"
 * 那句话永远不会出现。这不是假设:2026-08-11 之前桌面端把克隆放在 Electron 的
 * userData 下,而 CLI 要求你自己 `git clone` 到任意路径再把路径传进来,两边天生
 * 不是同一个目录。
 *
 * 所以位置必须只有**一份实现**,这个文件就是那一份。
 *
 * ## 为什么它是一个叶子模块
 *
 * 桌面端 main 进程要 import 它,而 `@yoma-desktop/bench` 在 desktop 的
 * devDependencies 里 —— electron-vite 的 externalizeDeps 不碰 devDependencies,
 * 于是 bench 会被 **inline 进 `out/main/index.js`**。走包的主入口(`.`)就会把
 * runTurn → createKernelHost → 整个内核一起拖进 main 的 bundle。
 * 本文件因此只依赖 `node:crypto` / `node:os` / `node:path`,并在 bench 的 exports
 * 里单开一条 `./mailbox/paths`,让打包器只拉这一个文件。
 * **往这里加 import 之前先想清楚这一条。**
 */

import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"

/**
 * 这台机器上 yoma agent 的全局目录 —— 凭据、技能、上下文文件、信箱克隆同一个地方。
 *
 * 必须与内核的 `myPiConfigDir()`(kernel/src/host/auth.ts)算出同一个值。那边是
 * 凭据与技能的真源,这边是信箱的;两者分叉的表现是**静默的**(信箱去了一个目录、
 * 凭据在另一个),所以不 import 它(见上面"叶子模块"),改用 paths.test.ts 的
 * 漂移断言把两份钉在一起。
 */
export function defaultConfigDir(): string {
  return path.join(homedir(), ".my-pi")
}

/** 信箱克隆的默认根。命令行不给克隆目录时落在这里,与桌面端同一处。 */
export function defaultMailboxRoot(): string {
  return path.join(defaultConfigDir(), "mailbox")
}

/**
 * 克隆目录 = f(远端, 分支, 角色)。**分支必须进 key**。
 *
 * 克隆是"某个远端某条分支的工作副本",而 `ensureClone` 见到 `.git/HEAD` 就早返回、
 * 从不改分支。于是复用一个停在旧分支的克隆去跑新分支时,`cloneMailbox` 里那段孤儿
 * 分支逻辑根本不会跑,init 走到最后 `push -u origin <新分支>:<新分支>` 直接报
 * `src refspec <新分支> does not match any` —— 一个和"信箱配错了"毫无关系的 git 报错
 * (实测复现过)。换分支 = 换目录,是这条路上唯一不需要用户手动去删缓存的解法。
 *
 * 分支归一到 main:留空与显式写 main 是同一件事(sync.ts 的 `branchOf` 就这么定的),
 * 不归一的话同一条分支会有两个克隆,而且用户看不出为什么。
 * key 用 `\n` 分隔 —— 分支名不能含换行,所以 (远端, 分支) 的拼接不会撞车。
 */
export function cloneDirFor(mailboxRoot: string, remote: string, role: string, branch?: string): string {
  const hash = createHash("sha1")
    .update(`${remote}\n${branch?.trim() || "main"}`)
    .digest("hex")
    .slice(0, 10)
  return path.join(mailboxRoot, "clones", hash, role)
}
