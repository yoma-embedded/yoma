/**
 * job spec:一个文件即一个任务。
 *
 * 校验是手写的而不是 zod —— bench 直接跑源码不打包,少一个依赖少一处 install graph 的
 * 风险;而且这里要的不只是"类型对",是**把人能犯的错在开跑前说清楚**(id 里带斜杠、
 * 任务描述空着),错误消息要指名道姓到字段路径。
 *
 * `task` 是这份 spec 的心脏 —— 它是 agent 唯一的任务来源。通过与否由研发端 agent
 * 读工位端回填的证据来判断,没有独立的判据机制;**什么时候停也归它判断**,
 * 没有轮数/token/墙钟上限。要提前收工就在桌面端按停止。
 */

import path from "node:path"

import { DEFAULT_THINKING_LEVEL, THINKING_LEVELS } from "@yoma-desktop/kernel"

import { readTextFile } from "./fsx.ts"

export interface JobRepo {
  /**
   * 仓库工作树所在目录 —— **研发端**的本机事实。
   *
   * 信箱模式下不该写进任务书:一份 job.json 要在两台机器上用,而出题那台机器的
   * `/Users/ben/…` 在别处不存在。研发端守护从本机配置拿工程目录
   * (`resolveWorkspace` 的 localDir)。工位端根本不需要检出。
   */
  directory?: string
  /** 工程名,给人看、也给本机配置对号入座。缺省取 job.id。 */
  name?: string
  /** 起始 ref。给了就在准备阶段 checkout,不给就用当前 HEAD。 */
  ref?: string
  /** agent 的工作分支名,默认 `agent/<jobId>`。 */
  branch?: string
}

export interface JobBench {
  /** 板卡标识,给人看、也进工位端的提示词。 */
  board?: string
  /** probe-rs 的芯片名,如 STM32G474RE。烧录与 gdb 都要,进工位端的提示词。 */
  chip?: string
  /** 探针选择器 "VID:PID" 或 "VID:PID:Serial"。多探针工位必填。 */
  probe?: string
}

export interface JobDeliver {
  /** 通过后是否推分支。 */
  push?: boolean
  /** 是否建 MR/PR(需要 gh 或 glab)。 */
  mr?: boolean
  remote?: string
}

export interface JobModel {
  /** 要么和 modelID 一起填,要么整个不填(运行时再从本机已有凭据的模型里挑)。 */
  providerID?: string
  modelID?: string
  /**
   * 思考档位:`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。
   *
   * **不填不等于关掉** —— 落到调试台自己的默认(kernel 的 `DEFAULT_THINKING_LEVEL`,
   * 即 `max`)。写 `"off"` 才是显式关掉。填了模型不支持的档位会被自动落到最近的一档,
   * 所以两侧机器换模型不会因此跑不起来。
   */
  thinking?: string
}

/**
 * 任务书没写模型时,**优先**试这个 —— 但只在这台机器已经有这家凭据时。
 *
 * 以前 parseJob 会把这个组合写进 job.json,没配 DeepSeek 的机器第一轮直接
 * `未知模型 deepseek/…`。现在任务书里可以不钉模型,运行时再从本机已认证的
 * 目录里挑(见 {@link pickAvailableModel})。
 *
 * 仍把 Flash 放在第一候选:档位表和 Pro 一样(high/max),单价大约三分之一,
 * 省下的换成思考。任务书写了完整 model 则听任务书的,两端一致。
 */
export const DEFAULT_MODEL = {
  providerID: "deepseek",
  modelID: "deepseek-v4-flash",
} as const

export interface Job {
  id: string
  title: string
  repo: JobRepo
  bench: JobBench
  /** 交给 agent 的任务描述:现象、复现步骤、期望行为、工位与安全约束。 */
  task: string
  deliver?: JobDeliver
  model?: JobModel
}

export class JobSpecError extends Error {
  constructor(readonly issues: string[]) {
    super(`job spec 有 ${issues.length} 处问题:\n  - ${issues.join("\n  - ")}`)
    this.name = "JobSpecError"
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

/**
 * 解析一段 model 配置(`job.model` 与 `mailbox.mother.model` 同构)。
 *
 * 档位在**开跑前**校验:内核那边 `pickThinkingLevel` 会把不认识的值落到该模型的
 * 第一档,于是任务书里的错字("hight")表现为"档位没生效",而不是报错 —— 这正是
 * 最难归因的一类。`fieldPath` 进错误消息,让人知道该改哪一行。
 */
export function parseModelSpec(raw: unknown, fieldPath: string, issues: string[]): JobModel | undefined {
  if (!isObject(raw)) return undefined
  const thinking = str(raw.thinking)
  if (thinking && !THINKING_LEVELS.includes(thinking))
    issues.push(`${fieldPath}.thinking "${thinking}" 不是合法档位(${THINKING_LEVELS.join(" / ")})`)
  return { providerID: str(raw.providerID), modelID: str(raw.modelID), thinking }
}

/**
 * `job.model` 的落定:模型**要么齐(providerID+modelID)要么运行时再挑**,
 * 档位单独落 —— 与 `mailbox.mother.model` 的规矩同一套(见 mother.ts 的 motherTurnJob)。
 *
 * 只填一半的模型不去猜另一半:补出来的 `deepseek/<别家的模型>` 会在第一轮 setModel
 * 上报"未知模型",而那时人已经离开了。不钉 DeepSeek,让 {@link pickAvailableModel}
 * 对着这台机器已经能用的目录挑。
 */
function resolveJobModel(model: JobModel | undefined): JobModel {
  const pinned = model?.providerID && model.modelID ? model : undefined
  return {
    providerID: pinned?.providerID,
    modelID: pinned?.modelID,
    thinking: model?.thinking ?? DEFAULT_THINKING_LEVEL,
  }
}

export interface ModelCatalogEntry {
  id: string
  authenticated: boolean
  models: { id: string }[]
}

/**
 * 任务书没钉模型时,从本机目录挑一个能用的。
 *
 * 有 DeepSeek Flash 凭据就用它(团队默认);否则用第一个已认证 provider 的第一个模型。
 * 一个 key 都没有时返回 undefined,调用方不要 setModel,让内核走自己的空目录错误。
 */
export function pickAvailableModel(
  catalog: ModelCatalogEntry[],
  preferred: { providerID: string; modelID: string } = DEFAULT_MODEL,
): { providerID: string; modelID: string } | undefined {
  const preferredProvider = catalog.find((provider) => provider.id === preferred.providerID && provider.authenticated)
  if (preferredProvider?.models.some((model) => model.id === preferred.modelID)) {
    return { providerID: preferred.providerID, modelID: preferred.modelID }
  }
  const first = catalog.find((provider) => provider.authenticated && provider.models.length > 0)
  const model = first?.models[0]
  if (!first || !model) return undefined
  return { providerID: first.id, modelID: model.id }
}

/** 解析并校验 job spec。**不** 碰文件系统 —— 路径是否存在由调用方在准备阶段查(带上下文更好报错)。 */
export function parseJob(raw: unknown): Job {
  const issues: string[] = []
  if (!isObject(raw)) throw new JobSpecError(["job 必须是一个 JSON 对象"])

  const id = str(raw.id)
  if (!id) issues.push("id 必填(用于分支名与工作目录,建议 j-<日期>-<序号>)")
  else if (!/^[A-Za-z0-9._-]+$/.test(id)) issues.push(`id "${id}" 只能含字母数字和 . _ -(它会进分支名和路径)`)

  const title = str(raw.title) ?? id ?? ""
  const task = str(raw.task)
  if (!task) issues.push("task 必填:把现象、复现步骤、期望行为讲清楚,这是 agent 唯一的任务来源")

  const repoRaw = isObject(raw.repo) ? raw.repo : undefined
  const benchRaw = isObject(raw.bench) ? raw.bench : {}
  // 放在 throw 之前:档位写错要和 id/task 的问题一起报出来,不然改完一处再撞一处。
  const model = parseModelSpec(raw.model, "model", issues)

  if (issues.length) throw new JobSpecError(issues)

  const deliverRaw = isObject(raw.deliver) ? raw.deliver : {}

  return {
    id: id!,
    title,
    repo: {
      directory: repoRaw ? str(repoRaw.directory) : undefined,
      name: str(repoRaw?.name) ?? id,
      ref: str(repoRaw?.ref),
      branch: str(repoRaw?.branch) ?? `agent/${id}`,
    },
    bench: {
      board: str(benchRaw.board),
      chip: str(benchRaw.chip),
      probe: str(benchRaw.probe),
    },
    task: task!,
    deliver: {
      push: deliverRaw.push === true,
      mr: deliverRaw.mr === true,
      remote: str(deliverRaw.remote) ?? "origin",
    },
    model: resolveJobModel(model),
  }
}

/**
 * 定出**研发端**这台机器上的工作树。
 *
 * `localDir`(本机配置)优先于 job 里的 directory —— 这正是机器无关的支点:
 * 任务书跨机器传,路径由收件的机器说了算。两个都没有时报错,而且要说清楚该去哪配,
 * 否则用户看到的是后面某个 git 命令在 `undefined` 目录里失败。
 */
export function resolveWorkspace(job: Job, localDir?: string): string {
  const directory = localDir?.trim() || job.repo.directory
  if (!directory) {
    throw new JobSpecError([
      `这台机器上没有配 ${job.repo.name ?? job.id} 的工程目录 —— 信箱里的任务书不带绝对路径(它在别人机器上没意义)。` +
        `在本机的调试台设置里填"工程目录"`,
    ])
  }
  return path.resolve(directory)
}

export async function loadJob(file: string): Promise<Job> {
  const raw = await readTextFile(file)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new JobSpecError([`${file} 不是合法 JSON:${(error as Error).message}`])
  }
  return parseJob(parsed)
}
