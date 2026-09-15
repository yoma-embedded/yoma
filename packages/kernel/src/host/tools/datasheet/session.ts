/**
 * datasheet 工具的厨房那一半:四个动作 → 数据手册服务器 → 人话。
 *
 * 【架构】完全在线、零本地状态:检索、解析文本、图片全部按需从服务器读。客户端不落索引、不落产物、不需要
 * embedding key —— 那些都是服务器的事,本机唯一的配置是地址(`host/datasheet-server.ts`,内置默认 =
 * 维护者的公共服务器,`~/.yoma/.env` 或环境变量覆盖,off 关闭)。
 *
 * - search:       POST {server}/api/search  { query, chip, rev?, top_k } → { hits }
 * - read_section: GET  {server}/artifacts/<parsed_path> + 本机 markdown 章节抽取(domain/datasheet/section.ts)
 * - view_figure:  GET  {server}/artifacts/<image_path> → 过 domain/image 压到供应商内嵌上限以内 → ImageContent
 * - chips:        GET  {server}/api/manifest → 家族 / 手册 / 分卷 / 封面型号
 *
 * search 自己兜住四件服务器不兜的事(教训都在 domain/datasheet/chips.ts 文件头):
 * 1. chip 是型号不是家族名时,服务器不报错、回一堆 GENERAL 噪声 —— 一条目标家族的命中都没有就拉 manifest
 *    把型号解析成家族名重查;解析不出来就**明说不认识**并给候选,绝不让 GENERAL 冒充答案。manifest 也拉不到时
 *    照样要说"这是一次落空",不能把 GENERAL 原样递出去。
 * 2. rev 是分卷手册的基名(`RM0390`)时服务器一条都不回 —— 解析成全部卷。先打一枪家族范围(20 条)看目标卷
 *    的命中够不够;不够才每卷各搜一次再按分数合并(服务器对每个请求都重新做一次 embedding,10 卷并发实测
 *    比一枪慢 6 倍,所以能一枪解决的不扇出)。
 * 3. 家族确实收录了、前 k 条却全是 GENERAL(Cortex-M 内核手册在泛问题上分数高)—— 放宽到服务器上限 20 条
 *    把本家族的挖出来,本家排前、剩下的位子给 GENERAL,总数不超过 k;说明有几条 GENERAL 压过了本家最好的一条。
 * 4. 精确的 chip + rev 一条都没中:说清楚"这本在、但没匹配",而不是一句空的 "(no matching …)"。
 *
 * 【没有队列】四个动作都只读、无状态,并行没有任何冲突;芯片索引缓存自己单飞(client.ts)。
 * 【没有 dispose】不起进程、不占设备;在飞的请求由每次调用的 abortSignal 收。
 */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import { datasheetEnvFile, resolveDatasheetServer } from "../../datasheet-server.ts"
import {
  artifactPathProblem,
  capped,
  type ChipFamily,
  chipCandidatesNote,
  chipMissNote,
  coveringNote,
  figureMime,
  findPhrase,
  formatChipList,
  formatCitation,
  formatFamilyManuals,
  GENERAL_CHIP,
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
  unknownChipHelp,
  validName,
} from "../../domain/datasheet/index.ts"
import { clamp } from "../../domain/engines.ts"
import { processImage } from "../../domain/image/process.ts"
import { createDatasheetClient, isUnreachable, noServerHelp, type SearchOutcome } from "./client.ts"
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

/** 这本在、rev 也对,就是这次查询没中。 */
function pinnedMissNote(family: ChipFamily, rev: string): string {
  return (
    `NOTE: chip "${family.chip}" is indexed and rev "${rev}" exists, but nothing in that manual matched this query — ` +
    `rephrase with the peripheral/register name, or drop \`rev\` to search the whole family (${manualCountLine(family)}).`
  )
}

export function createDatasheetTool(options: DatasheetToolOptions = {}): DatasheetTool {
  const run = async (params: DatasheetInput, signal: AbortSignal | undefined): Promise<Result> => {
    const configuration = resolveDatasheetServer({
      explicit: options?.server,
      env: options?.env,
      configDir: options?.configDir,
      builtIn: options?.builtIn,
    })
    const server = configuration.url
    if (!server) {
      return textResult(noServerHelp(datasheetEnvFile({ env: options.env, configDir: options.configDir })), {
        action: params.action,
      })
    }
    const client = createDatasheetClient(server, {
      configuration,
      timeoutMs: options.timeoutMs,
      artifactTimeoutMs: options.artifactTimeoutMs,
      signal,
    })

    try {
      switch (params.action) {
        case "search": {
          const query = need(params.query, "search", "query")
          const wanted = need(params.chip, "search", "chip")
          const rev = params.rev?.trim() || undefined
          const k = clamp(params.topK, DEFAULT_TOP_K, 1, MAX_TOP_K)

          const post = (chip: string, pin: string | undefined, topK = k) => client.search(query, chip, pin, topK)
          const failed = (outcome: SearchOutcome, chip: string): Result | undefined =>
            "failed" in outcome ? textResult(outcome.failed, { action: "search", chip, rev, topK: k }) : undefined
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
            return textResult(unknownChipHelp(wanted, resolution), { action: "search", chip: wanted, rev, topK: k })
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

        case "chips": {
          const index = await client.chipIndex()
          if (!index) {
            return textResult(
              `The datasheet server at ${server} does not expose GET /api/manifest (or it is empty), so the indexed chip list cannot be read. ` +
                `Pass \`chip\` as the device family (not the part number) and search directly.`,
              { action: "chips" },
            )
          }
          const asked = params.chip?.trim()
          if (asked) {
            const resolution = resolveChip(index, asked)
            if (resolution.kind === "exact" || resolution.kind === "family") {
              const family = index.get(normChip(resolution.chip))!
              const details: DatasheetDetails = { action: "chips", chip: family.chip, manuals: manualCount(family) }
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
            { action: "chips", families: index.size, manuals: docs },
          )
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
    execute: (_toolCallId, params, _onUpdate, _toolContext, _invocation, context) => run(params, context.abortSignal),
  }
}
