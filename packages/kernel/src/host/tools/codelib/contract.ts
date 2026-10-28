import { type Static, Type } from "typebox"
import type { ToolContract } from "../contract-types.ts"

const parameters = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("show"), Type.Literal("catalog"), Type.Literal("materialize")]),
  queryText: Type.Optional(Type.String({ description: "Original natural-language intent; does not imply hard filters." })),
  target: Type.Optional(Type.String({ description: "Explicit hardware constraint; omit for chip-independent queries." })),
  ecosystem: Type.Optional(Type.String({ description: "Explicit ecosystem filter from the server catalog." })),
  board: Type.Optional(Type.String({ description: "Explicit board preference (server-defined semantics)." })),
  peripherals: Type.Optional(Type.Array(Type.String())),
  keywords: Type.Optional(Type.Array(Type.String({ description: "English capability keywords." }))),
  tier: Type.Optional(Type.String()),
  entryKind: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  buildableOnly: Type.Optional(Type.Boolean()),
  corpora: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  corpusId: Type.Optional(Type.String()),
  path: Type.Optional(Type.String({ description: "show: exact path from a search hit." })),
  revision: Type.Optional(Type.String({ description: "show: prefer hit.source.revisionSha256; only for unedited corpora with null revision use hit.source.indexSha256. Required; never substitute latest metadata." })),
  expectedCommit: Type.Optional(Type.String({ description: "materialize: selected hit.source.commit, required." })),
  expectedArchiveSha256: Type.Optional(Type.String({ description: "materialize: selected hit.source.archiveSha256, required." })),
  archiveBytes: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], { description: "materialize: selected hit.source.archiveBytes; null/omitted means unknown, never guess." })),
})
export type CodelibInput = Static<typeof parameters>

export interface CodelibSource {
  corpusId: string
  corpusVersion: string
  indexSha256: string
  revisionSha256: string | null
  commit: string | null
  archiveSha256: string | null
  archiveBytes: number | null
  enrichSha256?: string | null
  entryId?: string
  path?: string
}

export const CODELIB_CONTRACT = {
  name: "codelib",
  label: "例程库",
  description: "Search server-side code examples (search), inspect one pinned card (show), list corpora (catalog), or download verified source into a NEW cwd/.yoma/codelib directory (materialize). No local ranking, model keys, installation, execution or building. Pass the selected search hit's revision to show and its original commit/archive SHA/bytes to materialize. Source changes fail explicitly; search again. Large archives may take minutes; downloads restart after cancellation, without resume support.",
  parameters,
  guidelines: [
    "Use codelib search for source examples; express hardware/peripheral hard filters explicitly, keeping original intent in queryText. Ranking and filtering belong to the server.",
    "A missing/empty targets declaration does not prove hardware compatibility. buildable=false means unverified: preserve buildNote and explain porting/verification needs.",
    "Preserve every hit.source identity. Use show with revisionSha256 (or the selected hit's indexSha256 only when revision is null for an unedited corpus), and materialize with the selected hit's expectedCommit/expectedArchiveSha256/archiveBytes. Never read latest metadata to replace a pin. Materialize only retrieves files; do not execute or install archive content.",
  ],
  confirm: (input: CodelibInput) => input.action === "materialize",
  summary: (input: Partial<CodelibInput>) => [input.action, input.corpusId, input.expectedCommit, input.archiveBytes == null ? "" : `${input.archiveBytes} bytes${input.archiveBytes > 500 * 1024 ** 2 ? " (大语料 >500 MiB)" : ""}`, input.action === "materialize" ? "→ .yoma/codelib/ (new directory)" : input.path].filter(Boolean).join(" "),
} as const satisfies ToolContract<typeof parameters>
