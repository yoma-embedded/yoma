/**
 * 远端模型目录(host/model-catalog.ts)的验收。一个字节都不走真网络:fetch 全程注入。
 *
 * 这一层存在的理由写在源文件头上;这里钉的是它的四条边界:
 * - **过期的远端目录必须当作没有**。合并是按 id 覆盖的,采用一份旧目录等于把内建里更新过的条目
 *   改回旧值,而"变旧了"没有任何报错 —— 这是本文件最重要的一条。
 * - **节流**:4 小时内不重复拉,用户手点刷新(force)跳过节流。
 * - **304 不能把模型弄丢**:没变时只更新"查过了",模型和 etag 原样留着。
 * - **拉不到不影响已有列表**:抛出去由 Models 记成这个 provider 的错误,别家照常。
 */

import { describe, expect, it, vi } from "vitest"

import type { Api, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai"

import {
  CATALOG_REFRESH_INTERVAL_MS,
  DEFAULT_CATALOG_BASE_URL,
  catalogBaseUrlFromEnv,
  mergeModels,
  parseCatalogResponse,
  usableRemoteModels,
  withRemoteCatalog,
} from "../src/host/model-catalog.ts"

const model = (id: string, extra: Record<string, unknown> = {}): Model<Api> =>
  ({ id, name: id, api: "openai-completions", provider: "deepseek", ...extra }) as unknown as Model<Api>

function staticProvider(models: Model<Api>[]): Provider {
  return {
    id: "deepseek",
    name: "DeepSeek",
    auth: {} as Provider["auth"],
    getModels: () => models,
  } as unknown as Provider
}

/** 显式签名:vi.fn() 不带签名时 mock.calls 是空元组,断言 calls[0][1] 通不过类型检查。 */
type FetchMock = (input: URL | string, init?: RequestInit) => Promise<Response>

interface Published {
  persist?: { models: readonly Model<Api>[]; etag?: string; lastModified?: number; checkedAt?: number } | null
}

function makeContext(
  overrides: Partial<RefreshModelsContext> & { published?: Published[] } = {},
): RefreshModelsContext & { published: Published[] } {
  const published: Published[] = overrides.published ?? []
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (publication) => {
      published.push({ persist: publication.persist as Published["persist"] })
      publication.update?.()
      return true
    },
    ...overrides,
    published,
  } as RefreshModelsContext & { published: Published[] }
}

function jsonResponse(body: unknown, init: { status?: number; etag?: string; lastModified?: string } = {}): Response {
  const headers = new Headers({ "content-type": "application/json" })
  if (init.etag) headers.set("etag", init.etag)
  if (init.lastModified) headers.set("last-modified", init.lastModified)
  return new Response(init.status === 304 ? null : JSON.stringify(body), { status: init.status ?? 200, headers })
}

// ─── 纯函数 ──────────────────────────────────────────────────────────────────

describe("usableRemoteModels", () => {
  const entry = (lastModified?: number) => ({ models: [model("remote")], lastModified })

  it("远端比内建新才采用", () => {
    expect(usableRemoteModels(entry(2000), 1000)).toHaveLength(1)
  })

  it("远端不比内建新时当作没有 —— 否则一份旧目录会把内建里更新过的条目改回旧值", () => {
    expect(usableRemoteModels(entry(1000), 1000)).toEqual([])
    expect(usableRemoteModels(entry(999), 1000)).toEqual([])
    // 连时间戳都没有的远端条目同样不敢用。
    expect(usableRemoteModels(entry(undefined), 1000)).toEqual([])
  })

  it("不知道内建是什么时候生成的就照单全收(没有可比的基准)", () => {
    expect(usableRemoteModels(entry(undefined), undefined)).toHaveLength(1)
  })

  it("没有缓存条目时是空的", () => {
    expect(usableRemoteModels(undefined, 1000)).toEqual([])
  })
})

describe("mergeModels", () => {
  it("内建在前,远端按 id 覆盖,远端独有的追加在后", () => {
    const merged = mergeModels([model("a", { name: "旧 A" }), model("b")], [model("a", { name: "新 A" }), model("c")])
    expect(merged.map((entry) => entry.id)).toEqual(["a", "b", "c"])
    expect(merged[0]?.name).toBe("新 A")
  })

  it("远端为空时原样保留内建", () => {
    expect(mergeModels([model("a")], []).map((entry) => entry.id)).toEqual(["a"])
  })
})

describe("parseCatalogResponse", () => {
  it("认 { 模型id: Model } 这种形状,并把 provider 按请求的那个盖掉", () => {
    const models = parseCatalogResponse({ x: { id: "x", api: "openai-completions", provider: "写错了" } }, "deepseek")
    expect(models).toHaveLength(1)
    // provider 不盖掉的话 getModel(provider, id) 永远查不到这个模型。
    expect(models[0]?.provider).toBe("deepseek")
  })

  it("形状不对的逐条丢掉,不连累同一份响应里写对的", () => {
    const models = parseCatalogResponse(
      { ok: { id: "ok", api: "openai-completions" }, noId: { api: "x" }, noApi: { id: "y" }, notObject: 5 },
      "deepseek",
    )
    expect(models.map((entry) => entry.id)).toEqual(["ok"])
  })

  it("整体不是对象时给空,不抛", () => {
    expect(parseCatalogResponse(null, "deepseek")).toEqual([])
    expect(parseCatalogResponse([1, 2], "deepseek")).toEqual([])
  })
})

describe("catalogBaseUrlFromEnv", () => {
  it("不设就是 pi 的目录服务", () => {
    expect(catalogBaseUrlFromEnv({})).toBe(DEFAULT_CATALOG_BASE_URL)
  })

  it("能换成自建镜像,也能整体关掉", () => {
    expect(catalogBaseUrlFromEnv({ YOMA_MODEL_CATALOG_URL: "https://mirror.example" })).toBe("https://mirror.example")
    expect(catalogBaseUrlFromEnv({ YOMA_MODEL_CATALOG_URL: "off" })).toBe("")
    expect(catalogBaseUrlFromEnv({ YOMA_MODEL_CATALOG_URL: "" })).toBe("")
  })
})

// ─── 包装 ────────────────────────────────────────────────────────────────────

describe("withRemoteCatalog", () => {
  it("自带 refreshModels 的 provider 原样返回 —— 它有自己的目录来源(radius),包了会打架", () => {
    const own = { ...staticProvider([model("a")]), refreshModels: async () => {} } as Provider
    expect(withRemoteCatalog(own)).toBe(own)
  })

  it("离线时只恢复缓存,不发请求", async () => {
    const fetchImpl = vi.fn<FetchMock>()
    const wrapped = withRemoteCatalog(staticProvider([model("builtin")]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      builtinGeneratedAt: 1000,
    })
    const context = makeContext({ allowNetwork: false, stored: { models: [model("cached")], lastModified: 2000 } })
    await wrapped.refreshModels?.(context)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["builtin", "cached"])
  })

  it("拉回来的模型合并进列表,并带 etag / lastModified 落盘", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () =>
      jsonResponse(
        { "deepseek-flash": { id: "deepseek-flash", api: "openai-completions" } },
        { etag: 'W/"abc"', lastModified: "Mon, 14 Sep 2026 08:37:34 GMT" },
      ),
    )
    const wrapped = withRemoteCatalog(staticProvider([model("deepseek-v4-pro")]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      builtinGeneratedAt: 1000,
      now: () => 5000,
    })
    const context = makeContext()
    await wrapped.refreshModels?.(context)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://pi.dev/api/models/providers/deepseek")
    expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["deepseek-v4-pro", "deepseek-flash"])
    const persisted = context.published.at(-1)?.persist
    expect(persisted?.etag).toBe('W/"abc"')
    expect(persisted?.checkedAt).toBe(5000)
    expect(persisted?.models.map((entry) => entry.id)).toEqual(["deepseek-flash"])
  })

  it("4 小时内拉过就不再拉;用户手点刷新(force)跳过节流", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => jsonResponse({}))
    const wrapped = withRemoteCatalog(staticProvider([]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 100_000,
    })
    const stored = { models: [model("cached")], lastModified: 90_000, checkedAt: 100_000 - 60_000 }
    await wrapped.refreshModels?.(makeContext({ stored }))
    expect(fetchImpl).not.toHaveBeenCalled()

    await wrapped.refreshModels?.(makeContext({ stored, force: true }))
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // 超过间隔之后自己也会拉。
    const old = { ...stored, checkedAt: 100_000 - CATALOG_REFRESH_INTERVAL_MS - 1 }
    await wrapped.refreshModels?.(makeContext({ stored: old }))
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("304 只记「查过了」,模型和 etag 原样留着 —— 弄丢了就等于每 4 小时清空一次列表", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => jsonResponse(null, { status: 304 }))
    const wrapped = withRemoteCatalog(staticProvider([model("builtin")]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      builtinGeneratedAt: 1000,
      now: () => 9000,
    })
    const stored = { models: [model("cached")], lastModified: 2000, etag: 'W/"abc"', checkedAt: 1 }
    const context = makeContext({ stored, force: true })
    await wrapped.refreshModels?.(context)
    // 带上了验证器。
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ "if-none-match": 'W/"abc"' })
    const persisted = context.published.at(-1)?.persist
    expect(persisted?.models.map((entry) => entry.id)).toEqual(["cached"])
    expect(persisted?.etag).toBe('W/"abc"')
    expect(persisted?.checkedAt).toBe(9000)
    expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["builtin", "cached"])
  })

  it("缓存是空的就不带验证器 —— 带了会换来一个 304,而我们手里什么都没有", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => jsonResponse({}))
    const wrapped = withRemoteCatalog(staticProvider([]), { fetchImpl: fetchImpl as unknown as typeof fetch })
    await wrapped.refreshModels?.(makeContext({ stored: { models: [], etag: 'W/"abc"' }, force: true }))
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match")
  })

  it("目录服务出错时抛出去(由 Models 记成这一家的错误),不动已有列表", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => new Response("boom", { status: 503 }))
    const wrapped = withRemoteCatalog(staticProvider([model("builtin")]), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(wrapped.refreshModels?.(makeContext({ force: true }))).rejects.toThrow(/503/)
    expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["builtin"])
  })

  it("关掉远端目录(baseUrl 为空)时一次都不请求", async () => {
    const fetchImpl = vi.fn<FetchMock>()
    const wrapped = withRemoteCatalog(staticProvider([model("builtin")]), {
      baseUrl: "",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await wrapped.refreshModels?.(makeContext({ force: true }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("这一轮已经被中止就不发请求", async () => {
    const fetchImpl = vi.fn<FetchMock>()
    const wrapped = withRemoteCatalog(staticProvider([]), { fetchImpl: fetchImpl as unknown as typeof fetch })
    await wrapped.refreshModels?.(makeContext({ signal: AbortSignal.abort(), force: true }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
