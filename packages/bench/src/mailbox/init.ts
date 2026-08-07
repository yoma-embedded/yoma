/**
 * 信箱初始化 —— 把总任务书和第一轮指令放进信箱。
 *
 * 第一轮指令**不经母 agent**:它是固定的复现纪律(firstPrompt —— 只准复现取证,
 * 不准改代码)。母 agent 的职责是"看证据做判断",而第一轮之前没有任何证据可看;
 * 让它凭空写第一条指令,产出的只会是任务书的复述。
 *
 * job.json 写的是**归一化后的 spec**(默认值全部落成显式字段):两侧机器各自
 * parse 同一份文件,归一化让"缺省值在两边不一样"这类漂移无处藏身。
 */

import { firstPrompt } from "../prompts.ts"
import { scanMailbox, writeInstruction, writeJson, JOB_FILE } from "./store.ts"
import { commitPush, pullReset, type MailboxSyncContext } from "./sync.ts"
import type { MailboxJob } from "./spec.ts"
import path from "node:path"

const INIT_AUTHOR = { name: "yoma-mailbox-init", email: "bench@yoma.local" }

/** MailboxJob → 信箱里 job.json 的平铺形态(与手写 spec 同构,parseMailboxJob 可回读)。 */
export function serializeMailboxJob(mailboxJob: MailboxJob): Record<string, unknown> {
  return { ...mailboxJob.job, mailbox: mailboxJob.mailbox }
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

  const now = options.now ?? Date.now
  await writeJson(path.join(options.clone, JOB_FILE), serializeMailboxJob(options.mailboxJob))
  await writeInstruction(options.clone, {
    round: 1,
    prompt: firstPrompt(options.mailboxJob.job),
    issuedBy: "init",
    at: new Date(now()).toISOString(),
  })
  const pushed = await commitPush(sync, `init: ${options.mailboxJob.job.title}(${options.mailboxJob.job.id})`)
  if (!pushed.pushed) return { initialized: false, detail: pushed.detail ?? "初始化提交推不上去" }
  return { initialized: true, detail: `任务已入信箱,第 1 轮指令(复现取证)已下发` }
}
