import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "vitest"
import { FileCredentialStore, NO_AMBIENT_AUTH, resolveModel } from "./models.ts"
import { saveCustomProvider, readCustomProviders } from "./custom-providers.ts"
import { readModelPreferences, setModelContext } from "./model-preferences.ts"

test("context overrides survive reopen, reach actual Pi models, preserve defaults and can be cleared", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "yoma-context-"))
  try {
    const store = new FileCredentialStore(path.join(dir, "auth.json"))
    await saveCustomProvider(store, {
      name: "Context test",
      baseUrl: "https://test.example/v1",
      modelIds: ["one", "two"],
      contextWindow: 32768,
      maxOutput: 4096,
      apiKey: "test-key",
    })
    const [entry] = await readCustomProviders(store)
    await Promise.all([setModelContext(dir, entry!.id, "one", 2048), setModelContext(dir, entry!.id, "two", 16384)])
    const result = await resolveModel(dir, { provider: entry!.id, authContext: NO_AMBIENT_AUTH })
    expect(result.models.getModel(entry!.id, "one")).toMatchObject({ contextWindow: 2048, maxTokens: 2048 })
    expect(result.models.getModel(entry!.id, "two")).toMatchObject({ contextWindow: 16384, maxTokens: 4096 })
    await expect(setModelContext(dir, entry!.id, "one", 1)).rejects.toThrow("Context window")
    await setModelContext(dir, entry!.id, "one")
    const reset = await resolveModel(dir, { provider: entry!.id, authContext: NO_AMBIENT_AUTH })
    expect(reset.models.getModel(entry!.id, "one")?.contextWindow).toBe(32768)
    expect(readModelPreferences(dir)[entry!.id]?.two).toBe(16384)
    const credentials = readFileSync(path.join(dir, "auth.json"), "utf8")
    writeFileSync(path.join(dir, "model-preferences.json"), "{broken", "utf8")
    await expect(setModelContext(dir, entry!.id, "one", 8192)).rejects.toThrow("model-preferences.json")
    expect(readFileSync(path.join(dir, "model-preferences.json"), "utf8")).toBe("{broken")
    expect(readFileSync(path.join(dir, "auth.json"), "utf8")).toBe(credentials)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
