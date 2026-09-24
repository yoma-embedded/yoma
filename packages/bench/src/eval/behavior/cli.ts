import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { ThinkingLevel } from "@earendil-works/pi-ai"
import { resolveEvalModels } from "../models.ts"
import { BEHAVIOR_CASES, getBehaviorCase } from "./cases.ts"
import { behaviorPrompt, runBehavior, type BehaviorResult } from "./run.ts"

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      cases: { type: "string" },
      trials: { type: "string", default: "1" },
      provider: { type: "string", default: "deepseek" },
      model: { type: "string", default: "deepseek-v4-flash" },
      thinking: { type: "string", default: "high" },
      "budget-usd": { type: "string", default: "0.5" },
      "max-requests": { type: "string", default: "8" },
      "max-output-tokens": { type: "string", default: "2048" },
      "timeout-ms": { type: "string", default: "90000" },
      "provider-retries": { type: "string", default: "0" },
      "config-dir": { type: "string" },
      "prompt-file": { type: "string" },
      snapshot: { type: "boolean", default: false },
    },
  })
  if (!values.out) throw new Error("--out <new output directory> is required")
  const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
  if (!thinkingLevels.includes(values.thinking)) throw new Error("Unknown thinking level")
  const trials = Number(values.trials),
    budget = Number(values["budget-usd"])
  const maxRequests = Number(values["max-requests"]),
    maxOutputTokens = Number(values["max-output-tokens"])
  const timeoutMs = Number(values["timeout-ms"])
  const providerRetries = Number(values["provider-retries"])
  if (!Number.isSafeInteger(providerRetries) || providerRetries < 0 || providerRetries > 2)
    throw new Error("provider-retries must be 0..2")
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10) throw new Error("trials must be 1..10")
  if (![budget, maxRequests, maxOutputTokens, timeoutMs].every((n) => Number.isFinite(n) && n > 0))
    throw new Error("Limits must be positive and finite")
  if (![maxRequests, maxOutputTokens, timeoutMs].every(Number.isSafeInteger))
    throw new Error("Request/token/time limits must be integers")
  const items = values.cases ? [...new Set(values.cases.split(","))].map(getBehaviorCase) : BEHAVIOR_CASES
  const supplied: unknown = values["prompt-file"] ? JSON.parse(readFileSync(values["prompt-file"], "utf8")) : undefined
  const prompts = Object.fromEntries(
    items.map((item) => {
      const prompt = supplied === undefined ? behaviorPrompt(item) : (supplied as Record<string, unknown>)?.[item.id]
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`Missing saved prompt for ${item.id}`)
      return [item.id, prompt]
    }),
  )
  const out = resolve(values.out)
  mkdirSync(dirname(out), { recursive: true })
  mkdirSync(out) // Never silently replace another experiment.
  const save = (name: string, value: unknown) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n")
  save("prompts.json", prompts)
  if (values.snapshot) {
    console.log(`Prompt snapshot: ${out}`)
    return
  }
  const { models, model } = await resolveEvalModels({
    configDir: resolve(values["config-dir"] ?? join(homedir(), ".yoma")),
    providerID: values.provider,
    modelID: values.model,
  })
  let revision = "unknown"
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    /* Source archive. */
  }
  save("experiment.json", {
    startedAt: new Date().toISOString(),
    revision,
    fixtureSourceHash: createHash("sha256")
      .update(readFileSync(new URL("./cases.ts", import.meta.url)))
      .digest("hex"),
    provider: model.provider,
    model: model.id,
    requestedThinking: values.thinking,
    catalogPricesPerMillionTokens: model.cost,
    cases: items.map(({ id, family, prompt, expected, respond, checkCalls }) => ({
      id,
      family,
      hash: createHash("sha256")
        .update(JSON.stringify({ prompt, expected, respond: String(respond), checkCalls: String(checkCalls) }))
        .digest("hex"),
    })),
    trials,
    budget,
    maxRequests,
    maxOutputTokens,
    timeoutMs,
    providerRetries,
    note: "Synthetic behavior eval: real model, production prompt/contracts/agent loop, simulated tool results. No hardware execution or end-to-end completion claim. Costs use the local model catalog, not provider billing. Aborted/error streams may omit usage.",
  })
  const results: BehaviorResult[] = []
  let spent = 0,
    reserved = 0,
    stopped: string | undefined
  const summary = () => ({
    scheduled: items.length * trials,
    completed: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    providerErrors: results.filter((r) => r.status === "provider_error").length,
    limited: results.filter((r) => r.status === "limited").length,
    requests: results.reduce((n, r) => n + r.requests, 0),
    toolCalls: results.reduce((n, r) => n + r.calls.length, 0),
    toolErrors: results.reduce((n, r) => n + r.calls.filter((c) => c.error).length, 0),
    uncachedInputTokens: results.reduce((n, r) => n + r.usage.input, 0),
    cacheReadTokens: results.reduce((n, r) => n + r.usage.cacheRead, 0),
    inputTokens: results.reduce((n, r) => n + r.usage.input + r.usage.cacheRead + r.usage.cacheWrite, 0),
    outputTokens: results.reduce((n, r) => n + r.usage.output, 0),
    reasoningTokens: results.reduce((n, r) => n + (r.usage.reasoning ?? 0), 0),
    estimatedCostUsd: spent,
    estimatedUsdPerPass: results.some((r) => r.status === "passed")
      ? spent / results.filter((r) => r.status === "passed").length
      : null,
    reservedCostUsd: reserved,
    stopped,
    trials: results.map(({ caseId, status, failures, requests, usage, elapsedMs, thinking }) => ({
      caseId,
      status,
      failures,
      requests,
      usage,
      elapsedMs,
      thinking,
    })),
  })
  outer: for (let trial = 1; trial <= trials; trial++) {
    for (const item of items) {
      if (reserved >= budget) {
        stopped = "Suite estimated cost limit"
        break outer
      }
      const result = await runBehavior({
        item,
        models,
        model,
        thinking: values.thinking as ThinkingLevel,
        providerRetries,
        systemPrompt: prompts[item.id],
        limits: { maxRequests, maxOutputTokens, timeoutMs, maxCost: Math.min(0.1, budget - reserved) },
      })
      spent += result.usage.cost.total
      reserved += result.reservedCostUsd
      results.push(result)
      save(`${String(trial).padStart(2, "0")}-${item.id}.json`, result)
      console.log(
        `${trial}/${trials} ${item.id}: ${result.status}, ${result.requests} requests, $${result.usage.cost.total.toFixed(6)}`,
      )
      save("summary.json", summary())
      // A missing/aborted response can hide billed usage; stop instead of spending
      // the same apparent remaining budget repeatedly. No automatic trial retries.
      if (result.status === "provider_error" || result.status === "limited") {
        stopped = `${result.caseId}: ${result.failures[0]}`
        break outer
      }
    }
  }
  save("summary.json", summary())
  console.log(
    JSON.stringify({ completed: results.length, passed: summary().passed, estimatedCostUsd: spent, stopped, out }),
  )
  if (stopped) process.exitCode = 2
  else if (results.some((r) => r.status !== "passed")) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
})
