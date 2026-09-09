/**
 * 评测专用的模型注册表。
 *
 * 为什么不直接用 yoma 的 `resolveModel()`:它的不变式是"注册 == pi-ai 内建目录",而评测偶尔要跑
 * 尚未进入目录的新模型 —— 指定它会抛 `Model … not found`。这里在内建目录之上追加
 * {@link EXTRA_MODELS},其余(凭据、按 checkAuth 删无凭据的 provider)照 `resolveModel` 的做法,
 * **不动产品代码**。
 *
 * 2026-09:`deepseek-v4-flash-vision-exp` 已随 pi-ai 0.85.1 进入内建目录(字段与本地补丁逐项一致),
 * 补丁按原定的漂移闸门指示删除,追加表现在是空的。下次又要跑目录外的模型时往这里加。
 *
 * 追加条目的 `input` 必须含 `"image"`:pi-ai 的 openai-completions 在 `model.input.includes("image")`
 * 为假时**静默丢掉**工具结果里的图片(datasheet `view_figure`、la 预览就白发了)。
 *
 * 走 `createKernelHost` 的 `resolveModels` 注入口(faux 假模型同一个口)。注意 bench 的 `runTurn`
 * 在注入了 `resolveModels` 时**跳过 `session.setModel`**,所以这里返回的 `model` 就是被测模型。
 */

import { join } from "node:path"

import {
  type AuthContext,
  createModels,
  type Model,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { FileCredentialStore } from "@yoma/coding-agent/models"

/**
 * 不在 pi-ai 目录里、但评测要用的模型。键是 provider id。
 *
 * 目前为空:上一条(`deepseek-v4-flash-vision-exp`)已被上游收编。保留这张表和
 * {@link withExtraModels},下次遇到"模型已发布但 pi-ai 目录还没跟上"时直接往这里加,
 * 并在 models.test.ts 里配一条漂移闸门,等上游收编时提醒删除。
 */
export const EXTRA_MODELS: Record<string, Model<"openai-completions">[]> = {}

/**
 * 把追加条目并进一家内建 provider。
 *
 * **包一层而不是 `createProvider` 重建**:`api`(ProviderStreams 实现)只在
 * `CreateProviderOptions` 里,不在 `Provider` 接口上 —— 拿不到它就重建不出能真正发请求的
 * provider(实测:重建时 `input.api.stream` 读到 undefined 直接抛)。而 pi-ai 的
 * `createProvider` 返回的是**纯对象字面量**、方法全是闭包不依赖 `this`,所以展开覆盖
 * `getModels` 是安全的:`stream`/`streamSimple`/`fetchDeferred` 原样保留,追加的模型走同一个
 * api 实现(deepseek 是单 api provider,任何 model 都由它流)。
 *
 * 委托 `provider.getModels()` 而不是快照,是为了不打断动态目录:`refreshModels()` 更新的是
 * 原闭包里的列表,这里每次实时读,追加项排在其后。
 */
export function withExtraModels(provider: Provider, extra: readonly Model<any>[]): Provider {
  if (extra.length === 0) return provider
  const existing = new Set(provider.getModels().map((m) => m.id))
  const additions = extra.filter((m) => !existing.has(m.id))
  if (additions.length === 0) return provider
  return { ...provider, getModels: () => [...provider.getModels(), ...additions] }
}

export interface ResolveEvalModelsOptions {
  /** 凭据目录:读 `<configDir>/auth.json`;环境变量(DEEPSEEK_API_KEY 等)由 pi-ai 各 provider 自己兜底。 */
  configDir: string
  providerID: string
  modelID: string
  /** 测试传 yoma 的 NO_AMBIENT_AUTH,只认 auth.json。 */
  authContext?: AuthContext
  /** 覆盖追加表(测试用)。 */
  extraModels?: Record<string, readonly Model<any>[]>
}

export interface ResolvedEvalModels {
  models: Models
  model: Model<string>
}

/**
 * 装配注册表并选出被测模型。与 `resolveModel()` 同一套纪律:全部注册、逐家 checkAuth、没凭据的删掉。
 * 选不到时抛带修复指引的错误(评测入口以退出码 2 结束)。
 */
export async function resolveEvalModels(options: ResolveEvalModelsOptions): Promise<ResolvedEvalModels> {
  const authPath = join(options.configDir, "auth.json")
  const models = createModels({ credentials: new FileCredentialStore(authPath), authContext: options.authContext })
  const extra = options.extraModels ?? EXTRA_MODELS

  const providers = builtinProviders().map((p) => withExtraModels(p, extra[p.id] ?? []))
  for (const provider of providers) models.setProvider(provider)

  const target = providers.find((p) => p.id === options.providerID)
  if (!target) {
    throw new Error(`Unknown provider: ${options.providerID}. Known providers: ${providers.map((p) => p.id).join(", ")}`)
  }

  const configured: string[] = []
  for (const provider of providers) {
    if (await models.checkAuth(provider.id)) configured.push(provider.id)
    else models.deleteProvider(provider.id)
  }
  if (!configured.includes(options.providerID)) {
    throw new Error(
      `No API key for provider ${options.providerID} (${target.auth.apiKey?.name ?? target.name}). ` +
        `Add it to ${authPath} like {"${options.providerID}":{"type":"api_key","key":"sk-..."}}, ` +
        `or export the provider's standard env var (e.g. DEEPSEEK_API_KEY).`,
    )
  }

  const model = models.getModel(options.providerID, options.modelID)
  if (!model) {
    const known = models
      .getModels(options.providerID)
      .map((m) => m.id)
      .join(", ")
    throw new Error(`Model ${options.providerID}/${options.modelID} not found. Known models: ${known}`)
  }
  return { models, model: model as Model<string> }
}
