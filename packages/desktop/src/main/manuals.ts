// Datasheet manual library — Electron main controller + IPC.
//
// Node-side work the renderer can't do: read the local RAG index manifests, download
// a shared manual's artifacts from the yoma file server (per-file, sha256-verified,
// resumable — the same contract as the agent's download_manual tool), and spawn the
// rag_yoma CLI to ingest a user PDF into the local overlay tier.
//
// Path/env resolution: process.env first, then a KEY=value line in ~/.my-pi/.env
// (override with $YOMA_ENV_FILE). Same directory as auth.json / skills / mailbox.

import { app, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
  IndexUpdateResult,
  IngestRequest,
  ManualItem,
  ManualsConfig,
  ManualsEvent,
  ManualTier,
} from "@yoma-desktop/app/manuals/types"

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// 快照安装前校验的嵌入模型不变量(必须与内核 datasheet/paths.ts 一致)。
const EMBED_MODEL = "BAAI/bge-m3"
const EMBED_DIM = 1024

// --- env resolution: ~/.my-pi, same directory as auth.json -----------------------
function configHome(): string {
  return path.join(os.homedir(), ".my-pi")
}

function envFiles(): string[] {
  const explicit = process.env.YOMA_ENV_FILE?.trim()
  if (explicit) return [explicit]
  return [path.join(configHome(), ".env"), path.join(os.homedir(), ".config", "opencode", ".env")]
}

function envVar(name: string): string | undefined {
  const fromProcess = process.env[name]?.trim()
  if (fromProcess) return fromProcess
  for (const file of envFiles()) {
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1 || trimmed.slice(0, eq).trim() !== name) continue
      let val = trimmed.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (val) return val
    }
  }
  return undefined
}

function indexRoot(): string {
  return envVar("YOMA_DATASHEET_INDEX") ?? path.join(configHome(), "datasheet-index")
}
function artifactsRoot(): string {
  return envVar("YOMA_DATASHEET_ARTIFACTS") ?? path.join(configHome(), "datasheet-artifacts")
}
function serverUrl(): string | null {
  return envVar("YOMA_DATASHEET_SERVER")?.replace(/\/+$/, "") ?? null
}
function ragRepo(): string | null {
  return envVar("YOMA_RAG_REPO") ?? null
}
function ragPython(): string {
  return envVar("YOMA_RAG_PYTHON") ?? "python"
}

// --- manifests -------------------------------------------------------------------
type ArtifactFile = { path: string; sha256: string; bytes: number }
type ManifestEntry = {
  chip?: string
  rev?: string
  manual_name?: string
  kind?: string
  num_chunks?: number
  built_at?: string
  source_sha256?: string
  artifacts?: ArtifactFile[]
}

function readManifestAt(file: string): ManifestEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readManifest(tier: ManualTier): ManifestEntry[] {
  return readManifestAt(path.join(indexRoot(), tier, "manifest.json"))
}

// --- streaming download helpers ----------------------------------------------------
// 大文件(几十 MB 的 PDF / 快照 zip)不整块进内存:边下边写 .part 边算 sha256,
// 校验不过删 .part 抛错;过了才 rename 到位,半截文件永远不会顶替完整文件。
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(file)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

async function fetchToFile(
  url: string,
  dest: string,
  opts: { sha256?: string; onBytes?: (bytes: number) => void } = {},
): Promise<{ bytes: number; sha256: string }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = dest + ".part"
  const hash = createHash("sha256")
  let bytes = 0
  const sink = createWriteStream(tmp)
  try {
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        const buf = Buffer.from(chunk)
        hash.update(buf)
        bytes += buf.byteLength
        opts.onBytes?.(bytes)
        if (!sink.write(buf)) await once(sink, "drain")
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer())
      hash.update(buf)
      bytes = buf.byteLength
      opts.onBytes?.(bytes)
      sink.write(buf)
    }
    await new Promise<void>((resolve, reject) => {
      sink.once("error", reject)
      sink.end(resolve)
    })
  } catch (error) {
    sink.destroy()
    rmSync(tmp, { force: true })
    throw error
  }
  const digest = hash.digest("hex")
  if (opts.sha256 && digest !== opts.sha256) {
    rmSync(tmp, { force: true })
    throw new Error("sha256 不匹配")
  }
  renameSync(tmp, dest)
  return { bytes, sha256: digest }
}

// --- catalog (virtual directory; shared tier only, distributed with the snapshot) --
// <indexRoot>/shared/catalog.json = { version, folders: string[], placements: {"<chip>/<rev>": folder} }.
// Tolerant reads (per PLAN §6.2): missing file / bad JSON = empty catalog; a placement pointing
// at a folder that no longer exists is treated as root ("").
type Catalog = { folders: Set<string>; placements: Record<string, string> }

function readCatalog(): Catalog {
  try {
    const parsed = JSON.parse(readFileSync(path.join(indexRoot(), "shared", "catalog.json"), "utf8"))
    const folders = Array.isArray(parsed?.folders)
      ? parsed.folders.filter((f: unknown): f is string => typeof f === "string")
      : []
    const placements: Record<string, string> = {}
    const raw = parsed?.placements
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string") placements[key] = value
      }
    }
    return { folders: new Set(folders), placements }
  } catch {
    return { folders: new Set(), placements: {} }
  }
}

function downloadedState(entry: ManifestEntry): ManualItem["downloaded"] {
  const inventory = entry.artifacts
  if (!inventory?.length) {
    // pre-inventory build: probe the conventional parsed path as a best-effort signal
    if (!entry.chip || !entry.rev) return "unknown"
    return existsSync(path.join(artifactsRoot(), "parsed", entry.chip, `${entry.rev}.md`)) ? "unknown" : "none"
  }
  const root = artifactsRoot()
  let present = 0
  for (const file of inventory) {
    if (existsSync(path.join(root, file.path))) present++
  }
  if (present === inventory.length) return "complete"
  return present === 0 ? "none" : "partial"
}

function listManuals(): ManualItem[] {
  const items: ManualItem[] = []
  const catalog = readCatalog()
  for (const tier of ["shared", "overlay"] as const) {
    for (const entry of readManifest(tier)) {
      if (!entry.chip || !entry.rev) continue
      // folder comes from the shared catalog only; overlay is always root ("").
      let folder = ""
      if (tier === "shared") {
        const placed = catalog.placements[`${entry.chip}/${entry.rev}`]
        folder = placed && catalog.folders.has(placed) ? placed : ""
      }
      items.push({
        chip: entry.chip,
        rev: entry.rev,
        manualName: entry.manual_name ?? entry.rev,
        tier,
        kind: entry.kind ?? "",
        folder,
        numChunks: entry.num_chunks ?? null,
        builtAt: entry.built_at ?? null,
        totalBytes: entry.artifacts?.reduce((sum, file) => sum + (file.bytes || 0), 0) ?? null,
        fileCount: entry.artifacts?.length ?? null,
        downloaded: tier === "overlay" ? "complete" : downloadedState(entry),
      })
    }
  }
  return items
}

// --- events ---------------------------------------------------------------------
type Listener = (event: ManualsEvent) => void
const listeners = new Set<Listener>()

function emit(event: ManualsEvent) {
  listeners.forEach((listener) => listener(event))
}

// --- download (same per-file contract as the agent's download_manual tool) --------
const activeDownloads = new Set<string>()

async function loadInventory(chip: string, rev: string): Promise<ArtifactFile[]> {
  const local = readManifest("shared").find((e) => e.chip === chip && e.rev === rev)
  if (local?.artifacts?.length) return local.artifacts
  const base = serverUrl()
  if (!base) throw new Error("未配置文件服务器(在 ~/.my-pi/.env 里设置 YOMA_DATASHEET_SERVER)")
  const url = `${base}/api/bundles/${encodeURIComponent(chip)}/${encodeURIComponent(rev)}.json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`服务器上没有 ${chip}/${rev}(HTTP ${res.status})`)
  const info = (await res.json()) as { files?: ArtifactFile[] }
  if (!info.files?.length) throw new Error(`服务器返回了空的产物清单(${chip}/${rev})`)
  return info.files
}

async function downloadManual(chip: string, rev: string) {
  if (!NAME_RE.test(chip) || !NAME_RE.test(rev)) throw new Error(`非法的 chip/rev: ${chip}/${rev}`)
  if (indexUpdating) throw new Error("索引正在更新,等它完成后再下载手册")
  const key = `${chip}/${rev}`
  if (activeDownloads.has(key)) throw new Error(`${key} 已在下载中`)
  activeDownloads.add(key)
  try {
    const files = await loadInventory(chip, rev)
    const base = serverUrl()
    if (!base) throw new Error("未配置文件服务器(在 ~/.my-pi/.env 里设置 YOMA_DATASHEET_SERVER)")
    const root = path.resolve(artifactsRoot())
    let downloaded = 0
    let skipped = 0
    let bytes = 0
    const failures: string[] = []
    for (const [i, file] of files.entries()) {
      const dest = path.resolve(root, file.path)
      if (dest !== root && !dest.startsWith(root + path.sep)) {
        failures.push(`${file.path}: 越出产物根目录,已跳过`)
        continue
      }
      if (existsSync(dest) && (await sha256File(dest)) === file.sha256) {
        skipped++
      } else {
        try {
          const rel = file.path.split("/").map(encodeURIComponent).join("/")
          const result = await fetchToFile(`${base}/artifacts/${rel}`, dest, { sha256: file.sha256 })
          downloaded++
          bytes += result.bytes
        } catch (error: any) {
          const message = String(error?.message ?? error)
          failures.push(
            `${file.path}: ${message === "sha256 不匹配" ? "sha256 不匹配(索引与服务器版本不一致?先更新索引再重试)" : message}`,
          )
        }
      }
      emit({ type: "download-progress", chip, rev, done: i + 1, total: files.length, bytes, file: file.path })
    }
    const ok = failures.length === 0
    const error = ok ? undefined : failures.join("; ")
    emit({ type: "download-end", chip, rev, ok, error, downloaded, skipped })
    emit({ type: "changed" })
    return { ok, error, downloaded, skipped }
  } catch (error: any) {
    const message = String(error?.message ?? error)
    emit({ type: "download-end", chip, rev, ok: false, error: message, downloaded: 0, skipped: 0 })
    return { ok: false, error: message, downloaded: 0, skipped: 0 }
  } finally {
    activeDownloads.delete(key)
  }
}

// --- shared 索引快照更新(手册库「更新索引」按钮;仅手动触发,无自动链路) ------------
// 服务器契约:GET /api/index/latest.json = {version,file,sha256,bytes,embed_model,
// embed_dim,num_manuals,…};GET /api/index/index-v<N>.zip = 整个 shared 层
// (条目全部带 shared/ 前缀)。安装后把 latest.json 落成 shared/snapshot.json 作为
// 本地已装版本标记(git/build.ts 时代装的索引没有它,视作"未知版本",总是可更新)。

type LatestSnapshot = {
  version: number
  file: string
  sha256: string
  bytes: number
  embed_model: string
  embed_dim: number
  num_manuals: number
}

let indexUpdating = false

function installedSnapshot(): { version: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(indexRoot(), "shared", "snapshot.json"), "utf8"))
    return typeof parsed?.version === "number" ? parsed : null
  } catch {
    return null
  }
}

// 解压快照 zip。Windows(≥10 1803)与 macOS 自带 bsdtar,能直接解 zip;
// Linux 的 GNU tar 不行,回退系统 unzip。零新增依赖,解压本身即流式落盘。
// Windows 上优先用 System32 的绝对路径:PATH 里若混进 MSYS/Git 的 GNU tar,
// 裸 "tar" 会解不了 zip。
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  const attempts: [string, string[]][] = [
    ...(process.platform === "win32"
      ? [
          [
            path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
            ["-xf", zipPath, "-C", destDir],
          ] as [string, string[]],
        ]
      : []),
    ["tar", ["-xf", zipPath, "-C", destDir]],
    ["unzip", ["-o", "-q", zipPath, "-d", destDir]],
  ]
  let lastError = ""
  for (const [cmd, args] of attempts) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] })
      let stderr = ""
      child.stderr?.on("data", (d) => (stderr += String(d)))
      child.once("error", () => resolve(false))
      child.once("exit", (code) => {
        if (code !== 0) lastError = stderr.trim() || `${cmd} 退出码 ${code}`
        resolve(code === 0)
      })
    })
    if (ok) return
  }
  throw new Error(`解压快照失败(需要系统 tar 或 unzip):${lastError || "命令不存在"}`)
}

// 指纹失效(与 engines/build.ts 停用前的索引安装步骤一致):新旧 manifest 对比,
// 构建变了的手册删掉本地产物,避免旧 parsed md / 图片与新 chunks 悄悄错位。
function invalidateStaleArtifacts(oldEntries: ManifestEntry[], freshEntries: ManifestEntry[]) {
  const fingerprint = (e: ManifestEntry) => `${e.source_sha256 ?? ""}|${e.built_at ?? ""}`
  const fresh = new Map(freshEntries.map((e) => [`${e.chip}/${e.rev}`, fingerprint(e)]))
  const root = artifactsRoot()
  for (const old of oldEntries) {
    const { chip, rev } = old
    if (!chip || !rev || !NAME_RE.test(chip) || !NAME_RE.test(rev)) continue
    if (fresh.get(`${chip}/${rev}`) === fingerprint(old)) continue
    const targets = [
      path.join(root, "parsed", chip, `${rev}.md`),
      path.join(root, "source", chip, `${rev}.pdf`),
      path.join(root, "figures", chip, `${rev}.figures.json`),
      path.join(root, "figures", chip, rev),
    ]
    for (const target of targets) rmSync(target, { recursive: true, force: true })
  }
}

async function updateIndex(): Promise<IndexUpdateResult> {
  if (indexUpdating) return { ok: false, error: "索引更新已在进行中" }
  if (activeDownloads.size > 0) return { ok: false, error: "有手册正在下载,等它结束后再更新索引" }
  const base = serverUrl()
  if (!base) return { ok: false, error: "未配置文件服务器(在 ~/.my-pi/.env 里设置 YOMA_DATASHEET_SERVER)" }
  indexUpdating = true
  try {
    const res = await fetch(`${base}/api/index/latest.json`)
    if (res.status === 404) return { ok: false, error: "服务器还没有发布过索引快照(先在管理台发布)" }
    if (!res.ok) return { ok: false, error: `服务器错误(HTTP ${res.status})` }
    const latest = (await res.json()) as LatestSnapshot
    if (!/^index-v\d+\.zip$/.test(latest.file ?? "")) return { ok: false, error: `快照文件名异常:${latest.file}` }
    if (latest.embed_model !== EMBED_MODEL || latest.embed_dim !== EMBED_DIM) {
      return {
        ok: false,
        error: `快照嵌入模型不匹配(服务器 ${latest.embed_model}/${latest.embed_dim},本端 ${EMBED_MODEL}/${EMBED_DIM}),拒绝安装`,
      }
    }
    if (installedSnapshot()?.version === latest.version) {
      return { ok: true, upToDate: true, version: latest.version, numManuals: latest.num_manuals }
    }

    const root = indexRoot()
    mkdirSync(root, { recursive: true })
    // 清理上次更新可能遗留的暂存/待删目录(当时被占用删不掉的)
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".shared-old-") || entry.name.startsWith(".snapshot-staging-")) {
        try {
          rmSync(path.join(root, entry.name), { recursive: true, force: true })
        } catch {}
      }
    }

    const zipPath = path.join(root, latest.file)
    const staging = path.join(root, `.snapshot-staging-${latest.version}`)
    let lastEmit = 0
    emit({ type: "index-update-progress", phase: "download", bytes: 0, total: latest.bytes })
    try {
      await fetchToFile(`${base}/api/index/${latest.file}`, zipPath, {
        sha256: latest.sha256,
        onBytes: (bytes) => {
          const now = Date.now()
          if (now - lastEmit > 250) {
            lastEmit = now
            emit({ type: "index-update-progress", phase: "download", bytes, total: latest.bytes })
          }
        },
      })

      emit({ type: "index-update-progress", phase: "install", bytes: latest.bytes, total: latest.bytes })
      await extractZip(zipPath, staging)
      const stagedShared = path.join(staging, "shared")
      if (!existsSync(path.join(stagedShared, "manifest.json"))) {
        throw new Error("快照内容异常:缺少 shared/manifest.json")
      }
      invalidateStaleArtifacts(readManifest("shared"), readManifestAt(path.join(stagedShared, "manifest.json")))
      writeFileSync(path.join(stagedShared, "snapshot.json"), JSON.stringify(latest, null, 2) + "\n")

      // 原子换目录:旧的先挪开,新的换上;换上失败则把旧的挪回来,现场不破坏。
      const current = path.join(root, "shared")
      const trash = path.join(root, `.shared-old-${latest.version}`)
      if (existsSync(current)) renameSync(current, trash)
      try {
        renameSync(stagedShared, current)
      } catch (error) {
        if (existsSync(trash)) renameSync(trash, current)
        throw error
      }
      try {
        rmSync(trash, { recursive: true, force: true })
      } catch {}
    } finally {
      try {
        rmSync(staging, { recursive: true, force: true })
      } catch {}
      try {
        rmSync(zipPath, { force: true })
      } catch {}
    }

    emit({ type: "changed" })
    return { ok: true, version: latest.version, numManuals: latest.num_manuals }
  } catch (error: any) {
    const message = String(error?.message ?? error)
    // Windows 上最常见的失败:检索刚用过索引,lance 文件句柄未释放
    if (/EBUSY|EPERM|EACCES/i.test(message)) {
      return { ok: false, error: `索引目录被占用(${message})——停止当前会话或重启桌面端后重试` }
    }
    return { ok: false, error: message }
  } finally {
    indexUpdating = false
  }
}

// --- local overlay ingest (spawns the rag_yoma CLI) --------------------------------
let ingestChild: ChildProcess | null = null

const KINDS = new Set(["datasheet", "schematic", "tutorial", "reference"])

async function ingestLocal(req: IngestRequest): Promise<{ ok: boolean; error?: string }> {
  const { pdfPath, chip, rev } = req
  const kind = KINDS.has(req.kind) ? req.kind : "datasheet"
  if (!NAME_RE.test(chip) || !NAME_RE.test(rev)) return { ok: false, error: `非法的 chip/rev: ${chip}/${rev}` }
  if (!pdfPath?.toLowerCase().endsWith(".pdf") || !existsSync(pdfPath)) {
    return { ok: false, error: `PDF 不存在: ${pdfPath}` }
  }
  const repo = ragRepo()
  if (!repo || !existsSync(repo)) {
    return {
      ok: false,
      error: "未配置 rag_yoma 仓库(在 ~/.my-pi/.env 里设置 YOMA_RAG_REPO=<rag_yoma 路径>," +
        "如需指定解析环境的 Python 再设 YOMA_RAG_PYTHON=<python.exe 路径>)",
    }
  }
  if (ingestChild) return { ok: false, error: "已有解析任务在运行,请等它结束" }

  const args = [
    "-m", "rag_yoma", "ingest", pdfPath,
    "--chip", chip, "--rev", rev,
    "--kind", kind,
    "--tier", "overlay",
    "--out", indexRoot(), "--artifacts", artifactsRoot(),
  ]
  if (req.figures) args.push("--figures")
  if (req.maxPages && req.maxPages > 0) args.push("--max-pages", String(req.maxPages))

  emit({ type: "ingest-log", line: `$ ${ragPython()} ${args.join(" ")}` })
  return await new Promise((resolve) => {
    const child = spawn(ragPython(), args, { cwd: repo, env: process.env, windowsHide: true })
    ingestChild = child
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) emit({ type: "ingest-log", line })
      }
    }
    child.stdout?.on("data", forward)
    child.stderr?.on("data", forward)
    child.once("error", (error) => {
      ingestChild = null
      const message = `无法启动解析进程(${error.message})——检查 YOMA_RAG_PYTHON 是否指向 yoma-rag 环境的 python`
      emit({ type: "ingest-end", chip, rev, ok: false, error: message })
      resolve({ ok: false, error: message })
    })
    child.once("exit", (code) => {
      ingestChild = null
      const ok = code === 0
      const error = ok ? undefined : `解析进程退出码 ${code}(见上方日志)`
      emit({ type: "ingest-end", chip, rev, ok, error })
      if (ok) emit({ type: "changed" })
      resolve({ ok, error })
    })
  })
}

// --- IPC -------------------------------------------------------------------------
export function registerManualsIpcHandlers() {
  const subscriptions = new Map<number, Listener>()
  const unsubscribe = (id: number) => {
    const listener = subscriptions.get(id)
    if (!listener) return
    listeners.delete(listener)
    subscriptions.delete(id)
  }
  app.once("will-quit", () => {
    subscriptions.forEach((listener) => listeners.delete(listener))
    subscriptions.clear()
    ingestChild?.kill()
  })

  ipcMain.handle("manuals-subscribe", (event) => {
    const id = event.sender.id
    if (subscriptions.has(id)) return
    const listener: Listener = (payload) => {
      if (event.sender.isDestroyed()) {
        unsubscribe(id)
        return
      }
      event.sender.send("manuals-event", payload)
    }
    subscriptions.set(id, listener)
    listeners.add(listener)
    event.sender.once("destroyed", () => unsubscribe(id))
  })
  ipcMain.handle("manuals-unsubscribe", (event) => unsubscribe(event.sender.id))

  ipcMain.handle("manuals-config", (): ManualsConfig => {
    const repo = ragRepo()
    return {
      serverUrl: serverUrl(),
      ragRepo: repo,
      canIngest: Boolean(repo && existsSync(repo)),
      indexRoot: indexRoot(),
      artifactsRoot: artifactsRoot(),
      indexVersion: installedSnapshot()?.version ?? null,
    }
  })
  ipcMain.handle("manuals-list", () => listManuals())
  ipcMain.handle("manuals-download", (_event: IpcMainInvokeEvent, chip: string, rev: string) =>
    downloadManual(String(chip ?? ""), String(rev ?? "")),
  )
  ipcMain.handle("manuals-index-update", () => updateIndex())
  ipcMain.handle("manuals-ingest", (_event: IpcMainInvokeEvent, req: IngestRequest) =>
    ingestLocal({
      pdfPath: String(req?.pdfPath ?? ""),
      chip: String(req?.chip ?? "").trim(),
      rev: String(req?.rev ?? "").trim(),
      kind: String(req?.kind ?? "").trim(),
      figures: Boolean(req?.figures),
      maxPages: req?.maxPages ? Number(req.maxPages) : null,
    }),
  )
  ipcMain.handle("manuals-cancel-ingest", () => {
    ingestChild?.kill()
  })
}
