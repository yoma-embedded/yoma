/**
 * 远端模型目录:把厂商新出的模型接进来。
 *
 * 【为什么非要有这一层】内建目录(`builtinProviders()`)是**随版本冻结的一张快照** —— 它随 pi 的生成数据
 * 进仓,而上游同步工具明确不动那份数据。厂商上新比我们发版快得多,而且绝大多数 provider 在 pi-ai 里是
 * **静态的**(`createProvider({ models: [...] })`,没有联网拉目录的口子),所以"同步到最新的 pi"也带不来
 * 新模型 —— 那些模型从来没进过任何一份内建目录。
 *
 * 2026-09-14 实测的那一例:同一个 DeepSeek,pi 的命令行列得出 `deepseek-flash`,yoma 列不出。查下来
 * pi 的命令行自己包了一层 `withRemoteCatalog`,从 `https://pi.dev/api/models/providers/<id>` 拉目录 ——
 * 那一层在 pi 的 coding-agent 包里,而我们只同步 ai / agent / chord / telemetry 四个包,所以没跟过来。
 * 这个文件就是那一层的 yoma 版本(直接请求过那个接口验证:返回的正是 deepseek-flash,etag 与 pi 存的一致)。
 *
 * 【三条纪律】
 * 1. **远端只在比内建数据新的时候才算数。** 合并是按 id 覆盖的,一份过期的远端目录会把内建里更新的
 *    条目改回旧的。所以拿 `lastModified` 与内建数据的生成时间比,不够新就当没拉到。
 * 2. **拉不到不是错误状态。** 断网、被墙、服务挂了,列表就停在上一次 —— 绝不能让它影响开会话。
 * 3. **不在关键路径上联网。** 开会话只恢复磁盘缓存(models.ts 里那句 `allowNetwork: false`);联网发生在
 *    后台那一次和用户手点"刷新模型列表",而且 4 小时内不重复拉(带 If-None-Match,没变就是 304)。
 */

import type { Api, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai"

/** pi 自己的模型目录服务。`YOMA_MODEL_CATALOG_URL` 可以整体换掉(自建镜像、或者置空关掉)。 */
export const DEFAULT_CATALOG_BASE_URL = "https://pi.dev"

/** 与 pi 同一个节流:4 小时内不重复拉(force 除外)。 */
export const CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000

/** 单次请求的上限。挂住的目录服务不该把"刷新模型列表"变成永远转圈。 */
const CATALOG_REQUEST_TIMEOUT_MS = 10_000

export interface RemoteCatalogOptions {
  /** 默认 DEFAULT_CATALOG_BASE_URL;空串表示关掉远端目录(只用内建 + 缓存)。 */
  baseUrl?: string
  /** 测试注入。 */
  fetchImpl?: typeof fetch
  /** 内建模型数据的生成时间;远端不比它新就不采用。默认由调用方从 pi-ai 读。 */
  builtinGeneratedAt?: number
  /** 测试注入,默认 Date.now。 */
  now?: () => number
}

/** 环境变量覆盖:留空(设成 "" 或 "off")= 不联网,只用内建目录 + 本机缓存。 */
export function catalogBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YOMA_MODEL_CATALOG_URL?.trim()
  if (configured === undefined) return DEFAULT_CATALOG_BASE_URL
  return configured === "off" ? "" : configured
}

/**
 * 缓存里的远端目录能不能用。
 *
 * `lastModified` 是远端目录自己的时间戳。内建数据更新(或一样新)时返回空 —— 合并是按 id 覆盖的,
 * 采用一份旧目录等于把内建里更新过的条目改回去,而那种"变旧了"没有任何报错。
 */
export function usableRemoteModels(
  entry: { models: readonly Model<Api>[]; lastModified?: number } | undefined,
  builtinGeneratedAt: number | undefined,
): readonly Model<Api>[] {
  if (!entry) return []
  if (builtinGeneratedAt === undefined) return entry.models
  if (entry.lastModified === undefined || entry.lastModified <= builtinGeneratedAt) return []
  return entry.models
}

/** 内建在前、远端按 id 覆盖、远端独有的追加 —— 与 pi-ai 的 createProvider 同一套合并。 */
export function mergeModels(baseline: readonly Model<Api>[], remote: readonly Model<Api>[]): readonly Model<Api>[] {
  const merged = [...baseline]
  for (const model of remote) {
    const index = merged.findIndex((entry) => entry.id === model.id)
    if (index >= 0) merged[index] = model
    else merged.push(model)
  }
  return merged
}

/** 目录服务的响应:`{ "<模型id>": Model }`。形状不对的条目逐条丢掉。 */
export function parseCatalogResponse(payload: unknown, providerId: string): readonly Model<Api>[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return []
  const out: Model<Api>[] = []
  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue
    const model = value as Model<Api>
    if (typeof model.id !== "string" || typeof model.api !== "string") continue
    // provider 一律按我们请求的那个盖掉:远端写错了会让 getModel(provider, id) 永远查不到。
    out.push({ ...model, provider: providerId })
  }
  return out
}

function headerDate(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * 给一个已经造好的 provider 补上"从远端目录拉模型"的能力。
 *
 * 不能改用 `createProvider` 重造:`builtinProviders()` 交出来的是成品,它的 api 实现拿不到。
 * 所以这里包一层 —— getModels 变成"内建 ⊕ 远端",refreshModels 负责恢复缓存 / 联网 / 落盘。
 *
 * 已经自带 refreshModels 的 provider(radius)原样返回:它有自己的目录来源,包了会打架。
 */
export function withRemoteCatalog(provider: Provider, options: RemoteCatalogOptions = {}): Provider {
  if (provider.refreshModels) return provider
  const baseUrl = options.baseUrl ?? DEFAULT_CATALOG_BASE_URL
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? Date.now
  let remote: readonly Model<Api>[] = []

  const refreshModels = async (context: RefreshModelsContext): Promise<void> => {
    const stored = context.stored
    const restored = usableRemoteModels(stored, options.builtinGeneratedAt)
    // 先把缓存恢复回来(离线也走这一步),再谈联网。
    if (!(await context.publish({ update: () => void (remote = restored) }))) return
    if (!baseUrl || !context.allowNetwork || context.signal.aborted) return
    // 4 小时内拉过就不再拉;force(用户手点刷新)跳过节流。
    if (
      !context.force &&
      stored?.checkedAt !== undefined &&
      stored.lastModified !== undefined &&
      now() - stored.checkedAt < CATALOG_REFRESH_INTERVAL_MS
    ) {
      return
    }

    const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, baseUrl)
    const headers: Record<string, string> = { accept: "application/json" }
    // 只有手里真有模型时才带验证器:空缓存 + 304 会让我们什么都拿不到。
    if (stored?.models.length && stored.etag) headers["if-none-match"] = stored.etag
    // 两个信号合一:这一轮被中止,或者这一次请求自己超时。
    const timeout = AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT_MS)
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.any([context.signal, timeout]),
    })
    if (context.signal.aborted) return

    if (response.status === 304) {
      // 没变:只把"查过了"记下来,别动模型和 etag。
      if (stored) await context.publish({ persist: { ...stored, checkedAt: now() } })
      return
    }
    if (!response.ok) throw new Error(`模型目录 ${url.host} 返回 ${response.status}`)

    const models = parseCatalogResponse(await response.json(), provider.id)
    const entry = {
      models,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: headerDate(response.headers.get("last-modified")),
      checkedAt: now(),
    }
    const usable = usableRemoteModels(entry, options.builtinGeneratedAt)
    await context.publish({ persist: entry, update: () => void (remote = usable) })
  }

  return {
    ...provider,
    getModels: () => mergeModels(provider.getModels(), remote),
    refreshModels,
  }
}
