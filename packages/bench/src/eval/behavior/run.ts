import { createHash } from "node:crypto"
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  withAbortSignal,
  type AgentHarnessTool,
  type AgentMessage,
} from "@earendil-works/pi-agent-core"
import { clampThinkingLevel, type Models, type Model, type ThinkingLevel, type Usage } from "@earendil-works/pi-ai"
import { buildSystemPrompt } from "@yoma-desktop/kernel/host"
import { toolContract } from "@yoma-desktop/kernel/tools/contracts"
import type { BehaviorCase, FixtureCall } from "./cases.ts"

export interface BehaviorLimits {
  maxRequests: number
  maxOutputTokens: number
  timeoutMs: number
  maxCost: number
}
export const DEFAULT_BEHAVIOR_LIMITS: BehaviorLimits = {
  maxRequests: 8,
  maxOutputTokens: 2048,
  timeoutMs: 90_000,
  maxCost: 0.1,
}

export interface BehaviorResult {
  caseId: string
  provider: string
  model: string
  thinking: string
  promptHash: string
  schemaHash: string
  status: "passed" | "failed" | "provider_error" | "limited"
  failures: string[]
  requests: number
  reservedCostUsd: number
  elapsedMs: number
  usage: Usage
  calls: FixtureCall[]
  finalText: string
  trace: unknown[]
}

export function behaviorPrompt(item: BehaviorCase): string {
  return buildSystemPrompt({ cwd: "/fixture", selectedTools: item.tools, contextFiles: [], skills: [] })
}

export function gradeBehavior(item: BehaviorCase, finalText: string, calls: readonly FixtureCall[]): string[] {
  let answer: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(finalText.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ["Final answer is not an object"]
    answer = parsed as Record<string, unknown>
  } catch {
    return ["Final answer is not valid JSON"]
  }
  const failures = Object.entries(item.expected).flatMap(([key, value]) =>
    answer[key] === value ? [] : [`${key}: expected ${JSON.stringify(value)}, received ${JSON.stringify(answer[key])}`],
  )
  if (!item.checkCalls(calls)) failures.push("Required observation or recovery behavior was not performed")
  return failures
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}
function accumulate(total: Usage, usage: Usage): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key]
  total.reasoning = (total.reasoning ?? 0) + (usage.reasoning ?? 0)
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key]
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const textOf = (m: Extract<AgentMessage, { role: "assistant" | "toolResult" }>) =>
  typeof m.content === "string"
    ? m.content
    : m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")

/** Real durable agent loop and production contracts; only tool execution is simulated.
 * Cost/step/time limits are evaluation controls, never production bench policy.
 * No ambient context discovery, execution environment, or hardware tool is created.
 */
export async function runBehavior(options: {
  item: BehaviorCase
  models: Models
  model: Model<string>
  thinking?: ThinkingLevel
  providerRetries?: number
  systemPrompt?: string
  limits?: Partial<BehaviorLimits>
}): Promise<BehaviorResult> {
  const { item, models, model } = options
  const providerRetries = options.providerRetries ?? 0
  if (!Number.isSafeInteger(providerRetries) || providerRetries < 0 || providerRetries > 2)
    throw new Error("providerRetries must be 0..2")
  const limits = { ...DEFAULT_BEHAVIOR_LIMITS, ...options.limits }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${key}: ${value}`)
  }
  if (!Number.isInteger(limits.maxRequests) || !Number.isInteger(limits.maxOutputTokens))
    throw new Error("Token/request limits must be integers")
  const systemPrompt = options.systemPrompt ?? behaviorPrompt(item)
  const thinking = clampThinkingLevel(model, options.thinking ?? "high")
  const calls: FixtureCall[] = [],
    trace: unknown[] = []
  const usage = zeroUsage()
  const tools: AgentHarnessTool<undefined>[] = item.tools.map((name) => {
    const contract = toolContract(name)
    if (!contract) throw new Error(`No production contract for fixture tool ${name}`)
    return {
      name,
      label: contract.label,
      description: contract.description,
      parameters: contract.parameters,
      execute: async (_id, params) => {
        const input = params as Record<string, unknown> // Validated against the production object schema by the harness.
        const call: FixtureCall = { name, input, output: "", error: false }
        try {
          call.output = item.respond(name, input, calls)
          return { content: [{ type: "text", text: call.output }], details: {} }
        } catch (error) {
          call.error = true
          call.output = error instanceof Error ? error.message : String(error)
          throw error
        } finally {
          calls.push(call)
        }
      },
    }
  })
  const schema = JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })))
  const repo = new MemorySessionRepo()
  const session = await repo.create({}, BACKGROUND_CONTEXT)
  const controller = new AbortController()
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
  const started = Date.now()
  let limited: string | undefined,
    requests = 0,
    reservedCostUsd = 0,
    finalText = "",
    providerError: string | undefined
  const stop = (reason: string) => {
    limited ??= reason
    controller.abort(new Error(reason))
  }
  const timer = setTimeout(() => stop("Trial time limit"), limits.timeoutMs)
  // The harness intentionally exposes only curated stream options. Cap tokens at
  // the model boundary without changing the upstream engine or provider payload.
  const boundedModels = new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple")
        return ((requestModel, requestContext, streamOptions) => {
          const bytes = Buffer.byteLength(JSON.stringify(requestContext)) + 2048
          const reservation =
            ((bytes * requestModel.cost.input + limits.maxOutputTokens * requestModel.cost.output) / 1_000_000) *
            (1 + providerRetries)
          if (requests >= limits.maxRequests) stop("Trial request limit")
          else if (reservedCostUsd + reservation > limits.maxCost) stop("Trial estimated cost limit")
          if (limited) throw new Error(limited)
          requests++
          reservedCostUsd += reservation
          // Some providers add a thinking budget to options.maxTokens. Cap the
          // request-local model ceiling too, so reasoning stays inside the cap.
          const cappedModel = { ...requestModel, maxTokens: Math.min(requestModel.maxTokens, limits.maxOutputTokens) }
          return target.streamSimple(cappedModel, requestContext, {
            ...streamOptions,
            maxTokens: limits.maxOutputTokens,
            maxRetries: providerRetries,
          })
        }) satisfies Models["streamSimple"]
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  let harness: AgentHarness<undefined> | undefined
  try {
    ;({ harness } = await AgentHarness.create(
      {
        session,
        models: boundedModels,
        model,
        thinkingLevel: thinking,
        tools,
        systemPrompt,
        streamOptions: { maxRetries: 0, timeoutMs: limits.timeoutMs },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
        toolExecution: "parallel",
      },
      BACKGROUND_CONTEXT,
    ))
    harness.events.on("message_end", ({ message }) => {
      if (message.role === "assistant") {
        accumulate(usage, message.usage)
        finalText = textOf(message)
        if (message.stopReason === "error" || (message.stopReason === "aborted" && !limited))
          providerError = message.errorMessage ?? `Provider ${message.stopReason}`
        trace.push({
          role: message.role,
          text: finalText,
          calls: message.content.filter((p) => p.type === "toolCall"),
          usage: message.usage,
          stopReason: message.stopReason,
        })
      } else if (message.role === "toolResult") {
        trace.push({ role: message.role, name: message.toolName, text: textOf(message), error: message.isError })
      }
    })
    const lane = await harness.lane("main", BACKGROUND_CONTEXT)
    try {
      const result = await lane.prompt(item.prompt, undefined, context)
      if (!result.ok && !limited) providerError ??= result.error.message
    } catch (error) {
      if (!limited) providerError ??= error instanceof Error ? error.message : String(error)
    }
    const failures = gradeBehavior(item, finalText, calls)
    if (limited) failures.unshift(limited)
    if (providerError) failures.unshift(providerError)
    return {
      caseId: item.id,
      provider: model.provider,
      model: model.id,
      thinking,
      promptHash: hash(systemPrompt),
      schemaHash: hash(schema),
      status: limited ? "limited" : providerError ? "provider_error" : failures.length ? "failed" : "passed",
      failures,
      requests,
      reservedCostUsd,
      elapsedMs: Date.now() - started,
      usage,
      calls,
      finalText,
      trace,
    }
  } finally {
    clearTimeout(timer)
    try {
      await harness?.close(BACKGROUND_CONTEXT)
    } finally {
      await repo.close(BACKGROUND_CONTEXT)
    }
  }
}
