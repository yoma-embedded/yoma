import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { createModels, type Model } from "@earendil-works/pi-ai"
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { createKernelHost, type KernelHost } from "./index.ts"
import { withRemoteCatalog } from "./model-catalog.ts"
import type { KernelEvent } from "../protocol.ts"

const roots: string[] = []
const hosts: KernelHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
function registry(fetchImpl: typeof fetch) {
  const faux = fauxProvider({ provider: "deepseek", models: [{ id: "builtin" }] })
  const models = createModels()
  models.setProvider(withRemoteCatalog(faux.provider, { fetchImpl }))
  return { models, model: faux.getModel() as Model<string> }
}
function setup(resolveModels: () => Promise<ReturnType<typeof registry>>) {
  const root = mkdtempSync(join(tmpdir(), "yoma-model-startup-"))
  roots.push(root)
  const events: KernelEvent[] = []
  const host = createKernelHost({
    sessionsRoot: join(root, "sessions"),
    stateDir: join(root, "state"),
    configDir: root,
    resolveModels,
    onEvents: (batch) => events.push(...batch),
  })
  hosts.push(host)
  return { host, events }
}
const catalogResponse = () =>
  new Response(
    JSON.stringify({
      fresh: {
        id: "fresh",
        name: "New catalog model",
        api: "faux",
        contextWindow: 100000,
        maxTokens: 1000,
      },
    }),
  )

test("冷启动并发请求共享注册表,后台新模型在本次启动就能读到并推送", async () => {
  const resolving = deferred()
  const network = deferred()
  const fetchImpl = vi.fn(async () => {
    await network.promise
    return catalogResponse()
  })
  let resolutions = 0
  const resolveModels = vi.fn(async () => {
    const order = ++resolutions
    await resolving.promise
    // 第一份开始联网后,较慢的另一次解析才回来:它不能把刚刷的注册表盖掉。
    if (order > 1) await new Promise((done) => setTimeout(done, 40))
    return registry(fetchImpl as typeof fetch)
  })
  const { host, events } = setup(resolveModels)
  const lists = Array.from({ length: 5 }, () => host.handle("model.list", undefined))
  await vi.waitFor(() => expect(resolveModels).toHaveBeenCalled())
  resolving.resolve()
  const initial = await Promise.all(lists)
  expect(initial.every((list) => list.find((p) => p.id === "deepseek")?.models.length === 1)).toBe(true)
  network.resolve()
  await vi.waitFor(() => expect(events.some((e) => e.type === "model.updated")).toBe(true))
  expect(
    (await host.handle("model.list", undefined)).find((p) => p.id === "deepseek")?.models.map((m) => m.id),
  ).toEqual(["builtin", "fresh"])
  expect(resolveModels).toHaveBeenCalledTimes(1)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

test("凭据变化后新注册表也会自动刷新,不沿用第一次启动的已刷新标记", async () => {
  const fetchImpl = vi.fn(async () => catalogResponse())
  const resolveModels = vi.fn(async () => registry(fetchImpl as typeof fetch))
  const { host, events } = setup(resolveModels)
  await host.handle("model.list", undefined)
  await vi.waitFor(() => expect(events.some((e) => e.type === "model.updated")).toBe(true))
  await host.handle("auth.set", { providerID: "deepseek", apiKey: "local-test-only" })
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
  expect(
    (await host.handle("model.list", undefined)).find((p) => p.id === "deepseek")?.models.map((m) => m.id),
  ).toContain("fresh")
})

test("首次解析失败后可重试,不缓存 rejected promise", async () => {
  const resolveModels = vi
    .fn(async () => registry((async () => catalogResponse()) as typeof fetch))
    .mockRejectedValueOnce(new Error("temporary config read error"))
  const { host } = setup(resolveModels)
  await host.handle("model.list", undefined)
  const list = await host.handle("model.list", undefined)
  expect(list.find((p) => p.id === "deepseek")?.authenticated).toBe(true)
  expect(resolveModels).toHaveBeenCalledTimes(2)
})

test("解析期间改凭据,晚到的旧结果不能覆盖新的注册表", async () => {
  const old = deferred()
  let calls = 0
  const resolveModels = vi.fn(async () => {
    if (++calls === 1) {
      await old.promise
      throw new Error("stale credentials")
    }
    return registry((async () => catalogResponse()) as typeof fetch)
  })
  const { host } = setup(resolveModels)
  const first = host.handle("model.list", undefined)
  await vi.waitFor(() => expect(resolveModels).toHaveBeenCalledTimes(1))
  const next = await host.handle("auth.set", { providerID: "deepseek", apiKey: "new-local-test-only" })
  old.resolve()
  expect((await first).find((p) => p.id === "deepseek")?.authenticated).toBe(true)
  expect(next.find((p) => p.id === "deepseek")?.authenticated).toBe(true)
  expect(resolveModels).toHaveBeenCalledTimes(2)
})

test("只更新同一个模型的名称和上下文也推送,目录失败不妨碍本地列表和手动重试", async () => {
  const fetchImpl = vi.fn(async () => new Response("temporarily unavailable", { status: 503 }))
  const { host, events } = setup(async () => registry(fetchImpl as typeof fetch))
  expect((await host.handle("model.list", undefined)).find((p) => p.id === "deepseek")?.models[0].id).toBe("builtin")
  await vi.waitFor(() => expect(events.some((e) => e.type === "kernel.error")).toBe(true))
  fetchImpl.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          builtin: {
            id: "builtin",
            name: "Updated name",
            api: "faux",
            contextWindow: 200000,
            maxTokens: 1000,
          },
        }),
      ),
  )
  // 凭据变更启动新一轮自动刷新;验证 id 不变时也能收到 model.updated。
  await host.handle("auth.set", { providerID: "deepseek", apiKey: "local-test-only" })
  await vi.waitFor(() => expect(events.some((e) => e.type === "model.updated")).toBe(true))
  const refreshed = await host.handle("model.refresh", undefined)
  expect(refreshed.find((p) => p.id === "deepseek")?.models[0]).toMatchObject({
    name: "Updated name",
    contextWindow: 200000,
  })
})
