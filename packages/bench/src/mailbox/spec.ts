/**
 * 信箱任务 spec —— 跨机器多轮调试闭环的总任务书。
 *
 * ## 这是什么
 *
 * 一份信箱任务 = 一份普通 bench job(工程标识、硬件、任务描述、预算)+ 一个 `mailbox`
 * 段(研发端的模型与分析预算、轮询间隔、附件上限)。两个角色共用这一份文件:
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
 * `mailbox` 段里只放**两侧协作**才需要的东西(研发端的模型与分析预算、轮询间隔、
 * 附件上限);任务本身的字段(硬件、预算、模型)在 Job 里,信箱模式没有改变它们的语义。
 *
 * 预算三旋钮全在 `job.budget` 里,也全部由 mother 在**裁决点**强制:
 * - `maxRounds` 轮数上限;
 * - `maxTokens` 按**两侧合计**(runner 花的 + mother 花的);
 * - `wallClockMin` 粒度是轮,不是分钟级抢占(轮内另有单轮硬超时兜底)——
 *   没有它,闭环会在没人看的机器上连跑十几个小时。
 */

import { readTextFile } from "../fsx.ts"
import { parseJob, JobSpecError, type Job } from "../job.ts"

export interface MailboxMotherConfig {
  /** 母 agent 用的模型。要么 providerID+modelID 齐,要么整个不填(落到 job.model → 内核默认)。 */
  model?: { providerID?: string; modelID?: string }
  /**
   * 单次分析的 token 上限。母 agent 只做判断不做实验,预算应远小于调试轮 ——
   * 但注意口径:计的是 input+output,而 mother 会话跨轮延续,后期轮单次 input 里
   * 含全部会话历史。设得太小会在最接近收尾的轮误触发"分析被中断"。缺省 20 万够用。
   */
  maxTokensPerAnalysis: number
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
}

export interface MailboxJob {
  job: Job
  mailbox: MailboxConfig
}

export const DEFAULT_MOTHER_ANALYSIS_TOKENS = 200_000
export const DEFAULT_POLL_SECONDS = 15
export const DEFAULT_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/** 解析信箱任务:先过 parseJob(它管 job 部分的全部校验),再收 mailbox 段。 */
export function parseMailboxJob(raw: unknown): MailboxJob {
  const job = parseJob(raw)
  const issues: string[] = []

  const mailboxRaw = isObject(raw) && isObject((raw as Record<string, unknown>).mailbox) ? ((raw as Record<string, unknown>).mailbox as Record<string, unknown>) : {}
  const motherRaw = isObject(mailboxRaw.mother) ? mailboxRaw.mother : {}
  const modelRaw = isObject(motherRaw.model) ? motherRaw.model : undefined

  const maxTokensPerAnalysis = num(motherRaw.maxTokensPerAnalysis) ?? DEFAULT_MOTHER_ANALYSIS_TOKENS
  if (maxTokensPerAnalysis < 1) issues.push("mailbox.mother.maxTokensPerAnalysis 至少为 1")

  const pollSeconds = num(mailboxRaw.pollSeconds) ?? DEFAULT_POLL_SECONDS
  if (pollSeconds < 1) issues.push("mailbox.pollSeconds 至少为 1")

  const maxArtifactBytes = num(mailboxRaw.maxArtifactBytes) ?? DEFAULT_MAX_ARTIFACT_BYTES
  if (maxArtifactBytes < 1) issues.push("mailbox.maxArtifactBytes 至少为 1")

  if (issues.length) throw new JobSpecError(issues)

  return {
    job,
    mailbox: {
      mother: {
        model: modelRaw ? { providerID: str(modelRaw.providerID), modelID: str(modelRaw.modelID) } : undefined,
        maxTokensPerAnalysis,
      },
      pollSeconds,
      maxArtifactBytes,
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
