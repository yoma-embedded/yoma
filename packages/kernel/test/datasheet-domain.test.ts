/**
 * datasheet 的纯函数层(host/domain/datasheet):章节抽取、引用格式、产物路径检查、芯片 / 分卷 / 封面型号解析。
 * 不碰网络;有网络的那一半在 tools-datasheet.test.ts。
 *
 * 章节那一组对着真手册的形状写(2026-09-14 审稿从 STM32F4 参考手册里抓出来的三条):所有标题都是 `##`、
 * 标点带反斜杠转义、有一个标题就叫 `2`。
 */

import { describe, expect, it } from "vitest"

import {
  artifactPathProblem,
  buildChipIndex,
  capped,
  chipCandidatesNote,
  chipMissNote,
  coverPattern,
  coveringNote,
  encodeRel,
  expandCoverStems,
  figureMime,
  findPhrase,
  formatChipList,
  formatCitation,
  formatFamilyManuals,
  groupManuals,
  headingDepth,
  lastSegment,
  manualCount,
  manualCountLine,
  manualsCovering,
  matchHeading,
  mergeHits,
  norm,
  onTarget,
  parseHeadings,
  resolveChip,
  resolveRev,
  type SearchHit,
  sectionRange,
  splitBase,
  splitByScope,
  tableOfContents,
  unescapeMarkdown,
  unknownChipHelp,
  validName,
} from "../src/host/domain/datasheet/index.ts"

// ─── 章节抽取 ─────────────────────────────────────────────────────────────────

describe("section helpers", () => {
  const md = [
    "# 1 Overview",
    "intro",
    "## 1.1 Features",
    "feature text",
    "## 1.2 Clocks and startup",
    "clock text line",
    "more clock text",
    "# 2 Registers",
    "reg text",
  ]

  it("parses headings with levels and lines", () => {
    const headings = parseHeadings(md)
    expect(headings.map((h) => h.title)).toEqual([
      "1 Overview",
      "1.1 Features",
      "1.2 Clocks and startup",
      "2 Registers",
    ])
    expect(headings[2]).toEqual({ level: 2, title: "1.2 Clocks and startup", line: 4 })
  })

  it("matches headings with escalating tolerance", () => {
    const headings = parseHeadings(md)
    expect(matchHeading(headings, "1.2 Clocks and startup")).toBe(2)
    expect(matchHeading(headings, "1.2 Clocks")).toBe(2)
    expect(matchHeading(headings, "clocks and")).toBe(2)
    expect(matchHeading(headings, "nonexistent")).toBe(-1)
    expect(matchHeading(headings, "   ")).toBe(-1)
  })

  it("takes the most specific breadcrumb segment", () => {
    expect(lastSegment("2 Description > 2.3.7 Clocks and startup")).toBe("2.3.7 Clocks and startup")
    expect(lastSegment("single")).toBe("single")
    expect(lastSegment(" > ")).toBe(">")
  })

  it("returns the section from its heading to the next same-or-higher heading", () => {
    const headings = parseHeadings(md)
    expect(sectionRange(headings, 2, md.length)).toEqual([4, 7])
    expect(sectionRange(headings, 3, md.length)).toEqual([7, md.length])
  })

  it("findPhrase returns the LAST occurrence (skipping the ToC entry) and escapes regex metacharacters", () => {
    const raw = "Contents: Clocks and startup ... body ... ## Clocks and startup\nreal text"
    const at = findPhrase(raw, "clocks and startup")
    expect(raw.slice(at).startsWith("Clocks and startup\nreal text")).toBe(true)
    expect(findPhrase("value (0x20) here", "(0x20)")).toBe(6)
    expect(findPhrase("abc", "")).toBe(-1)
  })

  it("caps long text with a note and lists a short ToC with a limit", () => {
    const { out, truncated } = capped("x".repeat(50), 10)
    expect(truncated).toBe(true)
    expect(out).toContain("truncated at 10 chars")
    expect(capped("short", 10)).toEqual({ out: "short", truncated: false })
    const toc = tableOfContents(parseHeadings(md), 2)
    expect(toc).toBe("# 1 Overview\n## 1.1 Features\n… (+2 more headings)")
  })
})

describe("section helpers against the real manual shape", () => {
  // Docling 的产物:全是 ##,位域行 / Reset value / Note 都成了标题,标点转义,还有一个标题就叫 "2"。
  const real = [
    "## 30.6.2 Data register (USART\\_DR)",
    "Address offset: 0x04",
    "## Bits 8:0 DR[8:0]: Data value",
    "## 30.6.3 Baud rate register (USART\\_BRR)",
    "Note:",
    "The baud counters stop counting if the TE or RE bits are disabled respectively.",
    "Address offset: 0x08",
    "## Reset value: 0x0000 0000",
    "table row",
    "## Bits 15:4 DIV\\_Mantissa[11:0]: mantissa of USARTDIV",
    "mantissa text",
    "## Bits 3:0 DIV\\_Fraction[3:0]: fraction of USARTDIV",
    "fraction text",
    "## 30.6.4 Control register 1 (USART\\_CR1)",
    "cr1 text",
    "## 2",
    "stray",
    "## 25.4.1 TIM6&amp;TIM7 control register 1 (TIMx\\_CR1)",
    "tim text",
    "## 25.4.2 TIM6&amp;TIM7 control register 2 (TIMx\\_CR2)",
    "tim2 text",
  ]
  const headings = parseHeadings(real)

  it("unescapes markdown backslashes and HTML entities on both sides", () => {
    expect(unescapeMarkdown("USART\\_BRR &amp; TIM6&amp;TIM7 \\(x\\)")).toBe("USART_BRR & TIM6&TIM7 (x)")
    expect(norm("30.6.3 Baud rate register (USART\\_BRR)")).toBe("30.6.3 baud rate register (usart_brr)")
  })

  it("a hit's unescaped breadcrumb matches the escaped heading exactly", () => {
    expect(matchHeading(headings, "30.6.3 Baud rate register (USART_BRR)")).toBe(2)
    expect(matchHeading(headings, "25.4.1 TIM6&TIM7 control register 1 (TIMx_CR1)")).toBe(8)
  })

  it('the heading "2" cannot swallow anything: reverse matches need a real stem and a word boundary', () => {
    expect(matchHeading(headings, "25.4.1 TIM6&TIM7 control register 1 (TIMx_CR1) something extra")).toBe(8)
    expect(matchHeading(headings, "2xyz not a section")).toBe(-1)
    expect(matchHeading(headings, "2")).toBe(7) // 逐字命中它自己倒是可以
    // 前缀匹配也在词边界上断:"30.6" 不是 "30.6.2" 的词前缀
    expect(matchHeading(headings, "30.6.3")).toBe(2)
    expect(matchHeading(headings, "30.6")).toBe(-1)
  })

  it("headingDepth: numbered sections only", () => {
    expect(headingDepth("30.6.3 Baud rate register")).toBe(3)
    expect(headingDepth("2 Registers")).toBe(1)
    expect(headingDepth("3. Overview")).toBe(1)
    expect(headingDepth("Bits 15:4 DIV_Mantissa")).toBeUndefined()
    expect(headingDepth("Reset value: 0x0000 0000")).toBeUndefined()
    expect(headingDepth("0x08 offset")).toBeUndefined()
    expect(headingDepth("2")).toBeUndefined()
  })

  it("a numbered section runs to the next numbered heading of equal or shallower depth, swallowing bit-field lines", () => {
    expect(sectionRange(headings, 2, real.length)).toEqual([3, 13])
    const section = real.slice(3, 13).join("\n")
    expect(section).toContain("Bits 15:4 DIV\\_Mantissa")
    expect(section).toContain("Bits 3:0 DIV\\_Fraction")
    expect(section).not.toContain("USART\\_CR1")
    // 最后一个编号节跑到文件尾;不带编号的标题仍按层级断
    expect(sectionRange(headings, 9, real.length)).toEqual([19, real.length])
    expect(sectionRange(headings, 1, real.length)).toEqual([2, 3])
  })

  it("findPhrase matches through backslash escapes and entities", () => {
    const raw = real.join("\n")
    expect(raw.slice(findPhrase(raw, "register (USART_BRR)"))).toMatch(/^register \(USART\\_BRR\)/)
    expect(raw.slice(findPhrase(raw, "TIM6&TIM7 control register 2"))).toMatch(/^TIM6&amp;TIM7 control register 2/)
    expect(findPhrase(raw, "DIV_Fraction[3:0]")).toBeGreaterThan(0)
  })

  it("the ToC of a real manual lists numbered sections only, indented by depth, and says what it skipped", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ level: 2, title: `${i + 1}.1 Section ${i + 1}`, line: i * 3 }))
    const mixed = [
      { level: 2, title: "1 Chapter", line: 0 },
      ...many,
      { level: 2, title: "Bits 3:0 DIV_Fraction", line: 100 },
      { level: 2, title: "Note:", line: 101 },
    ]
    const toc = tableOfContents(mixed)
    expect(toc.startsWith("1 Chapter\n  1.1 Section 1\n  2.1 Section 2")).toBe(true)
    expect(toc).not.toContain("Bits 3:0")
    expect(toc).toContain("(2 unnumbered headings — bit fields, notes, figure captions — not listed")
    expect(tableOfContents(mixed, 3)).toContain("… (+10 more headings)")
  })
})

// ─── 命中与引用 ──────────────────────────────────────────────────────────────

const hit = (over: Partial<SearchHit>): SearchHit => ({
  text: "chunk text",
  manual_name: "RM0008",
  chip: "STM32F1",
  rev: "RM0008",
  page: 100,
  headings: "a > b",
  score: 0.5,
  kind: "",
  source_pdf: "",
  parsed_path: "",
  image_path: "",
  ...over,
})

describe("citations", () => {
  it("tags GENERAL / kind / FIGURE citations and appends pointers", () => {
    const text = formatCitation(
      hit({
        chip: "GENERAL",
        kind: "tutorial",
        image_path: "figures/F1/RM0008/f1.png",
        parsed_path: "parsed/F1/RM0008.md",
      }),
      0,
    )
    expect(text).toContain("[#1]  [GENERAL] [TUTORIAL] [FIGURE]")
    expect(text).toContain("figure: figures/F1/RM0008/f1.png")
    expect(text).toContain('source: parsed/F1/RM0008.md  (action "read_section" for the full section)')
  })

  it("plain datasheet hits carry no tags", () => {
    expect(formatCitation(hit({}), 1).startsWith("[#2] RM0008 (STM32F1) p.100")).toBe(true)
  })

  it("page 0 (page-less formats: md/docx/txt) is not shown as p.0", () => {
    expect(formatCitation(hit({ page: 100 }), 0)).toContain("p.100")
    expect(formatCitation(hit({ page: 0 }), 0)).not.toContain("p.0")
  })

  it("onTarget / splitByScope treat GENERAL (and a blank chip) as off-target, case- and separator-insensitively", () => {
    expect(onTarget([hit({ chip: "GENERAL" }), hit({ chip: "general" })])).toBe(false)
    expect(onTarget([hit({ chip: "" })])).toBe(false)
    expect(onTarget([hit({ chip: "GENERAL" }), hit({ chip: "STM32F1" })])).toBe(true)
    expect(onTarget([])).toBe(false)
    const { target, general } = splitByScope([hit({ chip: "GENERAL", page: 1 }), hit({ page: 2 }), hit({ page: 3 })])
    expect(target.map((h) => h.page)).toEqual([2, 3])
    expect(general.map((h) => h.page)).toEqual([1])
  })

  it("mergeHits sorts by score, dedupes identical chunks and stops at k", () => {
    const a = [
      hit({ rev: "R_p1-400", page: 5, score: 0.6, text: "same" }),
      hit({ rev: "R_p1-400", page: 9, score: 0.4 }),
    ]
    const b = [
      hit({ rev: "R_p401-800", page: 500, score: 0.8 }),
      hit({ rev: "R_p1-400", page: 5, score: 0.6, text: "same" }),
    ]
    const merged = mergeHits([a, b], 2)
    expect(merged.map((h) => h.score)).toEqual([0.8, 0.6])
    expect(mergeHits([a, b], 10)).toHaveLength(3)
  })
})

describe("artifact paths and names", () => {
  it("encodes artifact rel paths per segment", () => {
    expect(encodeRel("figures/STM32 F1/RM0008/f 1.png")).toBe("figures/STM32%20F1/RM0008/f%201.png")
  })

  it("validName mirrors the server's NAME_RE", () => {
    for (const ok of ["STM32F4", "AT32F421_DS", "RM0390_p401-800", "ESP32-S3", "a.b"])
      expect(validName(ok), ok).toBe(true)
    for (const bad of ["", " STM32", "esp32 s3", "-x", "STM32F4/RM", "芯片", "a;b"])
      expect(validName(bad), bad).toBe(false)
  })

  it("artifactPathProblem rejects everything that is not a server-relative path", () => {
    expect(artifactPathProblem("parsed/STM32F1/RM0008.md")).toBeUndefined()
    expect(artifactPathProblem("figures/AT32F/AT32F421_DS/AT32F421_DS-F1.png")).toBeUndefined()
    expect(artifactPathProblem("")).toMatch(/empty/)
    expect(artifactPathProblem("/etc/passwd")).toMatch(/not a server-relative/)
    expect(artifactPathProblem("C:/x.md")).toMatch(/not a server-relative/)
    expect(artifactPathProblem("parsed\\STM32F1\\RM0008.md")).toMatch(/"\/"/)
    expect(artifactPathProblem("parsed/../secret.md")).toMatch(/".."/)
    expect(artifactPathProblem("parsed//x.md")).toMatch(/empty/)
    expect(artifactPathProblem("parsed/./x.md")).toMatch(/"\."/)
    expect(artifactPathProblem("parsed/x\u0000.md")).toMatch(/control/)
  })

  it("figureMime accepts the web image extensions case-insensitively and nothing else", () => {
    expect(figureMime("a/b.PNG")).toBe("image/png")
    expect(figureMime("a/b.jpeg")).toBe("image/jpeg")
    expect(figureMime("a/b.svg")).toBeUndefined()
    expect(figureMime("noext")).toBeUndefined()
  })
})

// ─── 芯片索引 ─────────────────────────────────────────────────────────────────

const index = buildChipIndex([
  { chip: "AT32F", rev: "AT32F421_DS", manual_name: "雅特力 AT32F421 数据手册", kind: "datasheet" },
  { chip: "AT32F", rev: "AT32F403_DS", kind: "datasheet" },
  { chip: "AT32A", rev: "AT32A403A_DS" },
  { chip: "AT32WB", rev: "AT32WB415_DS" },
  { chip: "STM32F1", rev: "RM0008" },
  {
    chip: "STM32F4",
    rev: "RM0390_p401-800",
    manual_name: "RM0390 参考手册（原文第 401–800 页）",
    kind: "datasheet",
    source_page_range: [401, 800],
  },
  {
    chip: "STM32F4",
    rev: "RM0390_p1-400",
    manual_name: "RM0390 参考手册（原文第 1–400 页）",
    kind: "datasheet",
    source_page_range: [1, 400],
  },
  {
    chip: "STM32F4",
    rev: "RM0390_p801-1200",
    manual_name: "RM0390 参考手册（原文第 801–1200 页）",
    kind: "datasheet",
    source_page_range: [801, 1200],
  },
  {
    chip: "STM32F4",
    rev: "DS8626",
    manual_name: "STM32F405 datasheet",
    kind: "datasheet",
    covered_devices: ["STM32F405", "STM32F407"],
  },
  // 线上的真形状:字符串、x 通配、斜杠备选
  {
    chip: "STM32G0",
    rev: "DS12231",
    manual_name: "STM32G081 datasheet",
    kind: "datasheet",
    covered_devices: "STM32G081xB",
  },
  {
    chip: "STM32G0",
    rev: "DS12232",
    manual_name: "STM32G071 datasheet",
    kind: "datasheet",
    covered_devices: "STM32G071x8/xB",
  },
  {
    chip: "STM32G0",
    rev: "DS13565",
    manual_name: "STM32G0B0 datasheet",
    kind: "datasheet",
    covered_devices: "STM32G0B0KE/CE/RE/VE",
  },
  {
    chip: "STM32G0",
    rev: "RM0444_p1-400",
    manual_name: "RM0444（原文第 1–400 页）",
    kind: "reference",
    covered_devices: "STM32G0x1",
    source_page_range: [1, 400],
  },
  {
    chip: "STM32G0",
    rev: "RM0444_p401-800",
    manual_name: "RM0444（原文第 401–800 页）",
    kind: "reference",
    covered_devices: "STM32G0x1",
    source_page_range: [401, 800],
  },
  {
    chip: "STM32G4",
    rev: "RM0440",
    manual_name: "STM32G4 reference manual",
    kind: "reference",
    covered_devices: "STM32G4",
  },
  { chip: "MM32S", rev: "MM32S_DS" },
  { chip: "MM32SPIN", rev: "MM32SPIN25_DS" },
  { chip: "ESP32-S3", rev: "TRM" },
  { chip: "GENERAL", rev: "PM0214", kind: "reference" },
  { chip: "", rev: "junk" },
  { chip: "NOREV", rev: "" },
])

describe("resolveChip", () => {
  it("skips entries without chip or rev, counts documents (not parts), and normalises separators", () => {
    expect(index.has("NOREV")).toBe(false)
    const list = formatChipList(index)
    expect(list).toContain("AT32F (2)")
    expect(list).toContain("STM32F4 (2)") // RM0390 三卷算一本 + DS8626
    expect(list).toContain("GENERAL (1, shared cross-chip bucket — folded into every search without rev)")
    expect(manualCount(index.get("STM32F4")!)).toBe(2)
    expect(manualCountLine(index.get("STM32F4")!)).toBe("2 manual(s) (4 page-range parts)")
    expect(manualCountLine(index.get("AT32F")!)).toBe("2 manual(s)")
    expect(resolveChip(index, "AT32F")).toEqual({ kind: "exact", chip: "AT32F" })
    expect(resolveChip(index, "at32f")).toEqual({ kind: "exact", chip: "AT32F" })
    expect(resolveChip(index, "esp32 s3")).toEqual({ kind: "exact", chip: "ESP32-S3" })
    expect(resolveChip(index, "esp32_s3")).toEqual({ kind: "exact", chip: "ESP32-S3" })
  })

  it("resolves a part number to the LONGEST family that prefixes it", () => {
    expect(resolveChip(index, "AT32F421C8T7")).toEqual({ kind: "family", chip: "AT32F" })
    expect(resolveChip(index, "STM32F407VGT6")).toEqual({ kind: "family", chip: "STM32F4" })
    expect(resolveChip(index, "MM32SPIN25")).toEqual({ kind: "family", chip: "MM32SPIN" })
  })

  it("reports ambiguity instead of picking one when a stem spans several families", () => {
    expect(resolveChip(index, "AT32")).toEqual({ kind: "ambiguous", candidates: ["AT32A", "AT32F", "AT32WB"] })
  })

  it("reports unknown chips with near candidates, or the whole list when nothing is near — never a silent guess", () => {
    const near = resolveChip(index, "STM32H7")
    expect(near).toEqual({ kind: "unknown", candidates: ["STM32F1", "STM32F4", "STM32G0", "STM32G4"], near: true })
    expect(chipCandidatesNote("STM32H7", near)).toContain("Closest index names: STM32F1, STM32F4, STM32G0, STM32G4.")
    const far = resolveChip(index, "TTP233")
    expect(far).toMatchObject({ kind: "unknown", near: false })
    expect((far as { candidates: string[] }).candidates).toHaveLength(index.size)
    expect(chipCandidatesNote("TTP233", far)).toContain("nothing indexed looks like it. Indexed families (11): ")
    expect(resolveChip(index, "")).toMatchObject({ kind: "unknown", near: false })
    expect(unknownChipHelp("TTP233", far)).toContain("NO SEARCH PERFORMED")
    expect(unknownChipHelp("AT32F", resolveChip(index, "AT32F"))).toBe("")
    expect(chipCandidatesNote("AT32", resolveChip(index, "AT32"))).toContain("pick one: AT32A, AT32F, AT32WB.")
  })

  it("says how many candidates were cut off instead of calling a truncated list 'closest'", () => {
    const big = buildChipIndex(
      Array.from({ length: 40 }, (_, i) => ({ chip: `ZZ${String(i).padStart(2, "0")}`, rev: "r" })),
    )
    const note = chipCandidatesNote("QQQ", resolveChip(big, "QQQ"))
    expect(note).toContain("Indexed families (first 30 of 40)")
    expect(note).toContain('(+10 more — action "chips" lists all)')
  })
})

describe("split manuals", () => {
  const f4 = index.get("STM32F4")!

  it("splitBase strips the page-range suffix and nothing else", () => {
    expect(splitBase("RM0390_p401-800")).toBe("RM0390")
    expect(splitBase("GD32E50x_RM_p1201-1239")).toBe("GD32E50x_RM")
    expect(splitBase("RM0008")).toBeUndefined()
    expect(splitBase("RM0390_p401")).toBeUndefined()
  })

  it("resolveRev: exact (case-insensitive) beats parts; a base name yields its parts sorted by start page", () => {
    expect(resolveRev(f4, "ds8626")).toEqual({ kind: "exact", rev: "DS8626" })
    expect(resolveRev(f4, "RM0390_p401-800")).toEqual({ kind: "exact", rev: "RM0390_p401-800" })
    expect(resolveRev(f4, "rm0390")).toEqual({
      kind: "parts",
      base: "RM0390",
      revs: ["RM0390_p1-400", "RM0390_p401-800", "RM0390_p801-1200"],
    })
    expect(resolveRev(f4, "RM0090")).toEqual({ kind: "unknown" })
    expect(resolveRev(f4, "")).toEqual({ kind: "unknown" })
  })

  it("groupManuals folds parts under their base and strips the page-range suffix from the name", () => {
    const groups = groupManuals(f4)
    expect(groups.map((g) => g.rev)).toEqual(["RM0390", "DS8626"])
    expect(groups[0]!.manual_name).toBe("RM0390 参考手册")
    expect(groups[0]!.parts.map((p) => p.rev)).toEqual(["RM0390_p1-400", "RM0390_p401-800", "RM0390_p801-1200"])
    expect(groups[1]!.parts).toHaveLength(1)
  })

  it("formatFamilyManuals shows a split manual as one row that says how to search all of it or one part", () => {
    const text = formatFamilyManuals(f4)
    expect(text).toContain(
      'rev "RM0390" [datasheet] — RM0390 参考手册  (split into 3 parts: p1-400, p401-800, p801-1200; "RM0390" searches all of them, "RM0390_p1-400" one)',
    )
    expect(text).toContain('rev "DS8626" [datasheet] — STM32F405 datasheet')
    expect(formatFamilyManuals(f4, 1)).toContain("… (+1 more)")
  })
})

describe("covered devices (the real manifest shape: strings with x wildcards and / alternatives)", () => {
  const g0 = index.get("STM32G0")!

  it("expandCoverStems expands slash alternatives against the tail of the full stem, and accepts arrays", () => {
    expect(expandCoverStems("STM32G081xB")).toEqual(["STM32G081xB"])
    expect(expandCoverStems("STM32G071x8/xB")).toEqual(["STM32G071x8", "STM32G071xB"])
    expect(expandCoverStems("STM32G0B0KE/CE/RE/VE")).toEqual([
      "STM32G0B0KE",
      "STM32G0B0CE",
      "STM32G0B0RE",
      "STM32G0B0VE",
    ])
    expect(expandCoverStems("STM32G031x4/x6/x8")).toEqual(["STM32G031x4", "STM32G031x6", "STM32G031x8"])
    expect(expandCoverStems(["STM32G08", ""])).toEqual(["STM32G08"])
    expect(expandCoverStems(null)).toEqual([])
    expect(expandCoverStems(undefined)).toEqual([])
  })

  it("coverPattern: x is a one-character wildcard, separators are dropped, short stems are refused", () => {
    expect(coverPattern("STM32G081xB")!.test("STM32G081RB")).toBe(true)
    expect(coverPattern("STM32G081xB")!.test("STM32G081KB")).toBe(true)
    expect(coverPattern("STM32G081xB")!.test("STM32G081RE")).toBe(false)
    expect(coverPattern("STM32G0x1")!.test("STM32G081RB")).toBe(true)
    expect(coverPattern("STM32G0x1")!.test("STM32G070RB")).toBe(false)
    expect(coverPattern("CH32X035")!.test("CH32X035C8T6")).toBe(true) // 大写 X 是字面
    expect(coverPattern("STM")).toBeUndefined()
  })

  it("manualsCovering / coveringNote name the datasheets and reference manuals whose cover lists the part", () => {
    expect(manualsCovering(g0, "STM32G081RBT6").map((m) => m.rev)).toEqual([
      "DS12231",
      "RM0444_p1-400",
      "RM0444_p401-800",
    ])
    expect(manualsCovering(g0, "stm32g071kb").map((m) => m.rev)).toEqual([
      "DS12232",
      "RM0444_p1-400",
      "RM0444_p401-800",
    ])
    expect(manualsCovering(g0, "STM32G0B0RE").map((m) => m.rev)).toEqual(["DS13565"])
    expect(manualsCovering(g0, "STM32G070RB")).toEqual([])
    expect(manualsCovering(g0, "STM")).toEqual([])
    expect(manualsCovering(index.get("STM32F4")!, "STM32F407VGT6").map((m) => m.rev)).toEqual(["DS8626"])
    expect(manualsCovering(index.get("STM32G4")!, "STM32G431KB").map((m) => m.rev)).toEqual(["RM0440"])
    expect(coveringNote(g0, "STM32G081RB")).toBe(
      'Manuals whose cover lists STM32G081RB: rev "DS12231" (STM32G081 datasheet), rev "RM0444" (RM0444, 2 parts) — pass one as `rev` to pin it.',
    )
    expect(coveringNote(g0, "STM32G070RB")).toBe("")
  })
})

describe("chipMissNote", () => {
  it("distinguishes an unknown rev from an indexed chip that was outscored, and lists the manuals either way", () => {
    const f4 = index.get("STM32F4")!
    const badRev = chipMissNote(f4, "RM0090")
    expect(badRev).toContain('no manual with rev "RM0090" exists for chip "STM32F4"')
    expect(badRev).toContain('rev "RM0390"')
    const partBase = chipMissNote(f4, "RM0390")
    expect(partBase).toContain("IS indexed (2 manual(s) (4 page-range parts))")
    const indexed = chipMissNote(f4, undefined)
    expect(indexed).toContain('chip "STM32F4" IS indexed (2 manual(s) (4 page-range parts))')
    expect(indexed).toContain("cross-chip GENERAL corpus")
  })
})
