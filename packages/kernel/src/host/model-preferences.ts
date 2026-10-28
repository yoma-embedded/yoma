import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import lockfile from "proper-lockfile"
import type { Provider } from "@earendil-works/pi-ai"

type Preferences = Record<string, Record<string, number>>
const fileName = "model-preferences.json"

export function readModelPreferences(configDir: string): Preferences {
  try {
    const value: unknown = JSON.parse(readFileSync(join(configDir, fileName), "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preferences")
    for (const models of Object.values(value)) {
      if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("Invalid models")
      for (const size of Object.values(models)) validateWindow(size)
    }
    return value as Preferences
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw new Error("Cannot read model-preferences.json; repair it before changing model settings")
  }
}

function validateWindow(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1024 || (value as number) > 10_000_000)
    throw new Error("Context window must be an integer between 1024 and 10000000")
}

export async function setModelContext(
  configDir: string,
  providerID: string,
  modelID: string,
  size?: number,
): Promise<void> {
  if (size !== undefined) validateWindow(size)
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const file = join(configDir, fileName)
  const release = await lockfile.lock(file, {
    realpath: false,
    retries: { retries: 20, minTimeout: 20, maxTimeout: 200 },
  })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    const data = readModelPreferences(configDir)
    const models = { ...(Object.hasOwn(data, providerID) ? data[providerID] : {}) }
    if (size === undefined) delete models[modelID]
    else Object.defineProperty(models, modelID, { value: size, enumerable: true, writable: true, configurable: true })
    Object.defineProperty(data, providerID, { value: models, enumerable: true, writable: true, configurable: true })
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
    await release()
  }
}

export function modelContextOverride(
  preferences: Preferences,
  providerID: string,
  modelID: string,
): number | undefined {
  return Object.hasOwn(preferences, providerID) && Object.hasOwn(preferences[providerID]!, modelID)
    ? preferences[providerID]![modelID]
    : undefined
}

export function withModelPreferences(provider: Provider, preferences: Preferences): Provider {
  return {
    ...provider,
    getModels: () =>
      provider.getModels().map((model) => {
        const contextWindow = modelContextOverride(preferences, provider.id, model.id)
        return contextWindow === undefined
          ? model
          : { ...model, contextWindow, maxTokens: Math.min(model.maxTokens, contextWindow) }
      }),
  }
}
