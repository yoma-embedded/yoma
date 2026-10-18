/**
 * datasheet 工具的厨房那一半:四个动作 → 数据手册服务器 → 人话。
 *
 * 【架构】完全在线、零本地状态:检索、解析文本、图片全部按需从服务器读。客户端不落索引、不落产物、不需要
 * embedding key —— 那些都是服务器的事,本机唯一的配置是地址(`host/datasheet-server.ts`,内置默认 =
 * 维护者的公共服务器,`~/.yoma/.env` 或环境变量覆盖,off 关闭)与接口版本(`YOMA_DATASHEET_API`)。
 *
 * - search:       v2:      POST {server}/api/v2/search { query, keywords?, scope:{targets,docs,doc_types}, top_k, detail }
 *                 v1:      POST {server}/api/search   { query, chip, rev?, top_k } → { hits }
 * - read_section: GET  {server}/artifacts/<parsed_path> + 本机 markdown 章节抽取(domain/datasheet/section.ts)
 * - view_figure:  GET  {server}/artifacts/<image_path> → 过 domain/image 压到供应商内嵌上限以内 → ImageContent
 * - chips:        v2: GET {server}/api/v2/docs(替代 4.3 MB manifest);v1: GET {server}/api/manifest
 *
 * 【v2 的范围由服务端解析】DESIGN-v3 §6/§7.5:模型给的 `chip` 原样进 scope.targets,`rev` 原样进 scope.docs;
 * 型号 → 家族 → 分卷 → GENERAL 的解析、降级梯子和每条的 reasons 都归服务端。客户端不再做 v1 那四件补丁
 * (拉 manifest 建家族索引、分卷展开与合并、全是 GENERAL 时放宽重查、型号 → 家族改名)。422 scope_unresolved
 * 的候选、`scope_resolved` 里的实际范围、`degraded` 的原因都原样摆给模型 —— 这些是它判断"结果是不是我这颗
 * 芯片"的唯一线索。v2 的 score 只在单次响应内可比,所以不跨请求合并、不排序。
 *
 * 【v1 原样保留】旧服务器 / 自建服务器可能只有 v1。`auto`(缺省)先 v2,**只在明确 404/405 时**回落 v1;
 * 422 / 429 / 503 是 v2 在回答(范围 / 限流 / 索引),静默回落会把服务端的候选和降级说明一起吞掉。
 * 回落时回复第一行就说明用了旧接口、keywords 未发送,并继续走完整的 v1 解析(家族名、分卷基名、GENERAL 兜底)。
 *
 * 【没有队列】四个动作都只读、无状态,并行没有任何冲突;芯片索引缓存自己单飞(client.ts)。
 * 【没有 dispose】不起进程、不占设备;在飞的请求由每次调用的 abortSignal 收。
 */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import { datasheetEnvFile, resolveDatasheetServer } from "../../datasheet-server.ts"
import { executionEnvSnapshot } from "../../domain/execution-env.ts"
import {
  artifactPathProblem,
  capped,
  type ChipFamily,
  chipCandidatesNote,
  chipMissNote,
  coveringNote,
  type DatasheetApiVersion,
  docFamily,
  figureMime,
  findPhrase,
  formatCandidateList,
  formatChipList,
  formatCitation,
  formatDegraded,
  formatFamilyManuals,
  formatScopeResolved,
  formatV2Citation,
  formatV2ChipList,
  formatV2FamilyManuals,
  GENERAL_CHIP,
  groupDocsByFamily,
  hitsAreAllGeneral,
  lastSegment,
  manualCount,
  manualCountLine,
  matchHeading,
  mergeHits,
  norm,
  normChip,
  onTarget,
  parseHeadings,
  resolveChip,
  resolveRev,
  type SearchHit,
  sectionRange,
  splitByScope,
  tableOfContents,
  uniqueDocs,
  unknownChipHelp,
  type V2DocMeta,
  type V2SearchHit,
  type V2SearchResult,
  type V2TargetResolved,
  validName,
} from "../../domain/datasheet/index.ts"
import { clamp } from "../../domain/engines.ts"
import { processImage } from "../../domain/image/process.ts"
import {
  createDatasheetClient,
  DATASHEET_API_ENV,
  isUnreachable,
  noServerHelp,
  resolveDatasheetApiVersion,
  type SearchOutcome,
} from "./client.ts"
import {
  DATASHEET_CONTRACT,
  type DatasheetDetails,
  type DatasheetInput,
  DEFAULT_MAX_CHARS,
  DEFAULT_TOP_K,
  MAX_MAX_CHARS,
  MAX_TOP_K,
  MIN_MAX_CHARS,
} from "./contract.ts"

export interface DatasheetToolOptions {
  /** 显式地址,压过环境变量 / .env / 内置默认。 */
  server?: string
  /** `.env` 所在目录,默认 ~/.yoma。测试与 bench 注入。 */
  configDir?: string
  /** 默认 process.env。测试注入。 */
  env?: NodeJS.ProcessEnv
  /** `null` = 没有内置默认(测试复现"未配置");undefined = 用 DEFAULT_DATASHEET_SERVER。 */
  builtIn?: string | null
  /** API 调用(search)的超时,默认 20 s。 */
  timeoutMs?: number
  /** 产物(parsed markdown / 图片)与 manifest 的超时,默认 60 s。 */
  artifactTimeoutMs?: number
  /** 接口版本:auto(缺省)/ v1 / v2。不传时读 env 的 YOMA_DATASHEET_API。 */
  apiVersion?: DatasheetApiVersion
}

export type DatasheetTool = AgentHarnessTool<
  ExecutionToolContext,
  typeof DATASHEET_CONTRACT.parameters,
  DatasheetDetails
>

/** 数据手册服务器基址:显式 > 环境变量 > `<configDir>/.env` > 内置默认;off 关闭。解析规则只有一份(host/datasheet-server.ts)。 */
export function serverUrl(options?: DatasheetToolOptions): string | undefined {
  return resolveDatasheetServer({
    explicit: options?.server,
    env: options?.env,
    configDir: options?.configDir,
    builtIn: options?.builtIn,
  }).url
}

/** 图片下载上限。内嵌给模型的上限由 domain/image 管(4.5 MB base64);这里挡的是根本不该下的东西。 */
export const MAX_FIGURE_BYTES = 16 * 1024 * 1024
/** 分卷扇出的上限:真 manifest 里最多 10 卷;超过的只查前几卷并说明。 */
export const MAX_FANOUT = 12

const MIB = 1024 * 1024
const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`

type Result = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]
  details: DatasheetDetails
}

function textResult(text: string, details: DatasheetDetails): Result {
  return { content: [{ type: "text", text }], details }
}

const need = (value: string | undefined, action: string, field: string): string => {
  if (!value || !value.trim()) throw new Error(`datasheet ${action} requires ${field}`)
  return value.trim()
}

function hitSummary(h: SearchHit): NonNullable<DatasheetDetails["hits"]>[number] {
  return {
    manual_name: h.manual_name,
    chip: h.chip,
    rev: h.rev,
    page: h.page,
    headings: h.headings,
    score: h.score,
    parsed_path: h.parsed_path,
    image_path: h.image_path,
    source_pdf: h.source_pdf,
  }
}

function hitSummaryV2(h: V2SearchHit): NonNullable<DatasheetDetails["hits"]>[number] {
  return {
    ...hitSummary(h),
    rank: h.rank,
    ...(h.reasons.length ? { reasons: h.reasons } : {}),
    ...(h.doc.doc_id ? { doc_id: h.doc.doc_id } : {}),
    ...(h.doc.doc_uid ? { doc_uid: h.doc.doc_uid } : {}),
    ...(h.doc.targets.length ? { targets: h.doc.targets } : {}),
    ...(h.chunk.legacy_rev ? { legacyRev: h.chunk.legacy_rev } : {}),
    ...(h.chunk.text_truncated ? { textTruncated: true } : {}),
  }
}

/** 这本在、rev 也对,就是这次查询没中。 */
function pinnedMissNote(family: ChipFamily, rev: string): string {
  return (
    `NOTE: chip "${family.chip}" is indexed and rev "${rev}" exists, but nothing in that manual matched this query — ` +
    `rephrase with the peripheral/register name, or drop \`rev\` to search the whole family (${manualCountLine(family)}).`
  )
}

// ─── v2 给模型的话 ────────────────────────────────────────────────────────────

const V2_SCORE_NOTE =
  "NOTE: v2 scores are fused / reranked per request and are comparable only within this response — never compare a score from this search with one from another search."

const V2_GENERAL_NOTE =
  "NOTE: every hit is from the GENERAL (cross-chip) bucket. The server may have widened the scope — check the scope line and the per-hit reasons before treating these as facts about your part."

const V2_NO_HITS_NOTE =
  "NOTE: the server returned no matching chunks for this scope. Rephrase with the peripheral / register name, or drop `rev` / widen `chip`."

const V1_KEYWORDS_NOTE =
  "NOTE: apiVersion=v1 is in use, so `keywords` was not sent — legacy search ranks by vector similarity only and does no server-side scope resolution."

/** auto 模式下 v2 端点不在(404/405)时,回复第一行必须说明用了旧接口。 */
function v1FallbackNote(status: number, endpoint: "search" | "chips"): string {
  const path = endpoint === "search" ? "POST /api/v2/search" : "GET /api/v2/docs"
  const used = endpoint === "search" ? "the legacy POST /api/search" : "the legacy GET /api/manifest"
  const consequence =
    endpoint === "search"
      ? "Legacy v1 ranks by vector similarity only, ignores `keywords`, and the tool (not the server) resolves chip families and page-range parts. "
      : "Legacy v1 chips reads the full manifest instead of the lightweight document list. "
  return (
    `NOTE: this datasheet server has no ${path} (HTTP ${status}); ${used} was used instead. ` +
    consequence +
    `Upgrading the server enables v2 scope resolution and hybrid retrieval.`
  )
}

/**
 * 把 v1 结果标成 v1 / 回落,并在正文最前面加一段说明。v1 的每一处返回都经过这里,
 * 所以不会出现"走了旧接口却不说"的回复。
 */
function withApiNote(result: Result, note: string | undefined, extra: Partial<DatasheetDetails> = {}): Result {
  const details: DatasheetDetails = { ...result.details, apiVersion: "v1", ...extra }
  if (!note) return { ...result, details }
  const content = [...result.content]
  const index = content.findIndex((part) => part.type === "text")
  if (index >= 0) {
    const part = content[index]!
    if (part.type === "text") content[index] = { ...part, text: `${note}\n\n${part.text}` }
  } else {
    content.unshift({ type: "text", text: note })
  }
  return { content, details }
}

export function createDatasheetTool(options: DatasheetToolOptions = {}): DatasheetTool {
  const run = async (
    params: DatasheetInput,
    signal: AbortSignal | undefined,
    env: NodeJS.ProcessEnv,
  ): Promise<Result> => {
    const configuration = resolveDatasheetServer({
      explicit: options?.server,
      env,
      configDir: options?.configDir,
      builtIn: options?.builtIn,
    })
    const server = configuration.url
    if (!server) {
      return textResult(noServerHelp(datasheetEnvFile({ env, configDir: options.configDir })), {
        action: params.action,
      })
    }
    const apiVersion = resolveDatasheetApiVersion(options.apiVersion, env)
    const client = createDatasheetClient(server, {
      configuration,
      timeoutMs: options.timeoutMs,
      artifactTimeoutMs: options.artifactTimeoutMs,
      apiVersion,
      signal,
    })

    /**
     * v1 搜索:2026-09 之前那套完整逻辑,原样保留给旧服务器 / 自建服务器。
     * 四件服务器不兜的事(教训都在 domain/datasheet/chips.ts 文件头):
     * 1. chip 是型号不是家族名时,服务器不报错、回一堆 GENERAL 噪声 —— 一条目标家族的命中都没有就拉 manifest
     *    把型号解析成家族名重查;解析不出来就**明说不认识**并给候选,绝不让 GENERAL 冒充答案。
     * 2. rev 是分卷手册的基名(`RM0390`)时服务器一条都不回 —— 解析成全部卷。先打一枪家族范围(20 条)看目标卷
     *    的命中够不够;不够才每卷各搜一次再按分数合并。
     * 3. 家族确实收录了、前 k 条却全是 GENERAL —— 放宽到服务器上限 20 条把本家族的挖出来。
     * 4. 精确的 chip + rev 一条都没中:说清楚"这本在、但没匹配"。
     */
    const searchV1 = async (query: string, wanted: string, rev: string | undefined, k: number): Promise<Result> => {
      const post = (chip: string, pin: string | undefined, topK = k) => client.searchV1(query, chip, pin, topK)
      const failed = (outcome: SearchOutcome, chip: string): Result | undefined =>
        "failed" in outcome
          ? textResult(outcome.failed, { action: "search", chip, rev, topK: k, apiVersion: "v1" })
          : undefined
      const hitsOf = (outcome: SearchOutcome): SearchHit[] => ("hits" in outcome ? outcome.hits : [])
      const answer = (
        hits: SearchHit[],
        searched: string,
        notes: string[],
        extra: Partial<DatasheetDetails> = {},
      ): Result => {
        const note = notes.filter(Boolean).join("\n\n")
        return {
          content: [
            {
              type: "text",
              text:
                (note ? `${note}\n\n` : "") +
                (hits.map(formatCitation).join("\n---\n") || "(no matching datasheet chunks found)"),
            },
          ],
          details: {
            action: "search",
            apiVersion: "v1",
            chip: wanted,
            resolvedChip: searched === wanted ? undefined : searched,
            rev,
            topK: k,
            hits: hits.map(hitSummary),
            ...extra,
          },
        }
      }

      // 名字不合法(空格、中文、括号)服务器直接 422 —— 别白打,直接去索引里解析。
      const namesOk = validName(wanted) && (!rev || validName(rev))
      let first: SearchHit[] = []
      if (namesOk) {
        const outcome = await post(wanted, rev)
        const bad = failed(outcome, wanted)
        if (bad) return bad
        first = hitsOf(outcome)
        // GENERAL 本身是一个合法的搜索范围;别的家族有一条本家命中就算搜到了。
        if (normChip(wanted) === GENERAL_CHIP || onTarget(first)) return answer(first, wanted, [])
      }

      const index = await client.chipIndexQuietly()
      if (!index) {
        // 索引不可用(旧服务器 / 拉不下来):命中原样给,但落空必须说成落空 —— 这正是这个工具存在的理由。
        const scope = `"${wanted}"${rev ? ` / rev "${rev}"` : ""}`
        const note = !namesOk
          ? `${scope} is not a valid index name (letters, digits, . _ - only) and the server's manifest could not be read to resolve it — use action "chips" or pass the exact family name.`
          : first.length
            ? `NOTE: every hit below is from the cross-chip GENERAL corpus, and the server's manifest could not be read to check ${scope} against the index. Treat this as a MISS — "${wanted}" is probably not the indexed family name (the corpus is filed by family: AT32F421C8T7 → "AT32F") — not as an answer about your part. Retry action "chips" later or pass the exact family name.`
            : `NOTE: no chunks came back for ${scope}, and the server's manifest could not be read to check the names against the index. Retry action "chips" later, or search without \`rev\`.`
        return answer(first, wanted, [note])
      }

      const resolution = resolveChip(index, wanted)
      if (resolution.kind !== "exact" && resolution.kind !== "family") {
        return textResult(unknownChipHelp(wanted, resolution), {
          action: "search",
          apiVersion: "v1",
          chip: wanted,
          rev,
          topK: k,
        })
      }
      const family = index.get(normChip(resolution.chip))!
      const notes: string[] = []
      if (resolution.kind === "family") {
        notes.push(
          `NOTE: "${wanted}" is not an index name — this corpus is filed by device FAMILY. Searched "${family.chip}" instead; pass that as \`chip\` from here on.`,
        )
        notes.push(coveringNote(family, wanted))
      } else if (wanted !== family.chip) {
        notes.push(`NOTE: the index name is "${family.chip}" — pass exactly that as \`chip\` from here on.`)
      }
      const renamed = wanted !== family.chip

      if (rev) {
        const pinned = resolveRev(family, rev)
        if (pinned.kind === "unknown") return answer(first, family.chip, [...notes, chipMissNote(family, rev)])
        if (pinned.kind === "exact") {
          // 名字都对、就是这一本,而且已经搜过一次:那份结果就是答案 —— 空的也要说清是空的。
          if (!renamed && namesOk && pinned.rev === rev) {
            return answer(first, family.chip, first.length ? notes : [...notes, pinnedMissNote(family, rev)])
          }
          const outcome = await post(family.chip, pinned.rev)
          const bad = failed(outcome, family.chip)
          if (bad) return bad
          if (pinned.rev !== rev) notes.push(`NOTE: rev "${rev}" is spelled "${pinned.rev}" in the index.`)
          const hits = hitsOf(outcome)
          return answer(hits, family.chip, hits.length ? notes : [...notes, pinnedMissNote(family, pinned.rev)], {
            searchedRevs: [pinned.rev],
          })
        }
        // 分卷:先一枪家族范围(20 条),目标卷够 k 条就不扇出;不够再每卷各搜一次合并。
        const parts = pinned.revs.slice(0, MAX_FANOUT)
        const partSet = new Set(parts)
        const wide = await post(family.chip, undefined, MAX_TOP_K)
        const badWide = failed(wide, family.chip)
        if (badWide) return badWide
        const fromParts = hitsOf(wide).filter((h) => partSet.has(h.rev))
        let hits: SearchHit[]
        let how: string
        if (fromParts.length >= k) {
          hits = fromParts.slice(0, k)
          how = "one family-wide query already held enough chunks from them"
        } else {
          const outcomes = await Promise.all(parts.map((part) => post(family.chip, part)))
          for (const outcome of outcomes) {
            const bad = failed(outcome, family.chip)
            if (bad) return bad
          }
          hits = mergeHits([fromParts, ...outcomes.map(hitsOf)], k)
          how = `each part was queried (${parts.length} queries) and the results merged by score`
        }
        notes.push(
          `NOTE: rev "${rev}" is stored as ${pinned.revs.length} page-range parts on the server (${pinned.revs.join(", ")}); ${how}.` +
            (pinned.revs.length > parts.length
              ? ` Only the first ${parts.length} parts were queried individually.`
              : ""),
        )
        return answer(hits, family.chip, hits.length ? notes : [...notes, pinnedMissNote(family, rev)], {
          searchedRevs: parts,
        })
      }

      // 无 rev。家族名换过 / 还没打过:先用对的名字搜一次。
      let hits = first
      if (renamed || !namesOk) {
        const outcome = await post(family.chip, undefined)
        const bad = failed(outcome, family.chip)
        if (bad) return bad
        hits = hitsOf(outcome)
        if (onTarget(hits)) return answer(hits, family.chip, notes)
      }
      // 家族收录了、前 k 条却全是 GENERAL:放宽到服务器上限把本家族的挖出来。
      let wide = hits
      if (k < MAX_TOP_K) {
        const outcome = await post(family.chip, undefined, MAX_TOP_K)
        const bad = failed(outcome, family.chip)
        if (bad) return bad
        wide = hitsOf(outcome)
      }
      const { target, general } = splitByScope(wide)
      if (target.length) {
        const shownTargets = target.slice(0, k)
        const shownGeneral = general.slice(0, k - shownTargets.length)
        const outscored = general.filter((g) => g.score > target[0]!.score).length
        notes.push(
          `NOTE: ${outscored} cross-chip [GENERAL] chunk(s) outscored the best "${family.chip}" chunk for this query; the ${shownTargets.length} best "${family.chip}" chunk(s) are listed first${shownGeneral.length ? `, then the top ${shownGeneral.length} GENERAL` : ""}.`,
        )
        return answer([...shownTargets, ...shownGeneral], family.chip, notes)
      }
      return answer(hits, family.chip, [...notes, chipMissNote(family, undefined)])
    }

    /** v1 chips:manifest 家族视图。旧服务器 / 显式 v1 的路径。 */
    const chipsV1 = async (asked: string | undefined): Promise<Result> => {
      const index = await client.chipIndex()
      if (!index) {
        return textResult(
          `The datasheet server at ${server} does not expose GET /api/manifest (or it is empty), so the indexed chip list cannot be read. ` +
            `Pass \`chip\` as the device family (not the part number) and search directly.`,
          { action: "chips", apiVersion: "v1" },
        )
      }
      if (asked) {
        const resolution = resolveChip(index, asked)
        if (resolution.kind === "exact" || resolution.kind === "family") {
          const family = index.get(normChip(resolution.chip))!
          const details: DatasheetDetails = {
            action: "chips",
            apiVersion: "v1",
            chip: family.chip,
            manuals: manualCount(family),
          }
          if (normChip(family.chip) === GENERAL_CHIP) {
            return textResult(
              `"GENERAL" is the shared cross-chip bucket (${manualCountLine(family)}: Cortex-M core programming manuals, schematic conventions, tutorials). ` +
                `It is folded into every search automatically whenever \`rev\` is omitted — search your chip's own family, not GENERAL.\n${formatFamilyManuals(family, 200)}`,
              details,
            )
          }
          const from = normChip(resolution.chip) === normChip(asked) ? "" : ` (resolved from "${asked}")`
          const covering = resolution.kind === "family" ? coveringNote(family, asked) : ""
          return textResult(
            `chip "${family.chip}"${from} — ${manualCountLine(family)} indexed:\n${formatFamilyManuals(family, 200)}\n\n` +
              (covering ? `${covering}\n\n` : "") +
              `Search it with { action: "search", chip: "${family.chip}", query: … }, optionally \`rev\` set to one of the above.`,
            details,
          )
        }
        return textResult(chipCandidatesNote(asked, resolution), {
          action: "chips",
          apiVersion: "v1",
          chip: asked,
          families: index.size,
        })
      }
      const families = [...index.values()]
      const docs = families.reduce((n, f) => n + manualCount(f), 0)
      const parts = families.reduce((n, f) => n + f.manuals.length, 0)
      return textResult(
        `${index.size} indexed chip families, ${docs} manuals${parts > docs ? ` (${parts} page-range parts)` : ""}. ` +
          `The number in parentheses is that family's manual count; pass \`chip\` to list one family's manuals (each with the \`rev\` to search it by). ` +
          `GENERAL is the shared cross-chip bucket, folded into every search without \`rev\` — do not search it directly.\n\n${formatChipList(index)}`,
        { action: "chips", apiVersion: "v1", families: index.size, manuals: docs },
      )
    }

    /** v2 搜索的回复:范围 / 降级 / 理由 / score 可比性都摆在正文里,命中顺序不重排。 */
    const answerV2 = (
      result: V2SearchResult,
      wanted: string,
      rev: string | undefined,
      k: number,
      keywords?: string,
    ): Result => {
      const notes: string[] = []
      const scope = formatScopeResolved(result.scopeResolved)
      if (scope) notes.push(scope)
      const degraded = formatDegraded(result.degraded)
      if (degraded) notes.push(degraded)
      if (hitsAreAllGeneral(result.hits)) notes.push(V2_GENERAL_NOTE)
      if (!result.hits.length) notes.push(V2_NO_HITS_NOTE)
      else notes.push(V2_SCORE_NOTE)
      const body =
        result.hits.map((hit, index) => formatV2Citation(hit, index)).join("\n---\n") ||
        "(no matching datasheet chunks found)"
      return textResult(`${notes.length ? `${notes.join("\n\n")}\n\n` : ""}${body}`, {
        action: "search",
        apiVersion: "v2",
        chip: wanted,
        rev,
        topK: k,
        ...(keywords ? { keywords } : {}),
        hits: result.hits.map(hitSummaryV2),
        ...(result.scopeResolved
          ? {
              scope: {
                targets: result.scopeResolved.targets,
                docs: result.scopeResolved.docs,
                ladder: result.scopeResolved.ladder,
                fields: result.scopeResolved.fields,
              },
            }
          : {}),
        ...(result.degraded.length ? { degraded: result.degraded } : {}),
        ...(result.generation === undefined ? {} : { generation: result.generation }),
      })
    }

    /**
     * v2 chips:/api/v2/docs 的文档列表。按 legacy_chip 分家族;`chip` 给了就列那一族的手册。
     * 服务端在列表里带 `target_resolved`(target= 的解析结果),优先用它判断"解析到了哪一族";
     * 零文档时补一枪 targets/resolve 只为拿候选 —— 它是辅助路径,失败不能挡住主答案。
     */
    const chipsFromDocs = async (
      rawDocs: V2DocMeta[],
      asked: string | undefined,
      targetResolved?: V2TargetResolved,
    ): Promise<Result> => {
      const docs = uniqueDocs(rawDocs)
      if (!docs.length) {
        if (asked) {
          const resolvedFromDocs = targetResolved?.matched
            ? ` The server resolved it to: ${targetResolved.matched}.`
            : ""
          const resolution = targetResolved?.matched ? undefined : await client.resolveTargetQuietly(asked)
          const resolved =
            resolvedFromDocs ||
            (resolution?.ok && resolution.resolved.length
              ? ` The server resolved it to: ${resolution.resolved.join(", ")}.`
              : "")
          const candidates =
            resolution?.ok && resolution.candidates.length
              ? `\nCandidates: ${formatCandidateList(resolution.candidates)}`
              : ""
          return textResult(
            `No indexed documents matched chip "${asked}".${resolved}${candidates}\n` +
              `Use action "chips" without \`chip\` to list every indexed family, or retry search with one of the candidates.`,
            { action: "chips", apiVersion: "v2", chip: asked, families: 0, manuals: 0 },
          )
        }
        return textResult(
          `The datasheet server returned no documents (the v2 index may be empty). read_section and view_figure still work for known artifact paths.`,
          { action: "chips", apiVersion: "v2", families: 0, manuals: 0 },
        )
      }
      if (asked) {
        const families = [...new Set(docs.map(docFamily))]
        const family = families.length === 1 ? families[0]! : targetResolved?.matched || asked
        const from = normChip(family) !== normChip(asked) ? ` (resolved from "${asked}")` : ""
        const span =
          families.length > 1 ? `\nNOTE: the returned documents span several families: ${families.join(", ")}.` : ""
        if (normChip(family) === GENERAL_CHIP) {
          return textResult(
            `"${family}" is the shared cross-chip bucket (${docs.length} manual(s): Cortex-M core programming manuals, schematic conventions, tutorials). ` +
              `It is folded into v2 searches automatically — search your chip's own family, not GENERAL.\n${formatV2FamilyManuals(docs)}${span}`,
            { action: "chips", apiVersion: "v2", chip: family, manuals: docs.length },
          )
        }
        return textResult(
          `chip "${family}"${from} — ${docs.length} manual(s) indexed:\n${formatV2FamilyManuals(docs)}${span}\n\n` +
            `Search it with { action: "search", chip: "${family}", query: … }, optionally \`rev\` set to one of the above.`,
          { action: "chips", apiVersion: "v2", chip: family, manuals: docs.length },
        )
      }
      const groups = groupDocsByFamily(docs)
      return textResult(
        `${groups.size} indexed chip families, ${docs.length} manuals. ` +
          `The number in parentheses is that family's manual count; pass \`chip\` to list one family's manuals (each with the \`rev\` to search it by).\n\n${formatV2ChipList(groups)}`,
        { action: "chips", apiVersion: "v2", families: groups.size, manuals: docs.length },
      )
    }

    try {
      switch (params.action) {
        case "search": {
          const query = need(params.query, "search", "query")
          const wanted = need(params.chip, "search", "chip")
          const rev = params.rev?.trim() || undefined
          const keywords = params.keywords?.trim() || undefined
          const k = clamp(params.topK, DEFAULT_TOP_K, 1, MAX_TOP_K)

          if (apiVersion === "v1") {
            return withApiNote(
              await searchV1(query, wanted, rev, k),
              keywords ? V1_KEYWORDS_NOTE : undefined,
              keywords ? { keywords } : {},
            )
          }

          const outcome = await client.searchV2({ query, keywords, chip: wanted, rev, topK: k })
          if (outcome.ok) return answerV2(outcome.result, wanted, rev, k, keywords)

          if (outcome.unavailable && apiVersion === "auto") {
            // 只在明确 404/405 上回落 —— 422/429/503 不进这里(见文件头)。
            let legacy: Result
            try {
              legacy = await searchV1(query, wanted, rev, k)
            } catch (error) {
              if (!isUnreachable(error)) throw error
              return textResult(`${v1FallbackNote(outcome.status, "search")}\n\n${error.message}`, {
                action: "search",
                apiVersion: "v1",
                fallback: "v2-missing",
                chip: wanted,
                rev,
                topK: k,
              })
            }
            return withApiNote(legacy, v1FallbackNote(outcome.status, "search"), {
              fallback: "v2-missing",
              ...(keywords ? { keywords } : {}),
            })
          }

          const forced =
            outcome.unavailable && apiVersion === "v2"
              ? `\n\nNo v1 fallback was attempted because apiVersion=v2 was selected explicitly. Set ${DATASHEET_API_ENV}=auto to allow the legacy path.`
              : ""
          return textResult(outcome.message + forced, {
            action: "search",
            apiVersion: "v2",
            chip: wanted,
            rev,
            topK: k,
            ...(keywords ? { keywords } : {}),
            ...(outcome.code ? { errorCode: outcome.code } : {}),
            ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
          })
        }

        case "chips": {
          const asked = params.chip?.trim() || undefined
          // `return await` 是承重的:直接 `return chipsV1(...)` 时那个 promise 的拒绝发生在 try/catch
          // 之外,内核抛出的 DatasheetUnreachableError 会变成一条 unhandled rejection(测试里表现为
          // 整个用例失败,而回复其实什么都没返回)。
          if (apiVersion === "v1") return await chipsV1(asked)

          const outcome = await client.listDocs(asked ? { target: asked } : {})
          if (outcome.ok) return await chipsFromDocs(outcome.docs, asked, outcome.targetResolved)

          if (outcome.unavailable && apiVersion === "auto") {
            let legacy: Result
            try {
              legacy = await chipsV1(asked)
            } catch (error) {
              if (!isUnreachable(error)) throw error
              return textResult(`${v1FallbackNote(outcome.status, "chips")}\n\n${error.message}`, {
                action: "chips",
                apiVersion: "v1",
                fallback: "v2-missing",
                chip: asked,
              })
            }
            return withApiNote(legacy, v1FallbackNote(outcome.status, "chips"), { fallback: "v2-missing" })
          }

          if (outcome.code === "scope_unresolved") {
            const details = [
              outcome.serverMessage ? `Message: ${outcome.serverMessage}` : "",
              outcome.hint ? `Hint: ${outcome.hint}` : "",
            ]
              .filter(Boolean)
              .join("\n")
            const candidates = outcome.candidates?.length
              ? `\nCandidates: ${formatCandidateList(outcome.candidates)}`
              : ""
            return textResult(
              `The datasheet server could not resolve chip "${asked ?? ""}" (HTTP ${outcome.status} scope_unresolved).` +
                (details ? `\n${details}` : "") +
                candidates +
                `\nUse action "chips" without \`chip\` to list every indexed family, or retry with one of the candidates.`,
              {
                action: "chips",
                apiVersion: "v2",
                chip: asked,
                errorCode: outcome.code,
                candidates: outcome.candidates,
              },
            )
          }

          const forced =
            outcome.unavailable && apiVersion === "v2"
              ? `\n\nNo v1 fallback was attempted because apiVersion=v2 was selected explicitly. Set ${DATASHEET_API_ENV}=auto to allow the legacy path.`
              : ""
          return textResult(outcome.message + forced, {
            action: "chips",
            apiVersion: "v2",
            chip: asked,
            ...(outcome.code ? { errorCode: outcome.code } : {}),
            ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
          })
        }

        case "read_section": {
          const rel = need(params.parsedPath, "read_section", "parsedPath")
          const problem = artifactPathProblem(rel)
          if (problem) {
            return textResult(`Not a parsed_path: ${problem}. Pass the "source:" path from a search hit verbatim.`, {
              action: "read_section",
              parsedPath: rel,
            })
          }
          const cap = clamp(params.maxChars, DEFAULT_MAX_CHARS, MIN_MAX_CHARS, MAX_MAX_CHARS)
          const res = await client.fetchArtifact(rel)
          if (res.status === 404) {
            return textResult(
              `Parsed manual not on the server: ${rel} (HTTP 404). The manual may not be ingested with parsed ` +
                `artifacts — rely on search chunks and cite those.`,
              { action: "read_section", parsedPath: rel },
            )
          }
          if (!res.ok) {
            return textResult(
              `Could not read ${rel} from the datasheet server at ${server}: HTTP ${res.status} ${res.statusText}. Rely on search chunks and cite those.`,
              { action: "read_section", parsedPath: rel },
            )
          }
          const raw = await client.text(res)
          const lines = raw.split("\n")
          const headings = parseHeadings(lines)
          const toc = (intro: string, extra: Partial<DatasheetDetails>): Result => {
            const table = tableOfContents(headings, 300)
            const { out, truncated } = capped(table, cap)
            return textResult(`${intro}\n\n# Sections\n${out}`, {
              action: "read_section",
              parsedPath: rel,
              mode: "toc",
              sections: headings.length,
              chars: table.length,
              truncated,
              ...extra,
            })
          }

          if (!params.heading || !params.heading.trim()) {
            if (raw.length <= cap) {
              return textResult(raw, {
                action: "read_section",
                parsedPath: rel,
                mode: "full",
                chars: raw.length,
                sections: headings.length,
              })
            }
            return toc(
              `(${(raw.length / 1024).toFixed(0)} KB parsed manual; pass \`heading\` to read one section.)`,
              {},
            )
          }

          const wanted = lastSegment(params.heading)
          const idx = matchHeading(headings, wanted)
          if (idx < 0) {
            // 没有匹配的标题 —— 退回围绕短语本身的文本窗口
            const at = findPhrase(raw, wanted)
            if (at >= 0) {
              const start = Math.max(0, at - Math.floor(cap / 4))
              const { out, truncated } = capped(raw.slice(start), cap)
              return textResult(`(No exact section heading for "${wanted}"; showing a text window.)\n\n${out}`, {
                action: "read_section",
                parsedPath: rel,
                mode: "window",
                heading: wanted,
                chars: truncated ? cap : out.length,
                truncated,
              })
            }
            return toc(`No section heading or text matched "${wanted}" in ${rel}. Available sections:`, {
              heading: wanted,
            })
          }

          const matched = headings[idx]!
          const [startLine, endLine] = sectionRange(headings, idx, lines.length)
          const section = lines.slice(startLine, endLine).join("\n").trim()
          const { out, truncated } = capped(section, cap)
          // 不是逐字命中的标题要说出来:模型要的是"25.4.1 TIM6&TIM7 …",给它的若是别的节,它得看得见。
          const closest =
            norm(matched.title) === norm(wanted) ? "" : `(Closest heading to "${wanted}": "${matched.title}")\n\n`
          return textResult(closest + out, {
            action: "read_section",
            parsedPath: rel,
            mode: "section",
            heading: matched.title,
            level: matched.level,
            lines: [startLine + 1, endLine],
            chars: section.length,
            truncated,
          })
        }

        case "view_figure": {
          const rel = need(params.imagePath, "view_figure", "imagePath")
          const problem = artifactPathProblem(rel)
          if (problem) {
            return textResult(`Not an image_path: ${problem}. Pass the "figure:" path from a [FIGURE] hit verbatim.`, {
              action: "view_figure",
              imagePath: rel,
            })
          }
          const mime = figureMime(rel)
          if (!mime) {
            return textResult(
              `Not a supported figure image path: ${rel} — expected a .png/.jpg/.gif/.webp image_path from a [FIGURE] hit.`,
              { action: "view_figure", imagePath: rel },
            )
          }
          const res = await client.fetchArtifact(rel)
          if (res.status === 404) {
            return textResult(
              `Figure not on the server: ${rel} (HTTP 404). Rely on the search prose chunks and cite those.`,
              { action: "view_figure", imagePath: rel },
            )
          }
          if (!res.ok) {
            return textResult(
              `Could not read ${rel} from the datasheet server at ${server}: HTTP ${res.status} ${res.statusText}. Rely on the search prose chunks and cite those.`,
              { action: "view_figure", imagePath: rel },
            )
          }
          const declared = Number(res.headers.get("content-length"))
          if (Number.isFinite(declared) && declared > MAX_FIGURE_BYTES) {
            return textResult(`Figure ${rel} is ${mib(declared)} (cap ${mib(MAX_FIGURE_BYTES)}); not downloading it.`, {
              action: "view_figure",
              imagePath: rel,
              bytes: declared,
            })
          }
          const bytes = await client.bytes(res)
          if (bytes.byteLength > MAX_FIGURE_BYTES) {
            return textResult(
              `Figure ${rel} is ${mib(bytes.byteLength)} (cap ${mib(MAX_FIGURE_BYTES)}); not attaching.`,
              {
                action: "view_figure",
                imagePath: rel,
                bytes: bytes.byteLength,
              },
            )
          }
          // 与 read 工具读到的图片同一道:大图压到供应商内嵌上限以内,缩过了给模型一句比例说明。
          const processed = await processImage(bytes, mime)
          if (!processed.ok) {
            return textResult(`Figure ${rel} could not be attached: ${processed.message}`, {
              action: "view_figure",
              imagePath: rel,
              bytes: bytes.byteLength,
            })
          }
          const caption = params.caption?.trim()
          const lines = [
            caption ? `Figure (attached below): ${caption}` : `Figure ${rel} (attached below).`,
            ...processed.hints,
          ]
          return {
            content: [
              { type: "text", text: lines.join("\n") },
              { type: "image", data: processed.data, mimeType: processed.mimeType },
            ],
            details: { action: "view_figure", imagePath: rel, mime: processed.mimeType, bytes: bytes.byteLength },
          }
        }
      }
    } catch (error) {
      if (isUnreachable(error)) return textResult(error.message, { action: params.action })
      throw error
    }
  }

  return {
    name: DATASHEET_CONTRACT.name,
    label: DATASHEET_CONTRACT.label,
    description: DATASHEET_CONTRACT.description,
    parameters: DATASHEET_CONTRACT.parameters,
    execute: (_toolCallId, params, _onUpdate, toolContext, _invocation, context) =>
      run(params, context.abortSignal, options.env ?? executionEnvSnapshot(toolContext.env)),
  }
}
