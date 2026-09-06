/**
 * 评测模型注册表的两道闸门:
 *   1. 追加的 vision-exp 条目真的能被选中,且 input 含 image、单价非 0(否则 cost 列静默为 0);
 *   2. 漂移闸门:pi-ai 目录一旦自带该模型,这份补丁必须删 —— 测试红就是提醒。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { NO_AMBIENT_AUTH } from "@yoma/coding-agent/models"

import { EXTRA_MODELS, resolveEvalModels, withExtraModels } from "./models.ts"

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
    const patched = withExtraModels(deepseek, EXTRA_MODELS.deepseek!)
    expect(patched).not.toBe(deepseek)
    expect(patched.id).toBe("deepseek")
    expect(patched.baseUrl).toBe(deepseek.baseUrl)
    expect(patched.auth).toBe(deepseek.auth)
    expect(patched.getModels().map((m) => m.id)).toEqual([...deepseek.getModels().map((m) => m.id), VISION])
  })
})

describe("漂移闸门", () => {
  test("pi-ai 目录一旦自带 vision-exp,这份补丁必须删", () => {
    const deepseek = builtinProviders().find((p) => p.id === "deepseek")!
    const shipped = deepseek.getModels().some((m) => m.id === VISION)
    // 红了就去掉 EXTRA_MODELS.deepseek 里的那条(并核对 pi-ai 给的 input/cost/thinkingLevelMap)。
    expect(shipped).toBe(false)
  })

  test("追加条目的 cost 与 pi-ai 的 deepseek-v4-flash 同价(公告口径)", () => {
    const deepseek = builtinProviders().find((p) => p.id === "deepseek")!
    const flash = deepseek.getModels().find((m) => m.id === "deepseek-v4-flash")!
    const vision = EXTRA_MODELS.deepseek!.find((m) => m.id === VISION)!
    expect(vision.cost).toEqual(flash.cost)
    expect(vision.compat).toEqual(flash.compat)
  })
})
