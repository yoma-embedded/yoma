/**
 * 评测的一轮执行 —— 无头入口的可测内核。
 *
 * 这是"让开源跑批器(Harbor 等)能调用 yoma"的胶水层。它复用 bench 的 {@link runTurn} ——
 * 于是压缩、轮级重试、思考档位、13 个工具的装配、会话 JSONL 全部白得,与桌面端/信箱同一条路。
 * **不要退回 `example/99-headless-run.ts`**:那是裸 harness,没有压缩与重试,思考档位缺省 `off`
 * (对 reasoning 模型等于把最强的一档默认关掉,且没有任何地方提示)。
 *
 * 与 CLI 壳(`entry.ts`)分开是为了能被 `bun test` 直接调:壳只做 argv 解析、写文件、退出码。
 * 同一条纪律见 `turn.ts` ↔ `turn-entry.ts`。
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import type { KernelEvent } from "@yoma-desktop/kernel"

import { fauxResolveModels, type FauxScript } from "../faux.ts"
import { parseJob } from "../job.ts"
import { runTurn, type TurnOptions, type TurnResult } from "../turn.ts"
import { resolveEvalModels } from "./models.ts"

/** 打包时由 esbuild 的 define 注入(见 scripts/build-eval-entry.ts);源码直跑时是 "dev"。 */
export const BUILD_STAMP = process.env.YOMA_EVAL_BUILD ?? "dev"

/** 配置问题(缺凭据、未知模型、参数不全)—— 壳据此以退出码 2 结束,与"agent 没做出来"区分开。 */
export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EvalConfigError"
  }
}

export interface EvalOptions {
  /** agent 的工作目录(容器里通常是任务的 /app)。 */
  cwd: string
  /** 交给 agent 的任务描述。跑批器的 instruction 原样进来。 */
  instruction: string
  providerID: string
  modelID: string
  /** 思考档位。不填落到 kernel 的 DEFAULT_THINKING_LEVEL(= max),不是关掉。 */
  thinking?: string
  /** 凭据 / 技能 / 上下文文件的目录(`<configDir>/auth.json`、`<configDir>/skills`)。 */
  configDir: string
  sessionsRoot: string
  stateDir: string
  /** 一轮的墙钟上限。不填落到 runTurn 的默认(60 分钟),评测应当显式收紧。 */
  timeoutMs?: number
  /** 事件流落点(JSONL),给 transcript 分析用。 */
  eventsPath?: string
  /**
   * 本机演练:注入 faux 假模型脚本,不联网、不要 key,其余全真。
   *
   * **不能当评测夹具** —— faux 把 cost 硬写成 0、token 按 length/4 估,而且它评的是脚本不是 agent。
   * 正当用途只有两个:这个包自己的测试,和打包产物的冒烟(验证 node 下整条装配起得来)。
   */
  faux?: FauxScript
  /** 测试注入口,优先于 faux 与真实凭据。 */
  resolveModels?: TurnOptions["resolveModels"]
}

export interface EvalOutput {
  build: string
  providerID: string
  modelID: string
  thinking?: string
  /** 含装配与模型解析的墙钟;`result.elapsedMs` 只是 runTurn 那一段。 */
  wallMs: number
  faux: boolean
  result: TurnResult
}

/**
 * 跑一轮,返回结构化结果。
 *
 * 模型解析放在 runTurn **之前**:缺凭据/未知模型要在开跑前就报出来(EvalConfigError),
 * 而不是跑到一半才炸 —— 后者在跑批器那边表现为"agent 失败",会被记成模型不行。
 */
export async function runEval(options: EvalOptions): Promise<EvalOutput> {
  if (options.instruction.trim() === "") throw new EvalConfigError("instruction 不能为空")

  for (const dir of [options.configDir, options.sessionsRoot, options.stateDir]) {
    mkdirSync(dir, { recursive: true })
  }

  let resolveModels: TurnOptions["resolveModels"]
  if (options.resolveModels) {
    resolveModels = options.resolveModels
  } else if (options.faux) {
    resolveModels = fauxResolveModels(options.faux)
  } else {
    // 抛的是 EvalConfigError,壳据此给退出码 2 并把修复指引打到 stderr。
    const resolved = await resolveEvalModels({
      configDir: options.configDir,
      providerID: options.providerID,
      modelID: options.modelID,
    }).catch((error: unknown) => {
      throw new EvalConfigError((error as Error).message)
    })
    resolveModels = async () => resolved
  }

  const onEvent = options.eventsPath ? makeEventSink(options.eventsPath) : undefined

  // parseJob 只是复用它的校验与默认值(档位错字在这里就报,而不是静默落到第一档)。
  // runTurn 实际只读 job.title 与 job.model —— 注入了 resolveModels 时连 model 都不下发。
  const job = parseJob({
    id: "eval",
    title: firstLine(options.instruction),
    task: options.instruction,
    repo: { directory: options.cwd },
    bench: {},
    model: { providerID: options.providerID, modelID: options.modelID, thinking: options.thinking },
  })

  const started = Date.now()
  const result = await runTurn({
    job,
    workspace: options.cwd,
    sessionsRoot: options.sessionsRoot,
    stateDir: options.stateDir,
    configDir: options.configDir,
    prompt: options.instruction,
    resolveModels,
    hardTimeoutMs: options.timeoutMs,
    onEvent,
  })

  return {
    build: BUILD_STAMP,
    providerID: options.providerID,
    modelID: options.modelID,
    thinking: job.model?.thinking,
    wallMs: Date.now() - started,
    faux: Boolean(options.faux),
    result,
  }
}

/**
 * 事件旁路。逐 token 的 delta 不落(会把文件撑到几百 MB),其余全记 —— tool_execution 的
 * 入参与 isError 是"工具好不好用"的唯一数据来源。
 *
 * 写失败不能带垮整轮(磁盘满、路径没权限):transcript 是分析材料,不是判据。
 */
function makeEventSink(path: string): (event: KernelEvent) => void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "")
  let broken = false
  return (event: KernelEvent) => {
    if (broken || event.type === "message.part.delta") return
    try {
      appendFileSync(path, `${JSON.stringify(event)}\n`)
    } catch {
      broken = true
    }
  }
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "eval"
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}
