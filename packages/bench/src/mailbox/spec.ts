/**
 * 信箱任务 spec —— 跨机器多轮调试闭环的总任务书。
 *
 * ## 这是什么
 *
 * 一份信箱任务 = 一份普通 bench job(工程标识、硬件、任务描述)+ 一个 `mailbox`
 * 段(研发端的模型、轮询间隔、附件上限)。两个角色共用这一份文件:
 *
 * - **mother**(研发端,有构建环境):读结果 → 改代码 → 构建 → 把产物当附件塞进本轮 →
 *   用大白话写指令;
 * - **runner**(工位端,连着板子):领指令与附件 → 上板(怎么上由它自己定)→ 观察复现 →
 *   回填看到的现象。它**没有项目检出**,工作目录里只有附件。
 *
 * 两边只通过一个 git 仓库(信箱)通信,不共享文件系统、不开端口。
 *
 * **这份文件里不该出现绝对路径**:它要在两台机器上被读。工程目录是本机事实,由各自
 * 的守护配置提供(见 `resolveWorkspace`)。
 *
 * ## 为什么复用 Job 而不是另起一套
 *
 * `mailbox` 段里只放**两侧协作**才需要的东西(研发端的模型、轮询间隔、附件上限);
 * 任务本身的字段(硬件、模型)在 Job 里,信箱模式没有改变它们的语义。
 *
 * **spec 里没有任何上限字段**:跑多少轮、花多少 token,由研发端 agent 自己判断 ——
 * 它判 `done` 或 `fail` 才收工(为什么归它,见 mother.ts 头部的「谁裁决」)。
 * 要提前停就在桌面端按停止(或杀掉守护进程)。
 */

import { readTextFile } from "../fsx.ts"
import { parseJob, parseModelSpec, JobSpecError, type Job, type JobModel } from "../job.ts"

export interface MailboxMotherConfig {
  /**
   * 母 agent 用的模型。要么 providerID+modelID 齐,要么整个不填 —— 不填就跟着
   * `job.model` 走,而它在 parseJob 里已经落定(任务书没写模型就是调试台的
   * `DEFAULT_MODEL`,即 DeepSeek V4 Flash)。于是**两端默认同一个模型**。
   *
   * `thinking` 是个例外:它**单独生效**,不受"要么齐要么不填"的约束(见
   * mother.ts 的 motherJob)。研发端那侧才是做根因分析、写指令的,让它在同一个模型上
   * 想得更狠是常见需求,不该逼着连 providerID/modelID 一起抄一遍。
   */
  model?: JobModel
}

export interface MailboxConfig {
  mother: MailboxMotherConfig
  /** 两侧守护进程的轮询间隔(秒)。CLI 的 --interval 可覆盖。 */
  pollSeconds: number
  /**
   * 单轮附件合计上限(字节)。信箱是个 git 仓,每轮塞一个几十 MB 的 ELF 会让它
   * 一直长大而且永远瘦不回去(git 不忘事)。默认 32MB —— 一个带调试信息的
   * Cortex-M 固件通常 1–5MB,留了足够余量,又拦得住"把整个 build 目录附上"。
   */
  maxArtifactBytes: number
  /**
   * 单轮**回传**合计上限(字节)。方向反过来但物理性质一样:信箱仓不忘事,而上行的
   * 诱惑更大 —— 一次 16kHz 全采就能是几十 MB,工位端又不知道自己在给一个 git 仓喂东西。
   * 默认 16MB:压缩过的采集/日志/几张图都装得下,而"把整个采集目录倒进来"会被拦住。
   *
   * 超限的处理与下行**不同**:下行报错拦住研发端,上行只跳过并记进 `backSkipped`
   * (见 collectBack —— 不能因为一个大文件把整轮结果毙掉)。
   */
  maxBackBytes: number
}

export interface MailboxJob {
  job: Job
  mailbox: MailboxConfig
}

export const DEFAULT_POLL_SECONDS = 15
export const DEFAULT_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024
export const DEFAULT_MAX_BACK_BYTES = 16 * 1024 * 1024

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** 解析信箱任务:先过 parseJob(它管 job 部分的全部校验),再收 mailbox 段。 */
export function parseMailboxJob(raw: unknown): MailboxJob {
  const job = parseJob(raw)
  const issues: string[] = []

  const mailboxRaw = isObject(raw) && isObject(raw.mailbox) ? raw.mailbox : {}
  const motherRaw = isObject(mailboxRaw.mother) ? mailboxRaw.mother : {}
  const motherModel = parseModelSpec(motherRaw.model, "mailbox.mother.model", issues)

  const pollSeconds = num(mailboxRaw.pollSeconds) ?? DEFAULT_POLL_SECONDS
  if (pollSeconds < 1) issues.push("mailbox.pollSeconds 至少为 1")

  const maxArtifactBytes = num(mailboxRaw.maxArtifactBytes) ?? DEFAULT_MAX_ARTIFACT_BYTES
  if (maxArtifactBytes < 1) issues.push("mailbox.maxArtifactBytes 至少为 1")

  const maxBackBytes = num(mailboxRaw.maxBackBytes) ?? DEFAULT_MAX_BACK_BYTES
  if (maxBackBytes < 1) issues.push("mailbox.maxBackBytes 至少为 1")

  if (issues.length) throw new JobSpecError(issues)

  return {
    job,
    mailbox: {
      mother: { model: motherModel },
      pollSeconds,
      maxArtifactBytes,
      maxBackBytes,
    },
  }
}

export async function loadMailboxJob(file: string): Promise<MailboxJob> {
  const raw = await readTextFile(file)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new JobSpecError([`${file} 不是合法 JSON:${(error as Error).message}`])
  }
  return parseMailboxJob(parsed)
}
