import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"
import { resolveDatasheetServer } from "../../datasheet-server.ts"
import { executionEnvSnapshot } from "../../domain/execution-env.ts"
import { CodelibError, createCodelibClient, object, sourceOf } from "./client.ts"
import { CODELIB_CONTRACT, type CodelibInput, type CodelibSource } from "./contract.ts"
import { materialize } from "./materialize.ts"

export interface CodelibToolOptions {
  server?: string
  configDir?: string
  env?: NodeJS.ProcessEnv
  builtIn?: string | null
  timeoutMs?: number
  archiveTimeoutMs?: number
}
function need(value: string | undefined, name: string) {
  if (!value?.trim()) throw new CodelibError(`Required parameter: ${name}`)
  return value
}
function cardEvidence(entry: Record<string, unknown>) {
  const targets = Array.isArray(entry.targets) ? entry.targets : []
  return {
    compatibility: targets.length ? "Declared targets only; hardware compatibility has not been independently verified." : "targets 未声明，兼容性未证实。",
    ...(entry.buildable === false ? { buildStatus: "未验证可编译。", buildNote: entry.buildNote ?? null } : {}),
  }
}

/** Pure read-only formatting, including full source pins in every search result. */
export function describeSearch(data: Record<string, unknown>): Record<string, unknown> & { hits: (Record<string, unknown> & { source: CodelibSource; compatibility: string })[] } {
  if (!Array.isArray(data.hits)) throw new CodelibError("Invalid search response: missing hits")
  const hits = data.hits.map(raw => {
    const hit = object(raw)
    const source = sourceOf(hit.source)
    const entry = object(hit.entry)
    return {
      ...hit, source, ...cardEvidence(entry),
    }
  })
  return { ...data, hits, scoreMeaning: "Scores are comparable only within this response.", ...(hits.length ? {} : { message: "过滤后无候选；使用 catalog 查看语料覆盖。" }) }
}

export function createCodelibTool(options: CodelibToolOptions = {}): AgentHarnessTool<ExecutionToolContext, typeof CODELIB_CONTRACT.parameters, Record<string, unknown>> {
  async function run(params: CodelibInput, cwd: string, signal: AbortSignal | undefined, env: NodeJS.ProcessEnv) {
    const result = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details: { action: params.action, ...details } })
    const server = resolveDatasheetServer({ explicit: options.server, env, configDir: options.configDir, builtIn: options.builtIn }).url
    if (!server) return result("例程库服务已关闭或未配置。使用统一的 YOMA_DATASHEET_SERVER 设置服务地址。")
    const client = createCodelibClient(server, signal, params.action === "materialize" ? options.archiveTimeoutMs ?? 600_000 : options.timeoutMs)
    try {
      let data: Record<string, unknown>
      if (params.action === "search") {
        const { queryText, target, ecosystem, board, peripherals, keywords, tier, entryKind, buildableOnly, corpora, limit } = params
        data = describeSearch(await client.json("/api/codelibs/search", { queryText, target, ecosystem, board, peripherals, keywords, tier, entryKind, buildableOnly, corpora, limit: limit ?? 6 }))
      } else if (params.action === "show") {
        const id = need(params.corpusId, "corpusId")
        const entryPath = need(params.path, "path")
        if (entryPath.includes("\\") || entryPath.split("/").some(part => !part || part === "." || part === "..")) throw new CodelibError("show path must be the exact relative card path, without traversal segments")
        const revision = need(params.revision, "revision (hit.source.revisionSha256; unedited fallback: indexSha256)")
        if (!/^[a-f0-9]{64}$/i.test(revision)) throw new CodelibError("revision must be an exact SHA256 from the selected hit")
        data = await client.json(`/api/codelibs/${encodeURIComponent(id)}/entries/${entryPath.split("/").map(encodeURIComponent).join("/")}?${new URLSearchParams({ revision })}`)
        data = { ...data, ...cardEvidence(data), requestedRevision: revision }
      } else if (params.action === "catalog") {
        data = await client.json(params.corpusId ? `/api/codelibs/${encodeURIComponent(params.corpusId)}/meta` : "/api/codelibs")
      } else {
        const id = need(params.corpusId, "corpusId")
        const commit = need(params.expectedCommit, "expectedCommit (from selected hit)")
        const sha = need(params.expectedArchiveSha256, "expectedArchiveSha256 (from selected hit)")
        const target = await materialize(client, cwd, id, commit, sha, params.archiveBytes ?? null, signal)
        const large = params.archiveBytes != null && params.archiveBytes > 500 * 1024 ** 2 ? "大语料（超过 500 MiB）。\n" : ""
        return result(`${large}源码已校验并取到 ${target}\n未执行、安装或构建；编译与硬件兼容性仍需验证。`, { path: target, corpusId: id, expectedCommit: commit, expectedArchiveSha256: sha, archiveBytes: params.archiveBytes ?? null })
      }
      const text = JSON.stringify(data, null, 2)
      // Read-only calls must not invoke the tool-output spill-to-disk helper.
      if (text.length > 100_000 && params.action === "search") {
        const compact = {
          _meta: data._meta ?? null, truncated: true,
          message: "卡片正文已截短；source 身份完整保留。使用 show 获取选定卡片。",
          hits: (data.hits as Record<string, unknown>[]).map(hit => {
            const entry = object(hit.entry)
            return { source: hit.source, score: hit.score, compatibility: hit.compatibility, buildStatus: hit.buildStatus, buildNote: hit.buildNote, entry: { path: entry.path, title: entry.title, summary: typeof entry.summary === "string" ? entry.summary.slice(0, 1000) : entry.summary } }
          }),
        }
        return result(JSON.stringify(compact, null, 2), compact)
      }
      if (text.length > 100_000) return result(text.slice(0, 100_000) + "\n[输出截断；缩小查询或指定 corpusId。]", { truncated: true, _meta: data._meta ?? null })
      return result(text, data)
    } catch (error) {
      if (signal?.aborted) throw error
      return result(error instanceof Error ? error.message : String(error), { error: true })
    }
  }
  return {
    name: CODELIB_CONTRACT.name, label: CODELIB_CONTRACT.label, description: CODELIB_CONTRACT.description, parameters: CODELIB_CONTRACT.parameters,
    execute: (_id, params, _onUpdate, toolContext, _invocation, context) => run(params, toolContext.env.cwd, context.abortSignal, options.env ?? executionEnvSnapshot(toolContext.env)),
  }
}
