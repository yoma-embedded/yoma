/**
 * 信箱的 git 同步 —— 协议的"传输面"。
 *
 * ## 为什么 pull 是 reset --hard 而不是 merge/rebase
 *
 * 信箱克隆是**机器的工作副本,不是人的工作区**:两个角色只通过"提交并推送"发言,
 * 本地未提交的文件一律是上次崩溃留下的残渣。`fetch + reset --hard + clean -fd` 让
 * 工作树永远等于远端已推的真相 —— 于是"runner 写了一半 result 没推就崩了"这类状态
 * 在重启后自动消失,协议回到"重跑本步",不需要任何恢复逻辑。
 *
 * ## 为什么 push 失败要 pull --rebase 重试
 *
 * 两个写者按协议只交替写不相交的路径(mother 写 instruction/decision/verdict,
 * runner 写 result/patch),结构上不会冲突;但 push 到达远端的顺序仍可能交错
 * (mother 刚推完下一轮指令,runner 的上一轮结果才推到)。rebase 把我们的提交叠到
 * 新头上,路径不相交所以必然干净。三次都失败就是网络/权限级的问题,如实报错。
 *
 * 所有 git 调用 argv 直接 spawn 不过 shell(复用 git.ts),URL 和路径可以含任何字符。
 *
 * ## 信箱必须逐字节透明
 *
 * 信箱是两台机器之间唯一的通道:研发端的附件(固件、诊断脚本)与工位端的回传(串口日志、截图)
 * 都靠它原样送达。而 Git for Windows 的安装器缺省把 `core.autocrlf=true` 写进**系统级**配置 ——
 * 工位机正是 Windows:
 * - 下行:文本附件落地时 LF 被换成 CRLF。Git Bash 脚本直接跑不了(行尾多出一个回车,报
 *   "command not found"),靠文件哈希做自证的(构建指纹)两边对不上。
 * - 上行:工位端回传的串口日志本来是 CRLF 结尾,提交时被规整成 LF —— **证据被悄悄改写**,而这套
 *   系统的产品正是证据。
 * 两头都不报错。2026-09-18 在 Windows 上第一次跑 bench 的全量单测才露出来(host.test 读回的附件
 * 多了一个回车);CI 的 Windows 岗从前不跑 bench。
 *
 * 两道防线,各管一种对方够不着的情形:
 * - **每个克隆的 `.git/info/attributes` 写 `* -text`**(ensureByteTransparent):属性里优先级最高的一档,
 *   压过任何一级的 autocrlf 与用户级 attributes 文件;不进提交,所以已经在跑的旧信箱下一次同步就生效。
 *   克隆那一下另带 `-c core.autocrlf=false`:首次检出发生在 clone 内部,那时 info/attributes 还不存在。
 * - **信箱根上提交一份 `.gitattributes`**(init 写):对面那台机器跑的可能是没有这个修复的旧版本,
 *   也可能有人手工 `git clone` 出来看 —— 跟着仓走的这一份对它们同样生效。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { fileExists } from "../fsx.ts"
import { runGitReal, type GitOutcome, type GitRunner } from "../git.ts"

export interface MailboxSyncContext {
  /** 信箱克隆目录。 */
  clone: string
  /** 信箱分支,默认 main。 */
  branch?: string
  /** 提交归属:runner / mother 各报各的名,审计时一眼看出是谁在说话。 */
  author: { name: string; email: string }
  run?: GitRunner
}

const PUSH_RETRIES = 3

function branchOf(context: MailboxSyncContext): string {
  return context.branch ?? "main"
}

async function git(context: MailboxSyncContext, ...args: string[]): Promise<GitOutcome> {
  return (context.run ?? runGitReal)(args, context.clone)
}

/**
 * 建一个裸仓当本地"远端"(单机模拟、或局域网共享盘当信箱时用)。
 * HEAD 显式指到 main —— 不同 git 版本的默认分支名不同,不钉住的话克隆端会各自为政。
 */
export async function initBareMailbox(dir: string, options?: { run?: GitRunner; branch?: string }): Promise<void> {
  const run = options?.run ?? runGitReal
  const branch = options?.branch ?? "main"
  const init = await run(["init", "--bare", "-q", dir], ".")
  if (!init.ok) throw new Error(`建裸仓失败:${init.stderr}`)
  const head = await run(["symbolic-ref", "HEAD", `refs/heads/${branch}`], dir)
  if (!head.ok) throw new Error(`设裸仓 HEAD 失败:${head.stderr}`)
}

/** 克隆信箱。空仓也能克隆(git 会警告,不是错误),之后第一推建出分支。 */
export async function cloneMailbox(
  url: string,
  dir: string,
  options?: { run?: GitRunner; branch?: string },
): Promise<void> {
  const run = options?.run ?? runGitReal
  // -c core.autocrlf=false:首次检出发生在 clone 内部,那时 info/attributes 还不存在(见文件头)。
  const clone = await run(["clone", "-q", "-c", "core.autocrlf=false", url, dir], ".")
  if (!clone.ok) throw new Error(`克隆信箱失败:${clone.stderr}`)
  await ensureByteTransparent(dir)
  const branch = options?.branch ?? "main"
  const current = await run(["rev-parse", "--abbrev-ref", "HEAD"], dir)
  if (current.ok && current.stdout === branch) return

  if ((await run(["rev-parse", "--verify", "-q", `origin/${branch}`], dir)).ok) {
    await run(["checkout", "-q", branch], dir)
    return
  }

  // 远端还没有这条分支(一个信箱仓跑第二个任务时的常态)。**必须从空树起**:
  // `checkout -B` 会从默认分支的 HEAD 分叉,于是上一个任务的 job.json/rounds/
  // verdict.json 原样跟过来 —— 新任务一开局就被扫成"已终局",而且 pullReset 帮不上忙
  // (远端分支不存在时它什么都不做)。孤儿分支 + 清索引 + 清工作树才是"空信箱"。
  // clean **不带 -x**:两侧的本地状态(会话指针、token 账本)住在被 ignore 的目录里,
  // 那是它们的护身符,不能一起扫掉。
  await run(["checkout", "-q", "--orphan", branch], dir)
  await run(["rm", "-rq", "--cached", "--ignore-unmatch", "."], dir)
  await run(["clean", "-qfd"], dir)
}

/**
 * 克隆若已在(续跑)就复用,但必须核对 origin 与要求的远端一致 —— 否则"换了远端
 * 继续跑"会静默对着旧远端说话,屏幕上却打印着新地址(sim 首跑时实测复现过)。
 *
 * **分支同样要核对**,而且理由更硬:复用分支不对的克隆不会静默,会在很远的地方炸。
 * 这里早返回就不改分支,于是 cloneMailbox 里的孤儿分支逻辑不会跑,克隆一直停在旧
 * 分支;`pullReset` 因为 `origin/<新分支>` 不存在而什么都不做,init 因此以为信箱是
 * 空的,一路走到 `push -u origin <新分支>:<新分支>` 才报
 * `src refspec <新分支> does not match any` —— 一个跟"信箱配错了"毫无关系的 git 报错
 * (实测复现过)。宁可在这一步用人话拦下。
 */
export async function ensureClone(
  remote: string,
  dir: string,
  options?: { run?: GitRunner; branch?: string },
): Promise<void> {
  const run = options?.run ?? runGitReal
  if (await fileExists(path.join(dir, ".git", "HEAD"))) {
    const url = await run(["remote", "get-url", "origin"], dir)
    if (!url.ok || normalizeRemote(url.stdout) !== normalizeRemote(remote)) {
      throw new Error(
        `${dir} 的 origin(${url.stdout || "读不出来"})与要求的远端(${remote})不一致 —— 换远端请换个克隆目录,或清掉旧克隆`,
      )
    }
    // `branch --show-current` 而不是 `rev-parse --abbrev-ref HEAD`:后者对未出生的
    // 分支(孤儿 checkout 之后、首次提交之前)答 "HEAD",会把正常状态误判成不一致。
    const branch = options?.branch ?? "main"
    const current = await run(["branch", "--show-current"], dir)
    if (current.ok && current.stdout !== branch) {
      throw new Error(
        `${dir} 停在分支 ${current.stdout || "(游离 HEAD)"},与要求的分支 ${branch} 不一致 —— 换分支请换个克隆目录,或清掉旧克隆`,
      )
    }
    return
  }
  await cloneMailbox(remote, dir, options)
}

/** 远端地址归一:URL/带用户名的 SSH 原样比,本地路径按绝对路径比。 */
export function normalizeRemote(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  return /^[a-z+]+:\/\//i.test(trimmed) || trimmed.includes("@") ? trimmed : path.resolve(trimmed)
}

/**
 * 每个入口都绕不过的闸门:**克隆当前所在分支必须等于要跑的分支**。
 *
 * 合法流程里这条永远成立(`cloneMailbox` 负责把克隆放到对的分支上)。破坏它的只有
 * 两种情况:手工 `git clone` 之后带 `--branch 别的` 起守护,或者复用一个停在旧分支的
 * 克隆(`ensureClone` 见到 `.git/HEAD` 就早返回)。
 *
 * 不拦的后果比"报错难看"严重得多 —— 是**照着别的任务的指令去动板子**:
 * `pullReset` 在 `origin/<新分支>` 不存在时什么都不做(那是首推前的合法状态),
 * 于是工作树还是旧分支的内容,扫描器照常读到**上一个任务**的 job.json 与待执行轮,
 * 工位端真的会烧片、动板子,跑完一整轮才在 push 那一下报
 * `src refspec <新分支> does not match any`。子 agent 的调查脚本实测复现过:
 * 硬件动作真的发生了,提示词里是另一个任务的指令。
 *
 * 所以拦在**最前面**:模型没调、板子没动之前就停。
 */
/** 跟着信箱仓走的那一份(init 提交);与 info/attributes 是同一条规则。 */
export const MAILBOX_ATTRIBUTES_FILE = ".gitattributes"
const NO_EOL_CONVERSION = "* -text"
export const MAILBOX_ATTRIBUTES_TEXT = [
  "# yoma mailbox: byte-for-byte between the two machines. No line-ending conversion on either side,",
  "# whatever core.autocrlf says (Git for Windows turns it on system-wide).",
  NO_EOL_CONVERSION,
  "",
].join("\n")

/**
 * 给这个克隆的 `.git/info/attributes` 写上 `* -text`(理由见文件头)。幂等:已有这一行就不动,
 * 文件里别的规则原样保留。走文件系统而不是 `git config`:守护每次轮询都经过这里,不值得多起一个
 * 子进程;注入的假 runner 也看不见多出来的一次调用。
 *
 * 写不了(`.git` 不是目录的 worktree、只读盘)不抛 —— 那时还有仓里提交的那份 `.gitattributes` 兜着,
 * 为一道防线的失败停掉整个守护不值得。
 */
export async function ensureByteTransparent(clone: string): Promise<void> {
  const file = path.join(clone, ".git", "info", "attributes")
  try {
    const current = await readFile(file, "utf8").catch(() => "")
    if (current.split(/\r?\n/).some((line) => line.trim() === NO_EOL_CONVERSION)) return
    await mkdir(path.dirname(file), { recursive: true })
    const head = current === "" || current.endsWith("\n") ? current : `${current}\n`
    await writeFile(file, `${head}${NO_EOL_CONVERSION}\n`)
  } catch {
    // 见上:交给提交进仓的那一份。
  }
}

async function assertOnBranch(context: MailboxSyncContext): Promise<void> {
  // 每个同步入口都经过这道闸门,于是已经在跑的旧克隆(建的时候还没有这条规矩)下一次同步就补上。
  await ensureByteTransparent(context.clone)
  const branch = branchOf(context)
  const current = await git(context, "branch", "--show-current")
  if (current.stdout === branch) return
  throw new Error(
    `${context.clone} 停在分支 ${current.stdout || "(游离 HEAD)"},而要跑的是 ${branch} —— ` +
      `再往下走会照着另一条分支上的任务动板子。换个克隆目录,或在这个克隆里切到 ${branch}。`,
  )
}

/**
 * 守护进程的同步入口:先把上次没推上去的本地提交推完,再对齐远端真相。
 *
 * pullReset 的"工作树永远等于远端"语义有一个昂贵的反面:push 失败(断网、远端
 * 暂时只读)后,已经**完整跑完并本地提交**的一步会在下次同步被 reset 丢掉、整步
 * 重跑 —— 模型和硬件的花费加倍(真跑第一次撞上断网就中了)。所以欠账能快进推走
 * 就先推走;推不动(远端在协议上超前,说明这步已被替代)才交给 pullReset 清场。
 */
export async function flushThenPullReset(context: MailboxSyncContext): Promise<{ remoteHead?: string }> {
  const branch = branchOf(context)
  await assertOnBranch(context)
  const localHead = await git(context, "rev-parse", "--verify", "-q", "HEAD")
  if (localHead.ok) {
    const remote = await git(context, "rev-parse", "--verify", "-q", `origin/${branch}`)
    // 远端引用缺失(首推失败的欠账)或本地严格超前(push 失败的欠账)都先推;
    // 已同步、落后或分叉则不推 —— 那些是 pullReset 的地盘。
    const ahead =
      !remote.ok ||
      (remote.stdout !== localHead.stdout &&
        (await git(context, "merge-base", "--is-ancestor", `origin/${branch}`, "HEAD")).ok)
    if (ahead) await pushWithRetry(context, branch)
  }
  return pullReset(context)
}

/**
 * 同步到远端真相。远端分支还不存在(信箱刚建)时保持本地现状 —— 那正是第一推之前的
 * 合法状态。返回远端头,便于调用方判断"这轮询有没有新东西"。
 */
export async function pullReset(context: MailboxSyncContext): Promise<{ remoteHead?: string }> {
  const branch = branchOf(context)
  await assertOnBranch(context)
  const fetch = await git(context, "fetch", "-q", "origin")
  if (!fetch.ok) throw new Error(`fetch 信箱失败:${fetch.stderr}`)

  const remote = await git(context, "rev-parse", "--verify", "-q", `origin/${branch}`)
  if (!remote.ok) return {}

  const reset = await git(context, "reset", "-q", "--hard", `origin/${branch}`)
  if (!reset.ok) throw new Error(`reset 到远端真相失败:${reset.stderr}`)
  const clean = await git(context, "clean", "-qfd")
  if (!clean.ok) throw new Error(`清理信箱残渣失败:${clean.stderr}`)
  return { remoteHead: remote.stdout }
}

/**
 * 把当前全部改动作为一次发言提交并推送。
 *
 * 没有新改动时通常不提交不推送 —— 但有一个例外:本地攒着**上次没推上去的提交**
 * (首推失败的残骸)。那时必须把旧账推完,否则 init 重试会永远看到"信箱不是空的"
 * 而远端其实一无所有(实测复现过的死锁)。
 */
export async function commitPush(
  context: MailboxSyncContext,
  message: string,
): Promise<{ committed: boolean; pushed: boolean; detail?: string }> {
  const branch = branchOf(context)
  const add = await git(context, "add", "-A")
  if (!add.ok) return { committed: false, pushed: false, detail: `git add 失败:${add.stderr}` }

  const status = await git(context, "status", "--porcelain")
  if (status.ok && status.stdout === "") {
    const localHead = await git(context, "rev-parse", "--verify", "-q", "HEAD")
    if (!localHead.ok) return { committed: false, pushed: false }
    const remoteHead = await git(context, "rev-parse", "--verify", "-q", `origin/${branch}`)
    // pullReset 语义下,远端分支存在时本地必与之相等 —— 只有"远端分支还没建出来、
    // 本地却有提交"这一种欠账形态。
    if (remoteHead.ok) return { committed: false, pushed: false }
    const pushed = await pushWithRetry(context, branch)
    return { committed: false, ...pushed }
  }

  const commit = await git(
    context,
    "-c",
    `user.name=${context.author.name}`,
    "-c",
    `user.email=${context.author.email}`,
    "commit",
    "-q",
    "-m",
    message,
  )
  if (!commit.ok) return { committed: false, pushed: false, detail: `git commit 失败:${commit.stderr}` }

  const pushed = await pushWithRetry(context, branch)
  return { committed: true, ...pushed }
}

async function pushWithRetry(
  context: MailboxSyncContext,
  branch: string,
): Promise<{ pushed: boolean; detail?: string }> {
  let last = ""
  for (let attempt = 1; attempt <= PUSH_RETRIES; attempt += 1) {
    const push = await git(context, "push", "-q", "-u", "origin", `${branch}:${branch}`)
    if (push.ok) return { pushed: true }
    last = push.stderr
    // 对方刚说过话 —— 把我们的发言叠上去再推。路径按协议不相交,rebase 必然干净。
    // 远端分支还不存在(信箱首推的瞬时失败)时没有可叠的东西,原样直接重试。
    await git(context, "fetch", "-q", "origin")
    if (!(await git(context, "rev-parse", "--verify", "-q", `origin/${branch}`)).ok) continue
    // rebase 会重写提交,必须带上 author —— CI runner 和干净克隆都没有
    // user.name,漏掉时 pull --rebase 静默失败,表现成"第 2 轮工位端空转"。
    const rebase = await git(
      context,
      "-c",
      `user.name=${context.author.name}`,
      "-c",
      `user.email=${context.author.email}`,
      "pull",
      "-q",
      "--rebase",
      "origin",
      branch,
    )
    if (!rebase.ok) {
      await git(context, "rebase", "--abort")
      // 别急着定性成协议冲突:实战里第一次撞见的是网络在这一步断掉。原话如实上报。
      return { pushed: false, detail: `pull --rebase 失败:${rebase.stderr}` }
    }
  }
  return { pushed: false, detail: `push ${PUSH_RETRIES} 次仍失败:${last}` }
}
