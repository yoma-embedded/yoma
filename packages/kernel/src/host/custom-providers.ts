import { randomUUID } from "node:crypto"
import { createProvider, envApiKeyAuth, type Credential, type CredentialStore } from "@earendil-works/pi-ai"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import type { CustomProviderConfig, CustomProviderInput, CustomModelsInput } from "../types.ts"
import { providerJson } from "./provider-http.ts"

type CustomCredential = Credential & { yomaCustomProvider?: CustomProviderConfig }
const customId = /^custom-[0-9a-f-]{36}$/

export function providerBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Base URL must be a valid HTTP or HTTPS address")
  }
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Base URL must use HTTP or HTTPS, without credentials, query parameters or a fragment")
  return url.href.replace(/\/+$/, "")
}

function configuration(value: CustomProviderConfig): CustomProviderConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid custom provider configuration")
  const name = typeof value.name === "string" ? value.name.trim() : ""
  if (!name || name.length > 100) throw new Error("Provider name must contain 1–100 characters")
  const baseUrl = providerBaseUrl(value.baseUrl)
  if (!Array.isArray(value.modelIds) || value.modelIds.length === 0 || value.modelIds.length > 1000)
    throw new Error("Provide between 1 and 1000 model IDs")
  const modelIds = value.modelIds.map((id) => {
    if (typeof id !== "string" || !id.trim() || id.trim().length > 200 || /\s/.test(id.trim()))
      throw new Error("Model IDs must contain 1–200 characters without whitespace")
    return id.trim()
  })
  if (new Set(modelIds).size !== modelIds.length) throw new Error("Model IDs must be unique")
  if (!Number.isSafeInteger(value.contextWindow) || value.contextWindow < 1 || value.contextWindow > 10_000_000)
    throw new Error("Context window must be an integer between 1 and 10000000")
  if (!Number.isSafeInteger(value.maxOutput) || value.maxOutput < 1 || value.maxOutput > value.contextWindow)
    throw new Error("Maximum output must be a positive integer no larger than the context window")
  return {
    name,
    baseUrl,
    modelIds,
    contextWindow: value.contextWindow,
    maxOutput: value.maxOutput,
  }
}

export async function discoverCustomModels(
  store: CredentialStore,
  input: CustomModelsInput,
  fetcher = globalThis.fetch,
): Promise<string[]> {
  const baseUrl = providerBaseUrl(input.baseUrl)
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new Error("Invalid API key")
  let apiKey = input.apiKey?.trim()
  if (!apiKey && input.providerID) {
    if (!customId.test(input.providerID)) throw new Error("Unknown custom provider")
    const saved = (await store.read(input.providerID)) as CustomCredential | undefined
    if (saved?.type === "api_key" && saved.yomaCustomProvider?.baseUrl === baseUrl) apiKey = saved.key
  }
  if (!apiKey || apiKey.length > 16_384 || /[\r\n]/.test(apiKey)) throw new Error("Enter an API key for this Base URL")
  let data: unknown
  try {
    data = await providerJson(
      await fetcher(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      }),
    )
  } catch (error) {
    const status = error instanceof Error && /^HTTP \d{3}$/.test(error.message) ? ` (${error.message})` : ""
    throw new Error(`Could not import models${status}. Check the URL, API key and network; manual entry is available.`)
  }
  const rows = (data as { data?: unknown } | null)?.data
  if (!Array.isArray(rows)) throw new Error("Invalid model list: expected an OpenAI data array")
  const ids = [
    ...new Set(
      rows.flatMap((row: unknown) => {
        const id = (row as { id?: unknown } | null)?.id
        return typeof id === "string" && id.trim() && id.length <= 200 && !/\s/.test(id) ? [id] : []
      }),
    ),
  ].sort()
  if (ids.length === 0 || ids.length > 1000)
    throw new Error("The endpoint must return between 1 and 1000 valid model IDs")
  return ids
}

export async function readCustomProviders(
  store: CredentialStore,
): Promise<Array<{ id: string; config: CustomProviderConfig }>> {
  const entries = []
  for (const { providerId } of await store.list()) {
    if (!customId.test(providerId)) continue
    const credential = (await store.read(providerId)) as CustomCredential | undefined
    if (credential?.type !== "api_key" || !credential.yomaCustomProvider) continue
    entries.push({ id: providerId, config: configuration(credential.yomaCustomProvider) })
  }
  return entries
}

export async function saveCustomProvider(store: CredentialStore, input: CustomProviderInput): Promise<void> {
  const config = configuration(input)
  if (input.providerID !== undefined && (typeof input.providerID !== "string" || !customId.test(input.providerID)))
    throw new Error("Unknown custom provider")
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new Error("Invalid API key")
  const key = input.apiKey?.trim()
  if (key && (key.length > 16_384 || /[\r\n]/.test(key))) throw new Error("Invalid API key")
  const id = input.providerID ?? `custom-${randomUUID()}`
  await store.modify(id, async (current) => {
    const previous = current as CustomCredential | undefined
    if (input.providerID && (previous?.type !== "api_key" || !previous.yomaCustomProvider))
      throw new Error("Unknown custom provider")
    if (!key && previous?.yomaCustomProvider?.baseUrl !== config.baseUrl)
      throw new Error("Enter an API key when adding a provider or changing its Base URL")
    const savedKey = key || (previous?.type === "api_key" ? previous.key : undefined)
    if (!savedKey) throw new Error("API key is required")
    // One locked write keeps endpoint and key together, including failed edits.
    return { type: "api_key", key: savedKey, yomaCustomProvider: config } as CustomCredential
  })
}

export async function removeCustomProvider(store: CredentialStore, id: string): Promise<void> {
  if (typeof id !== "string" || !customId.test(id)) throw new Error("Unknown custom provider")
  await store.delete(id)
}

export function customProvider(id: string, config: CustomProviderConfig) {
  return createProvider({
    id,
    name: config.name,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${config.name} API key`, []) },
    api: openAICompletionsApi(),
    models: config.modelIds.map((modelId) => ({
      id: modelId,
      name: modelId,
      api: "openai-completions" as const,
      provider: id,
      baseUrl: config.baseUrl,
      reasoning: false,
      input: ["text" as const],
      contextWindow: config.contextWindow,
      maxTokens: config.maxOutput,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  })
}
