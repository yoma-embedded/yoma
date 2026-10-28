import { createModels, type CredentialStore } from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import type { ProviderUsageView } from "../types.ts"
import { providerJson } from "./provider-http.ts"

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {}
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function subscriptionUsage(data: unknown): ProviderUsageView {
  const value = record(data)
  const buckets = [
    { name: "Codex", rate: value.rate_limit },
    ...(Array.isArray(value.additional_rate_limits)
      ? value.additional_rate_limits.map((entry) => {
          const row = record(entry)
          return {
            name: typeof row.limit_name === "string" ? row.limit_name.slice(0, 100) : "Codex",
            rate: row.rate_limit,
          }
        })
      : []),
  ]
  const windows: ProviderUsageView["windows"] = []
  for (const bucket of buckets) {
    for (const key of ["primary_window", "secondary_window"]) {
      const window = record(record(bucket.rate)[key])
      const usedPercent = number(window.used_percent)
      if (usedPercent === undefined) continue
      const seconds = number(window.limit_window_seconds)
      windows.push({
        name: bucket.name,
        usedPercent,
        windowMinutes: seconds === undefined ? undefined : seconds / 60,
        resetsAt: number(window.reset_at),
      })
    }
  }
  const credits = record(value.credits)
  return {
    status: windows.length || typeof credits.unlimited === "boolean" ? "ready" : "unavailable",
    checkedAt: Date.now(),
    windows,
    plan: typeof value.plan_type === "string" ? value.plan_type.slice(0, 100) : undefined,
    credits:
      typeof credits.unlimited === "boolean"
        ? {
            unlimited: credits.unlimited,
            balance:
              typeof credits.balance === "string" && /^\d+(\.\d+)?$/.test(credits.balance)
                ? credits.balance
                : undefined,
          }
        : undefined,
  }
}

/** Read only Yoma's credentials. Never return tokens, account IDs or backend error bodies. */
export async function readSubscriptionUsage(
  store: CredentialStore,
  fetcher = globalThis.fetch,
): Promise<ProviderUsageView> {
  const unavailable: ProviderUsageView = { status: "unavailable", checkedAt: Date.now(), windows: [] }
  try {
    const credential = await store.read("openai-codex")
    if (credential?.type !== "oauth") return { ...unavailable, status: "disconnected" }
    const models = createModels({
      credentials: store,
      authContext: { env: async () => undefined, fileExists: async () => false },
    })
    const provider = builtinProviders().find((p) => p.id === "openai-codex")!
    models.setProvider(provider)
    const auth = await models.getAuth(provider.id)
    if (!auth?.auth.apiKey) return unavailable
    const current = await store.read(provider.id)
    const headers: Record<string, string> = { Authorization: `Bearer ${auth.auth.apiKey}`, Accept: "application/json" }
    if (current?.type === "oauth" && typeof current.accountId === "string")
      headers["ChatGPT-Account-Id"] = current.accountId
    // Same read endpoint as openai/codex's backend-client; it may change independently of Pi.
    const response = await fetcher("https://chatgpt.com/backend-api/wham/usage", {
      headers,
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    })
    if (!response.ok) {
      await response.body?.cancel()
      return { ...unavailable, httpStatus: response.status }
    }
    return subscriptionUsage(await providerJson(response))
  } catch {
    return unavailable
  }
}
