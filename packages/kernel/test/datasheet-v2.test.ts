/**
 * v2 检索接口的纯函数层(host/domain/datasheet/v2.ts):请求体、响应解码、错误体、给模型的话、
 * /api/v2/docs 的分组与渲染。不碰网络;有网络的那一半在 tools-datasheet-v2.test.ts。
 *
 * 服务端 M2 的实现由另一个会话进行,这些用例钉的是**客户端承诺的契约**:
 * - chip / rev 原样进 scope,不做任何家族推断;
 * - 响应缺字段 / 换了包裹层时仍能解码;
 * - 422 的候选、degraded、scope_resolved 都要原样到模型手里;
 * - score 不在客户端排序、不跨请求合并。
 */

import { describe, expect, it } from "vitest"

import {
  asStringArray,
  buildV2SearchBody,
  docFamily,
  docRev,
  formatCandidateList,
  formatDegraded,
  formatScopeResolved,
  formatV2Citation,
  formatV2ChipList,
  formatV2FamilyManuals,
  groupDocsByFamily,
  hitsAreAllGeneral,
  isScopeUnresolved,
  normalizeDocsResponse,
  normalizeResolveResponse,
  normalizeScopeResolved,
  normalizeV2Doc,
  normalizeV2Hit,
  normalizeV2SearchResponse,
  parseV2Error,
  uniqueDocs,
} from "../src/host/domain/datasheet/index.ts"

const doc = (over: Record<string, unknown> = {}) => ({
  doc_uid: "st-rm0090",
  doc_id: "RM0090",
  doc_rev: "Rev 9",
  title: "STM32F4 reference manual",
  doc_type: "rm",
  vendor: "st",
  targets: ["stm32f4", "stm32"],
  legacy_chip: "STM32F4",
  legacy_name: "RM0090 (1–400)",
  ...over,
})

const chunk = (over: Record<string, unknown> = {}) => ({
  id: "chunk-1",
  kind: "text",
  page: 985,
  section_id: "30.6.3",
  heading_path: "30 USART > 30.6.3 Baud rate register (USART_BRR)",
  text: "USARTDIV is programmed into USART_BRR.",
  shard: "RM0090_p801-1200",
  legacy_rev: "RM0090_p801-1200",
  ordinal: 3,
  text_truncated: false,
  ...over,
})

const v2Hit = (over: Record<string, unknown> = {}) => ({
  rank: 1,
  doc: doc(),
  chunk: chunk(),
  score: 0.92,
  reasons: ["芯片匹配 stm32f4", "向量第 2、关键词第 1", "重排第 1"],
  links: { parsed_path: "parsed/STM32F4/RM0090_p801-1200.md", image_path: "" },
  ...over,
})

describe("v2 request body", () => {
  it("puts the model's chip and rev into scope verbatim (no client-side family inference)", () => {
    expect(
      buildV2SearchBody({
        query: "USART 波特率分频怎么算",
        keywords: "USART baud rate USARTDIV BRR mantissa fraction",
        chip: "STM32F407VG",
        rev: "RM0090",
        topK: 6,
      }),
    ).toEqual({
      query: "USART 波特率分频怎么算",
      keywords: "USART baud rate USARTDIV BRR mantissa fraction",
      scope: { targets: ["STM32F407VG"], docs: ["RM0090"], doc_types: [] },
      top_k: 6,
      detail: "concise",
    })
  })

  it("omits empty keywords and empty docs, and does not invent GENERAL or a family name", () => {
    const body = buildV2SearchBody({ query: "q", keywords: "   ", chip: "AT32F421C8T7", topK: 3 })
    expect(body).toEqual({
      query: "q",
      scope: { targets: ["AT32F421C8T7"], docs: [], doc_types: [] },
      top_k: 3,
      detail: "concise",
    })
    expect(body).not.toHaveProperty("keywords")
  })

  it("keeps an explicit detail value", () => {
    expect(buildV2SearchBody({ query: "q", chip: "STM32F4", topK: 1, detail: "full" })).toMatchObject({
      detail: "full",
    })
  })
})

describe("v2 search response decoding", () => {
  it("maps doc / chunk / links onto the tool's existing citation fields without reordering", () => {
    const result = normalizeV2SearchResponse({
      hits: [
        v2Hit({
          rank: 2,
          score: 0.7,
          doc: doc({ doc_uid: "st-rm0386", doc_id: "RM0386", legacy_chip: "STM32F4", legacy_name: "RM0386" }),
          chunk: chunk({ page: 10, heading_path: "1 Overview", text: "second" }),
          links: { parsed_path: "parsed/STM32F4/RM0386.md", image_path: "figures/F1.png" },
        }),
        v2Hit({ rank: 1, score: 0.92, chunk: chunk({ text: "first" }) }),
      ],
      scope_resolved: {
        targets: ["stm32f407", "stm32f4", "stm32"],
        ladder: "family",
        matched: ["stm32f407"],
        vendors: ["st"],
      },
      degraded: ["rerank"],
      generation: 2,
    })
    expect(result.hits.map((hit) => hit.text)).toEqual(["second", "first"]) // 服务端顺序原样保留
    expect(result.hits[0]).toMatchObject({
      rank: 2,
      manual_name: "RM0386",
      chip: "STM32F4",
      rev: "RM0386",
      page: 10,
      headings: "1 Overview",
      score: 0.7,
      kind: "text",
      source_pdf: "",
      parsed_path: "parsed/STM32F4/RM0386.md",
      image_path: "figures/F1.png",
      reasons: ["芯片匹配 stm32f4", "向量第 2、关键词第 1", "重排第 1"],
    })
    expect(result.hits[0]!.doc).toMatchObject({ doc_uid: "st-rm0386", doc_id: "RM0386", targets: ["stm32f4", "stm32"] })
    expect(result.hits[0]!.chunk.legacy_rev).toBe("RM0090_p801-1200")
    expect(result.scopeResolved).toEqual({
      targets: ["stm32f407", "stm32f4", "stm32"],
      docs: [],
      ladder: "family",
      fields: { matched: ["stm32f407"], vendors: ["st"] },
    })
    expect(result.degraded).toEqual(["rerank"])
    expect(result.generation).toBe(2)
  })

  it("uses doc_id as the rev to pass back, falling back to the legacy part name only when the doc has no id", () => {
    const withId = normalizeV2Hit(v2Hit(), 0)!
    expect(withId.rev).toBe("RM0090")
    const withoutId = normalizeV2Hit(
      v2Hit({ doc: doc({ doc_id: "", title: "T", legacy_name: "" }), chunk: chunk({ legacy_rev: "RM0090_p401-800" }) }),
      0,
    )!
    expect(withoutId.rev).toBe("RM0090_p401-800")
    expect(withoutId.manual_name).toBe("T")
  })

  it("keeps usable hits with missing doc / chunk fields and skips non-objects", () => {
    const result = normalizeV2SearchResponse({
      hits: [
        "not an object",
        { score: "0.4", chunk: { text: "only text", page: "7" }, links: {} },
        { doc: null, chunk: null, links: null, score: null },
      ],
    })
    expect(result.hits).toHaveLength(2)
    expect(result.hits[0]).toMatchObject({ text: "only text", page: 7, score: 0.4, rank: 2, manual_name: "", chip: "" })
    expect(result.hits[0]!.reasons).toEqual([])
    expect(result.hits[1]).toMatchObject({ text: "", score: 0, rank: 3 })
    expect(result.scopeResolved).toBeUndefined()
    expect(result.degraded).toEqual([])
  })

  it("accepts camelCase scopeResolved, a string degraded reason, and missing hits", () => {
    const result = normalizeV2SearchResponse({
      scopeResolved: { targets: "stm32f4", ladder: "target", note: "kept" },
      degraded: "rerank",
    })
    expect(result.hits).toEqual([])
    expect(result.scopeResolved).toEqual({ targets: ["stm32f4"], docs: [], ladder: "target", fields: { note: "kept" } })
    expect(result.degraded).toEqual(["rerank"])
    expect(normalizeV2SearchResponse(null).hits).toEqual([])
  })

  it("accepts a data-wrapped search response", () => {
    const result = normalizeV2SearchResponse({
      data: {
        hits: [v2Hit()],
        scope_resolved: { targets: ["stm32f4"] },
        degraded: ["dense"],
        generation: 3,
      },
    })
    expect(result.hits).toHaveLength(1)
    expect(result.scopeResolved?.targets).toEqual(["stm32f4"])
    expect(result.degraded).toEqual(["dense"])
    expect(result.generation).toBe(3)
  })

  it("drops an empty scope object instead of printing an empty scope line", () => {
    expect(normalizeScopeResolved({})).toBeUndefined()
    expect(normalizeScopeResolved(null)).toBeUndefined()
  })
})

describe("v2 error body decoding", () => {
  it("reads the real V2Error.scopeUnresolved shape: error object + top-level candidates keyed by code", () => {
    const error = parseV2Error(
      422,
      JSON.stringify({
        error: {
          code: "scope_unresolved",
          message: "认不出型号「STM99」对应的词表项，因此没有检索",
          hint: "改用词表里的编号（例：STM32F4、AT32F421、GD32F303）或文档号（RM0090 这类走 scope.docs）",
        },
        candidates: [
          {
            code: "stm32",
            level: "series",
            vendor: "st",
            title: "STM32 series",
            pattern: "stm32",
            matched_by: "candidate",
            ancestors: [],
          },
          {
            code: "gd32",
            level: "series",
            vendor: "geehy",
            title: "GD32 series",
            pattern: "gd32",
            matched_by: "candidate",
            ancestors: [],
          },
        ],
        unresolved: ["STM99"],
      }),
    )
    expect(error).toMatchObject({
      code: "scope_unresolved",
      message: "认不出型号「STM99」对应的词表项，因此没有检索",
      hint: "改用词表里的编号（例：STM32F4、AT32F421、GD32F303）或文档号（RM0090 这类走 scope.docs）",
      candidates: ["stm32", "gd32"],
    })
    expect(isScopeUnresolved(error)).toBe(true)
  })

  it("extracts candidate.code from objects at the top level and nested in error.details", () => {
    expect(
      parseV2Error(
        422,
        JSON.stringify({
          error: { code: "scope_unresolved", details: { candidates: [{ code: "stm32f4" }, { code: "STM32F1" }] } },
          candidates: [{ code: "STM32F4" }],
        }),
      ).candidates,
    ).toEqual(["STM32F4", "stm32f4", "STM32F1"])
    expect(
      parseV2Error(422, JSON.stringify({ candidates: [{ code: "A" }, { code: "A" }, { code: "B" }] })).candidates,
    ).toEqual(["A", "B"])
    expect(asStringArray([{ code: "stm32f4" }, { target: "stm32f1" }, { name: "gd32" }])).toEqual([
      "stm32f4",
      "stm32f1",
      "gd32",
    ])
  })

  it("falls back to a v1-style detail body and to raw text without throwing", () => {
    const detail = parseV2Error(422, JSON.stringify({ detail: "query and chip are required" }))
    expect(detail.message).toBe("query and chip are required")
    expect(detail.code).toBe("")
    expect(detail.detail).toContain("query and chip")
    expect(parseV2Error(503, "upstream exploded").message).toBe("")
    expect(parseV2Error(503, "upstream exploded").detail).toBe("upstream exploded")
    expect(parseV2Error(503, "").detail).toBe("")
  })

  it("parses the full body before truncating the detail, so a long candidate list is not lost", () => {
    const candidates = Array.from({ length: 60 }, (_, i) => `STM32F${i.toString().padStart(3, "0")}-${"X".repeat(30)}`)
    const body = JSON.stringify({ error: { code: "scope_unresolved", message: "no target", candidates } })
    expect(body.length).toBeGreaterThan(2000)
    const error = parseV2Error(422, body)
    expect(error.code).toBe("scope_unresolved")
    expect(error.candidates).toEqual(candidates)
    expect(error.detail.length).toBe(2000)
  })

  it("recognizes scope_unresolved by message when the code is missing", () => {
    expect(isScopeUnresolved(parseV2Error(422, JSON.stringify({ error: { message: "scope_unresolved: nope" } })))).toBe(
      true,
    )
    expect(isScopeUnresolved(parseV2Error(422, JSON.stringify({ error: { code: "invalid_request" } })))).toBe(false)
  })
})

describe("v2 formatting for the model", () => {
  it("states the actual scope and keeps unknown fields", () => {
    const text = formatScopeResolved({
      targets: ["stm32f407", "stm32f4"],
      docs: ["RM0090"],
      ladder: "family",
      fields: { vendor: "st", warnings: ["metadata missing"] },
    })
    expect(text).toContain("targets: stm32f407, stm32f4")
    expect(text).toContain("docs: RM0090")
    expect(text).toContain("ladder: family")
    expect(text).toContain("vendor: st")
    expect(text).toContain("warnings: metadata missing")
    expect(text).toContain("authoritative scope")
    expect(formatScopeResolved(undefined)).toBe("")
  })

  it("explains known degradations (including ident) and passes unknown ones through", () => {
    const text = formatDegraded(["rerank", "dense", "ident", "mystery", "rerank"])
    expect(text).toContain("rerank (reranking was unavailable")
    expect(text).toContain("dense (vector (dense) retrieval was unavailable")
    expect(text).toContain("ident (identifier (exact register / model name) retrieval was unavailable")
    expect(text).toContain("mystery")
    expect(text.match(/rerank \(/g)).toHaveLength(1) // 去重
    expect(formatDegraded([])).toBe("")
  })

  it("appends the server's reasons to the normal citation", () => {
    const hit = normalizeV2Hit(v2Hit(), 0)!
    const text = formatV2Citation(hit, 0)
    expect(text).toContain("[#1] RM0090 (1–400) (STM32F4) p.985")
    expect(text).toContain("USARTDIV is programmed")
    expect(text).toContain("source: parsed/STM32F4/RM0090_p801-1200.md")
    expect(text).toContain("why: 芯片匹配 stm32f4; 向量第 2、关键词第 1; 重排第 1")
    expect(text).not.toContain("server truncated this chunk")
    expect(formatV2Citation(normalizeV2Hit(v2Hit({ reasons: [] }), 0)!, 0)).not.toContain("why:")
  })

  it("surfaces chunk.text_truncated so the model knows to read the full section", () => {
    const hit = normalizeV2Hit(v2Hit({ chunk: chunk({ text_truncated: true }) }), 0)!
    expect(hit.chunk.text_truncated).toBe(true)
    expect(formatV2Citation(hit, 0)).toContain("server truncated this chunk")
    expect(formatV2Citation(hit, 0)).toContain('action "read_section" for the full section')
  })

  it("only calls every hit GENERAL when the server explicitly says GENERAL", () => {
    const general = normalizeV2Hit(v2Hit({ doc: doc({ legacy_chip: "GENERAL", targets: ["general"] }) }), 0)!
    expect(hitsAreAllGeneral([general])).toBe(true)
    const byTarget = normalizeV2Hit(v2Hit({ doc: doc({ legacy_chip: "", targets: ["general"] }) }), 0)!
    expect(hitsAreAllGeneral([byTarget])).toBe(true)
    const normal = normalizeV2Hit(v2Hit({ doc: doc({ legacy_chip: "", targets: ["stm32f4"] }) }), 0)!
    expect(hitsAreAllGeneral([normal])).toBe(false)
    const blank = normalizeV2Hit(v2Hit({ doc: doc({ legacy_chip: "", targets: [], legacy_name: "" }) }), 0)!
    expect(blank.chip).toBe("")
    expect(hitsAreAllGeneral([blank])).toBe(false) // 空 chip 不能冒充 GENERAL
    expect(hitsAreAllGeneral([])).toBe(false)
  })

  it("caps a candidate list and says how many were left out", () => {
    expect(formatCandidateList([], 3)).toBe("")
    expect(formatCandidateList(["A", "B"], 3)).toBe("A, B")
    expect(formatCandidateList(["A", "B", "C", "D"], 3)).toBe('A, B, C (+1 more — action "chips" lists all)')
  })
})

describe("v2 docs (chips)", () => {
  const d1 = normalizeV2Doc(doc())!
  const d2 = normalizeV2Doc(
    doc({ doc_uid: "st-rm0386", doc_id: "RM0386", legacy_chip: "STM32F4", legacy_name: "RM0386" }),
  )!
  const d3 = normalizeV2Doc(
    doc({ doc_uid: "gen-1", doc_id: "PM0214", legacy_chip: "GENERAL", targets: ["general"], legacy_name: "Cortex-M4" }),
  )!
  const d4 = normalizeV2Doc(
    doc({ doc_uid: "no-legacy", doc_id: "X1", legacy_chip: "", targets: ["mm32"], legacy_name: "MM32" }),
  )!

  it("decodes array / docs / items / nested data wrappers and skips junk", () => {
    expect(normalizeDocsResponse([doc(), null, "x"]).docs).toHaveLength(1)
    expect(normalizeDocsResponse({ docs: [doc()], total: 12 })).toMatchObject({ total: 12 })
    expect(normalizeDocsResponse({ items: [doc()] }).docs).toHaveLength(1)
    expect(normalizeDocsResponse({ data: { docs: [doc()], total: 3 } })).toMatchObject({ total: 3 })
    expect(normalizeDocsResponse({ docs: [] })).toEqual({ docs: [] })
    expect(normalizeV2Doc({})).toBeUndefined()
    expect(normalizeV2Doc({ title: "only a title" })).toMatchObject({ title: "only a title", targets: [] })
  })

  it("groups by legacy_chip, then first target, then UNFILED; doc_id is the searchable rev", () => {
    expect(docFamily(d1)).toBe("STM32F4")
    expect(docFamily(d4)).toBe("mm32")
    expect(docFamily(normalizeV2Doc({ doc_uid: "u" })!)).toBe("UNFILED")
    expect(docRev(d1)).toBe("RM0090")
    expect(docRev(normalizeV2Doc({ doc_uid: "u", doc_id: "" })!)).toBe("u")

    const groups = groupDocsByFamily([d1, d2, d3, d4])
    expect([...groups.keys()].sort()).toEqual(["GENERAL", "STM32F4", "mm32"])
    expect(groups.get("STM32F4")!.map(docRev)).toEqual(["RM0090", "RM0386"])
    expect(formatV2ChipList(groups)).toBe(
      "GENERAL (1, shared cross-chip bucket — folded into every search automatically), mm32 (1), STM32F4 (2)",
    )
  })

  it("dedupes documents and renders rev / type / revision for the model", () => {
    expect(uniqueDocs([d1, d1, d2]).map(docRev)).toEqual(["RM0090", "RM0386"])
    const rows = formatV2FamilyManuals([d1, d2], 1)
    expect(rows).toContain('rev "RM0090" [rm] — RM0090 (1–400) (revision Rev 9)')
    expect(rows).toContain("(+1 more)")
    expect(formatV2FamilyManuals([normalizeV2Doc({ doc_uid: "u" })!])).toContain('rev "u" — (untitled)')
  })

  it("decodes the real /api/v2/docs wrapper: docs + total + generation + target_resolved", () => {
    const result = normalizeDocsResponse({
      docs: [{ ...doc(), status: "active", source_pages: 1200, chunks: 500, shards: 4 }],
      total: 1,
      generation: 1,
      target_resolved: {
        input: "STM32F4",
        matched: "stm32f4",
        level: "family",
        matched_by: "exact",
        ancestors: ["stm32"],
      },
    })
    expect(result.docs).toHaveLength(1)
    expect(result.total).toBe(1)
    expect(result.generation).toBe(1)
    expect(result.targetResolved).toEqual({
      input: "STM32F4",
      matched: "stm32f4",
      level: "family",
      matchedBy: "exact",
      ancestors: ["stm32"],
    })
    // 无 target 时服务端给 null:不产生 targetResolved。
    expect(
      normalizeDocsResponse({ docs: [], total: 0, generation: 1, target_resolved: null }).targetResolved,
    ).toBeUndefined()
  })

  it("decodes the real /api/v2/targets/resolve shape: boolean resolved + matches[].code + ancestors + candidates", () => {
    expect(
      normalizeResolveResponse({
        query: "STM32F407VG",
        normalized: "stm32f407vg",
        resolved: true,
        matches: [
          {
            code: "stm32f407",
            level: "device",
            vendor: "st",
            title: "STM32F407",
            legacy_bucket: "STM32F4",
            matched_by: "exact",
            pattern: "stm32f407",
            ancestors: ["stm32f4", "stm32"],
          },
        ],
        ancestors: ["stm32f4", "stm32"],
        docs: 3,
        candidates: [],
      }),
    ).toEqual({
      resolved: ["stm32f407", "stm32f4", "stm32"],
      candidates: [],
      docs: 3,
      fields: { query: "STM32F407VG", normalized: "stm32f407vg" },
    })

    expect(
      normalizeResolveResponse({
        query: "GD33F303",
        normalized: "gd33f303",
        resolved: false,
        matches: [],
        ancestors: [],
        docs: 0,
        candidates: [
          {
            code: "gd32",
            level: "series",
            vendor: "geehy",
            title: "GD32",
            pattern: "gd32",
            matched_by: "candidate",
            ancestors: [],
          },
          {
            code: "gd32f3",
            level: "family",
            vendor: "geehy",
            title: "GD32F3",
            pattern: "gd32f3",
            matched_by: "candidate",
            ancestors: ["gd32"],
          },
        ],
      }),
    ).toMatchObject({ resolved: [], candidates: ["gd32", "gd32f3"], docs: 0 })

    expect(normalizeResolveResponse({ targets: ["stm32f4"] })).toMatchObject({ resolved: ["stm32f4"] })
    expect(normalizeResolveResponse(null)).toEqual({ resolved: [], candidates: [], fields: {} })
  })
})
