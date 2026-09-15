import { createRoot } from "solid-js"
import { afterEach, expect, test, vi } from "vitest"
import type { ProviderInfo } from "@yoma-desktop/kernel"
import { createProviderCatalog } from "@/components/kernel-providers"
import { applyGlobalEvent } from "@/context/global-sync/event-reducer"

afterEach(() => vi.unstubAllGlobals())

test("模型选择器订阅收到 model.updated 后在当前页面更新,晚到的旧请求不能覆盖它", async () => {
  const providers = (id: string): ProviderInfo[] => [
    {
      id: "deepseek",
      name: "DeepSeek",
      authenticated: true,
      models: [{ id, name: id, providerID: "deepseek", thinkingLevels: ["off"] }],
    },
  ]
  let finishOld!: (value: ProviderInfo[]) => void
  const pending = new Promise<ProviderInfo[]>((resolve) => (finishOld = resolve))
  const request = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(providers("fresh"))
  vi.stubGlobal("api", { kernel: { request } })
  const scope = createRoot((dispose) => ({ dispose, catalog: createProviderCatalog() }))
  try {
    await Promise.resolve()
    applyGlobalEvent({ event: { type: "model.updated", providers: providers("fresh") }, refresh: () => {} })
    await vi.waitFor(() => expect(scope.catalog()[0]?.models[0]?.id).toBe("fresh"))
    finishOld(providers("old"))
    await pending
    await Promise.resolve()
    expect(scope.catalog()[0].models[0].id).toBe("fresh")
  } finally {
    scope.dispose()
  }
})
