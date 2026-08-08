/**
 * 信箱初始化 —— 把总任务书放进信箱。**只放任务书**。
 *
 * 第一轮指令由**研发端**出(见 mother.ts 的 kickoff):开局做什么本来就是判断
 * (先复现?先加一条日志再复现?先烧 known-good 排除环境?),把它固化成 init 写死的
 * 一句"只复现取证",等于在最需要判断的地方绕开了 agent。而研发端在开局就能动手 ——
 * 它有代码和构建环境,第一轮就可以带着新固件下发。
 *
 * job.json 写的是**归一化后的 spec**(默认值全部落成显式字段):两侧机器各自
 * parse 同一份文件,归一化让"缺省值在两边不一样"这类漂移无处藏身。**里面不该有
 * 绝对路径** —— 工程目录是本机事实,由两侧各自的守护配置提供。
 */

import { scanMailbox, writeJson, JOB_FILE } from "./store.ts"
import { commitPush, pullReset, type MailboxSyncContext } from "./sync.ts"
import type { MailboxJob } from "./spec.ts"
import path from "node:path"

const INIT_AUTHOR = { name: "yoma-mailbox-init", email: "bench@yoma.local" }

/**
 * MailboxJob → 信箱里 job.json 的平铺形态(与手写 spec 同构,parseMailboxJob 可回读)。
 *
 * `repo.directory` **被摘掉**:它是出题那台机器的绝对路径,在收件方那儿不存在,
 * 留着只会让人以为它有意义。工程目录由每台机器自己配(见 resolveWorkspace)。
 */
export function serializeMailboxJob(mailboxJob: MailboxJob): Record<string, unknown> {
  const { directory: _dropped, ...repo } = mailboxJob.job.repo
  return { ...mailboxJob.job, repo, mailbox: mailboxJob.mailbox }
}

export async function initMailbox(options: {
  clone: string
  branch?: string
  mailboxJob: MailboxJob
  gitRun?: MailboxSyncContext["run"]
  now?: () => number
}): Promise<{ initialized: boolean; detail: string }> {
  const sync: MailboxSyncContext = {
    clone: options.clone,
    branch: options.branch,
    author: INIT_AUTHOR,
    run: options.gitRun,
  }
  const { remoteHead } = await pullReset(sync)

  const snapshot = await scanMailbox(options.clone)
  if (snapshot.state.kind !== "empty" && remoteHead) {
    return { initialized: false, detail: `信箱不是空的(状态:${snapshot.state.kind})—— 一个信箱一次只跑一个任务` }
  }
  // 远端连分支都没有时,本地的"非空"只能是上次 init push 失败留下的残骸(轮次结果
  // 必须经远端才可能出现)。照常覆盖重写 —— 拒绝会把信箱永远锁死在幽灵状态。

  await writeJson(path.join(options.clone, JOB_FILE), serializeMailboxJob(options.mailboxJob))
  const pushed = await commitPush(sync, `init: ${options.mailboxJob.job.title}(${options.mailboxJob.job.id})`)
  if (!pushed.pushed) return { initialized: false, detail: pushed.detail ?? "初始化提交推不上去" }
  return { initialized: true, detail: "任务已入信箱,等研发端下发第一轮" }
}
