import type { CodelibSource } from "./contract.ts"

export class CodelibError extends Error {}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function sourceOf(value: unknown): CodelibSource {
  const source = object(value)
  for (const key of ["corpusId", "corpusVersion", "indexSha256"]) {
    if (typeof source[key] !== "string" || !source[key]) throw new CodelibError(`Search source is missing ${key}; cannot prove the selected version. Upgrade the server.`)
  }
  const shaFields = ["corpusVersion", "indexSha256", "revisionSha256", "archiveSha256", ...(Object.hasOwn(source, "enrichSha256") ? ["enrichSha256"] : [])]
  for (const key of shaFields) {
    const hash = source[key]
    if (hash !== null && (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash))) throw new CodelibError(`Invalid source ${key}.`)
  }
  if (source.commit !== null && (typeof source.commit !== "string" || !source.commit)) throw new CodelibError("Invalid source commit (missing identity must be explicit null).")
  if (source.archiveBytes !== null && (!Number.isSafeInteger(source.archiveBytes) || (source.archiveBytes as number) < 0)) throw new CodelibError("Invalid source archiveBytes (unknown size must be explicit null).")
  return source as unknown as CodelibSource
}

/** Timeout spans headers AND body. Callback must consume the body before returning. */
export function createCodelibClient(server: string, signal?: AbortSignal, timeoutMs = 30_000) {
  async function request<T>(route: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error("Codelib request timed out")), timeoutMs)
    try {
      const response = await fetch(`${server}${route}`, { ...init, signal: controller.signal })
      if (!response.ok) {
        const labels: Record<number, string> = { 404: "endpoint or pinned source unavailable", 405: "endpoint unavailable", 409: "SOURCE_CHANGED: selected source changed; search again", 422: "invalid query parameters", 429: "rate limited; retry later", 503: "search source/index unavailable; retry later" }
        const detail = (await response.text()).slice(0, 2000)
        throw new CodelibError(`Codelib HTTP ${response.status}: ${labels[response.status] ?? "request failed"}${detail ? `\n${detail}` : ""}`)
      }
      return await consume(response)
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new Error("Cancelled")
      if (error instanceof CodelibError) throw error
      throw new CodelibError(controller.signal.aborted ? "Codelib server timed out while receiving the response." : `Codelib server unavailable: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
  }
  return {
    json: (route: string, body?: unknown) => request(route, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, async response => {
      const value: unknown = await response.json()
      if (Array.isArray(value)) return { corpora: value }
      if (!value || typeof value !== "object") throw new CodelibError("Invalid codelib JSON response")
      return object(value)
    }),
    archive: <T>(corpusId: string, commit: string, sha: string, consume: (response: Response) => Promise<T>) => request(`/api/codelibs/${encodeURIComponent(corpusId)}/archive?${new URLSearchParams({ expectedCommit: commit, expectedArchiveSha256: sha })}`, {}, consume),
  }
}
