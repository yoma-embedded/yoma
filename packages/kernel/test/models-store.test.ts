/**
 * 模型目录本机缓存(host/models-store.ts)的验收。
 *
 * 这是**缓存**不是账本,所以断言集中在一件事上:任何一种坏情况都不能把"模型目录旧了"升级成
 * "会话开不起来"。文件不存在、JSON 烂了、某条模型形状不对、目录只读 —— 一律退回内建目录。
 *
 * 它存在的理由:内建目录是随版本冻结的快照(随 pi 的生成数据进仓,同步工具明确不动它),
 * 而厂商上新比我们发版快。2026-09-14 实测,同一个 DeepSeek,pi 的命令行列得出 deepseek-flash、
 * yoma 列不出 —— 那个模型从来没进过任何一份内建目录,是 pi 运行时联网刷出来存进用户目录的。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Api, Model } from "@earendil-works/pi-ai"

import { FileModelsStore, MODELS_STORE_FILE } from "../src/host/models-store.ts"

let configDir: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "yoma-models-store-"))
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
})

const model = (id: string): Model<Api> =>
  ({ id, name: id, api: "openai-completions", provider: "deepseek" }) as unknown as Model<Api>

function storeFile(): string {
  return join(configDir, MODELS_STORE_FILE)
}

describe("FileModelsStore", () => {
  it("写进去读得回来,而且落在 <configDir>/models-store.json", async () => {
    const store = new FileModelsStore(configDir)
    await store.write("deepseek", { models: [model("deepseek-flash")], checkedAt: 123 })
    const back = await store.read("deepseek")
    expect(back?.models.map((entry) => entry.id)).toEqual(["deepseek-flash"])
    expect(back?.checkedAt).toBe(123)
    expect(JSON.parse(readFileSync(storeFile(), "utf8"))).toHaveProperty("deepseek")
  })

  it("每个 provider 各存各的,写一个不动另一个", async () => {
    const store = new FileModelsStore(configDir)
    await store.write("deepseek", { models: [model("deepseek-flash")] })
    await store.write("moonshotai", { models: [model("kimi-k3")] })
    expect((await store.read("deepseek"))?.models).toHaveLength(1)
    expect((await store.read("moonshotai"))?.models.map((entry) => entry.id)).toEqual(["kimi-k3"])
    await store.delete("deepseek")
    expect(await store.read("deepseek")).toBeUndefined()
    expect(await store.read("moonshotai")).toBeDefined()
  })

  it("没有文件时读出 undefined —— 首跑就是这个状态,不能当成错误", async () => {
    expect(await new FileModelsStore(configDir).read("deepseek")).toBeUndefined()
  })

  it("JSON 烂了当没有缓存,不抛 —— 抛出去就是会话开不起来", async () => {
    writeFileSync(storeFile(), "{ 这不是 json")
    const store = new FileModelsStore(configDir)
    expect(await store.read("deepseek")).toBeUndefined()
    // 而且还能写回去:坏文件被整份换掉,不是永久卡死。
    await store.write("deepseek", { models: [model("deepseek-flash")] })
    expect((await store.read("deepseek"))?.models).toHaveLength(1)
  })

  it("顶层不是对象、条目形状不对时逐条丢掉,不连累同文件里写对的", async () => {
    writeFileSync(storeFile(), JSON.stringify(["不是对象"]))
    expect(await new FileModelsStore(configDir).read("deepseek")).toBeUndefined()

    writeFileSync(
      storeFile(),
      JSON.stringify({
        deepseek: { models: [{ id: "deepseek-flash" }] },
        broken: { models: "不是数组" },
        alsoBroken: { models: [{ name: "缺 id" }] },
      }),
    )
    const store = new FileModelsStore(configDir)
    expect((await store.read("deepseek"))?.models).toHaveLength(1)
    expect(await store.read("broken")).toBeUndefined()
    expect(await store.read("alsoBroken")).toBeUndefined()
  })

  it("缓存目标不能替换时不抛:模型已经在内存里可用了,只是下次启动要重新联网拉", async () => {
    const store = new FileModelsStore(configDir)
    mkdirSync(storeFile())
    await expect(store.write("deepseek", { models: [model("deepseek-flash")] })).resolves.toBeUndefined()
    // 确实没写进去(如实记录,不假装成功)。
    expect(await store.read("deepseek")).toBeUndefined()
  })

  it("写失败不留临时文件", async () => {
    const store = new FileModelsStore(configDir)
    mkdirSync(storeFile())
    await store.write("deepseek", { models: [model("deepseek-flash")] })
    const { readdirSync } = await import("node:fs")
    expect(readdirSync(configDir).filter((name) => name.startsWith(".models-store-"))).toEqual([])
  })

  it("中止信号立刻生效,不去碰磁盘", async () => {
    const store = new FileModelsStore(configDir)
    const signal = AbortSignal.abort()
    await expect(store.read("deepseek", { signal })).rejects.toThrow()
    await expect(store.write("deepseek", { models: [] }, { signal })).rejects.toThrow()
    await expect(store.delete("deepseek", { signal })).rejects.toThrow()
  })
})
