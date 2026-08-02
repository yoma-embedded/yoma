import { describe, expect, test } from "bun:test"
import type { ProviderInfo } from "@yoma-desktop/kernel"
import { directoryKey, normalizeProviderList } from "./utils"

const provider = (id: string, authenticated: boolean): ProviderInfo => ({
  id,
  name: id,
  authenticated,
  models: [],
})

describe("normalizeProviderList", () => {
  test("indexes providers by id", () => {
    const anthropic = provider("anthropic", true)
    const openai = provider("openai", false)
    const result = normalizeProviderList([anthropic, openai])

    expect([...result.all.keys()]).toEqual(["anthropic", "openai"])
    expect(result.all.get("anthropic")).toBe(anthropic)
  })

  test("lists only authenticated providers as connected", () => {
    const result = normalizeProviderList([provider("anthropic", true), provider("openai", false)])

    expect(result.connected).toEqual(["anthropic"])
  })

  // 内核没有"每个 provider 的默认模型"这个概念 —— 默认模型由 Session.model 决定。
  test("leaves the default model map empty", () => {
    expect(normalizeProviderList([provider("anthropic", true)]).default).toEqual({})
  })

  test("handles an empty catalog", () => {
    const result = normalizeProviderList([])

    expect(result.all.size).toBe(0)
    expect(result.connected).toEqual([])
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\opencode"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/Repos/sst/opencode"))).toBe("C:/Repos/sst/opencode")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/opencode/"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})
