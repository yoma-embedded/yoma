/**
 * 评测模型注册表:vision-exp 真的能被选中,且 input 含 image、单价非 0(否则 cost 列静默为 0)。
 *
 * 2026-09 起该模型由 pi-ai 内建目录提供,不再走本地追加表;原来的漂移闸门已完成使命并删除。
 * `withExtraModels` 的机制测试改用合成条目。
 */

import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { NO_AMBIENT_AUTH } from "@yoma/coding-agent/models"

import { resolveEvalModels, withExtraModels } from "./models.ts"

const VISION = "deepseek-v4-flash-vision-exp"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function configDirWithKey(entries: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "yoma-eval-config-"))
  dirs.push(dir)
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify(entries))
  return dir
}

describe("resolveEvalModels", () => {
  test("追加的 vision-exp 能被选中,且 input 含 image、单价非 0", async () => {
    const configDir = configDirWithKey({ deepseek: { type: "api_key", key: "sk-test" } })
    const { models, model } = await resolveEvalModels({
      configDir,
      providerID: "deepseek",
      modelID: VISION,
      authContext: NO_AMBIENT_AUTH,
    })
    expect(model.id).toBe(VISION)
    expect(model.provider).toBe("deepseek")
    expect(model.input).toContain("image")
    expect(model.reasoning).toBe(true)
    expect(model.cost.input).toBeGreaterThan(0)
    expect(model.cost.output).toBeGreaterThan(0)
    expect(model.cost.cacheRead).toBeGreaterThan(0)
    // 内建条目一个不少,追加的排在后面。
    const ids = models.getModels("deepseek").map((m) => m.id)
    expect(ids).toContain("deepseek-v4-flash")
    expect(ids).toContain(VISION)
    // 没凭据的 provider 从注册表删掉(与 resolveModel 同一条纪律)。
    expect(models.getModels("anthropic")).toHaveLength(0)
  })

  test("内建模型照常可选(对照组 deepseek-v4-flash)", async () => {
    const configDir = configDirWithKey({ deepseek: { type: "api_key", key: "sk-test" } })
    const { model } = await resolveEvalModels({
      configDir,
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      authContext: NO_AMBIENT_AUTH,
    })
    expect(model.id).toBe("deepseek-v4-flash")
  })

  test("没有 key 时报错并指向 auth.json", async () => {
    const configDir = configDirWithKey({})
    await expect(
      resolveEvalModels({ configDir, providerID: "deepseek", modelID: VISION, authContext: NO_AMBIENT_AUTH }),
    ).rejects.toThrow(/No API key for provider deepseek.*auth\.json/s)
  })

  test("未知模型报错并列出可选模型", async () => {
    const configDir = configDirWithKey({ deepseek: { type: "api_key", key: "sk-test" } })
    await expect(
      resolveEvalModels({ configDir, providerID: "deepseek", modelID: "nope", authContext: NO_AMBIENT_AUTH }),
    ).rejects.toThrow(/Model deepseek\/nope not found.*deepseek-v4-flash/s)
  })

  test("未知 provider 报错", async () => {
    const configDir = configDirWithKey({})
    await expect(
      resolveEvalModels({ configDir, providerID: "nope", modelID: VISION, authContext: NO_AMBIENT_AUTH }),
    ).rejects.toThrow(/Unknown provider: nope/)
  })
})

describe("withExtraModels", () => {
  test("没有可追加的条目时原样返回", () => {
    const deepseek = builtinProviders().find((p) => p.id === "deepseek")!
    expect(withExtraModels(deepseek, [])).toBe(deepseek)
    // 已存在的 id 不重复追加。
    expect(withExtraModels(deepseek, [deepseek.getModels()[0]!])).toBe(deepseek)
  })

  test("追加保留原 provider 的 auth 与 baseUrl", () => {
    const deepseek = builtinProviders().find((p) => p.id === "deepseek")!
    // 用合成条目而不是 EXTRA_MODELS:那张表现在是空的(上游已收编 vision-exp),
    // 但机制本身仍要有测试守着,下次往表里加东西时才有保障。
    const synthetic = { ...deepseek.getModels()[0]!, id: "synthetic-not-in-catalog" }
    const patched = withExtraModels(deepseek, [synthetic])
    expect(patched).not.toBe(deepseek)
    expect(patched.id).toBe("deepseek")
    expect(patched.baseUrl).toBe(deepseek.baseUrl)
    expect(patched.auth).toBe(deepseek.auth)
    expect(patched.getModels().map((m) => m.id)).toEqual([
      ...deepseek.getModels().map((m) => m.id),
      "synthetic-not-in-catalog",
    ])
  })
})
