// Datasheet manual library — types shared between the renderer UI, the Platform
// abstraction, and the Electron main controller (packages/desktop/src/main/manuals.ts).
//
// Two tiers (mirrors yoma-config/tool/lib/paths.ts + rag_yoma):
//   shared  = official corpus; index is always local, artifacts download on demand
//             from the yoma file server
//   overlay = the user's own docs; ingested locally (Docling via rag_yoma CLI),
//             never leaves the machine

export type ManualTier = "shared" | "overlay"

export type ManualItem = {
  chip: string
  rev: string
  manualName: string
  tier: ManualTier
  /** annotation: datasheet | schematic | tutorial | reference; "" for legacy builds (== datasheet) */
  kind: string
  /** virtual-directory folder from shared catalog.json ("" = 未分类/root; overlay is always "") */
  folder: string
  numChunks: number | null
  builtAt: string | null
  /** total artifact bytes per the manifest inventory (null for pre-inventory builds) */
  totalBytes: number | null
  /** number of artifact files per the inventory (null for pre-inventory builds) */
  fileCount: number | null
  /** shared tier: local artifact materialization; overlay artifacts are local by construction */
  downloaded: "complete" | "partial" | "none" | "unknown"
}

export type ManualsConfig = {
  /** yoma file server base URL (YOMA_DATASHEET_SERVER), null if unconfigured */
  serverUrl: string | null
  /** rag_yoma checkout used for local overlay ingest (YOMA_RAG_REPO), null if unconfigured */
  ragRepo: string | null
  /** true when local ingest is possible (ragRepo set and exists) */
  canIngest: boolean
  indexRoot: string
  artifactsRoot: string
  /** installed shared-index snapshot version (<indexRoot>/shared/snapshot.json); null = 没装过快照 */
  indexVersion: number | null
}

/** Result of the user-triggered index update (手册库「更新索引」). */
export type IndexUpdateResult = {
  ok: boolean
  error?: string
  /** server's latest snapshot version (also the installed one when ok) */
  version?: number
  /** true when the installed snapshot already was the server's latest — nothing changed */
  upToDate?: boolean
  numManuals?: number
}

export type ManualsEvent =
  | { type: "download-progress"; chip: string; rev: string; done: number; total: number; bytes: number; file: string }
  | { type: "download-end"; chip: string; rev: string; ok: boolean; error?: string; downloaded: number; skipped: number }
  | { type: "index-update-progress"; phase: "download" | "install"; bytes: number; total: number }
  | { type: "ingest-log"; line: string }
  | { type: "ingest-end"; chip: string; rev: string; ok: boolean; error?: string }
  | { type: "changed" }

export type IngestRequest = {
  /** absolute path to the PDF on this machine (from the native file picker) */
  pdfPath: string
  chip: string
  rev: string
  /** datasheet | schematic | tutorial | reference (defaults to datasheet) */
  kind: string
  figures: boolean
  maxPages?: number | null
}

export type ManualsPlatform = {
  config(): Promise<ManualsConfig>
  list(): Promise<ManualItem[]>
  /** download one shared manual's artifacts; progress arrives via subscribe() events */
  download(chip: string, rev: string): Promise<{ ok: boolean; error?: string; downloaded: number; skipped: number }>
  /**
   * 手动更新 shared 索引:拉服务器最新快照(/api/index/latest.json → zip),校验
   * sha256 与嵌入模型后原子替换 <indexRoot>/shared/。已是最新时返回 upToDate。
   * 下载进度经 subscribe() 的 index-update-progress 事件到达。
   */
  updateIndex(): Promise<IndexUpdateResult>
  /** ingest a user PDF into the overlay tier (runs rag_yoma locally); log lines via subscribe() */
  ingest(req: IngestRequest): Promise<{ ok: boolean; error?: string }>
  cancelIngest(): Promise<void>
  subscribe(cb: (event: ManualsEvent) => void): () => void
}
