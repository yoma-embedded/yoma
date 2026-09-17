/** Immutable captures: sample files first, capture.json last. UI and tools read the same evidence. */
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TimeScale } from "./preamble.ts"

export const SCOPE_DIR = path.join(".yoma", "scope")
export const SCOPE_SCREENS_DIR = "screens"
export const SCOPE_CONFIG_FILE = path.join(SCOPE_DIR, "config.json")
export const CAPTURE_JSON = "capture.json"
const MAX_CHANNEL_BYTES = 64 * 1024 * 1024
const CACHE_BYTES = 32 * 1024 * 1024

export interface StoredChannel {
  ch: number
  label?: string
  file: string
  points: number
  vdiv: number
  offset: number
  coupling?: string
  probe: number
  unit: string
  bwlimit?: string
  gain: number
  rawOffset: number
  codePerDiv: number
  /** Per-channel timing survives captures with channels of different record lengths. */
  time?: TimeScale
  stride?: number
  recordPoints?: number
  sampleRate?: number
  /** Samples within 1% of the ADC rails at capture time; peaks in such a channel are bounds, not readings. */
  clipped?: { low: number; high: number }
}

export interface ScopeCaptureMeta {
  schema?: "yoma/scope@1"
  id: string
  /** Host clock when the file was written. */
  createdAt: number
  /** Instrument's own acquisition time (local time, no zone) when the driver can read it. */
  acquiredAt?: string
  address: string
  /** Registry name of the driver that produced this capture (siglent / demo / …). */
  driver?: string
  model?: string
  serial?: string
  firmware?: string
  mode: string
  quality?: "exact" | "overview"
  timebase: { scale: number; delay: number }
  sampleRate: number
  interval: number
  stride: number
  recordPoints: number
  mdepth?: string
  trigger?: { mode?: string; source?: string; level?: number; slope?: string; status?: string }
  channels: StoredChannel[]
  screenshot?: { file: string; createdAt: number }
}

export interface ScopeCaptureListing extends ScopeCaptureMeta {
  dir: string
}
export interface ScopeConfig {
  address: string
}

function number(value: unknown, name: string, positive = false): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) {
    throw new Error(`scope: invalid capture ${name}`)
  }
}

function integer(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER) {
  number(value, name, true)
  if (!Number.isSafeInteger(value) || value > max) throw new Error(`scope: invalid capture ${name}`)
}

/** Stored filenames cannot escape the capture; no absolute paths, symlinks checked when reading. */
function filename(value: unknown, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error("scope: invalid capture filename")
}

export function validateCapture(meta: ScopeCaptureMeta): void {
  if (
    !meta ||
    typeof meta !== "object" ||
    typeof meta.id !== "string" ||
    !meta.id ||
    typeof meta.address !== "string" ||
    typeof meta.mode !== "string"
  )
    throw new Error("scope: invalid capture metadata")
  if (meta.schema !== undefined && meta.schema !== "yoma/scope@1") throw new Error("scope: unsupported capture schema")
  if (meta.quality !== undefined && meta.quality !== "exact" && meta.quality !== "overview")
    throw new Error("scope: invalid capture quality")
  number(meta.createdAt, "createdAt", true)
  number(meta.sampleRate, "sampleRate", true)
  number(meta.interval, "interval", true)
  integer(meta.stride, "stride")
  integer(meta.recordPoints, "recordPoints")
  number(meta.timebase?.scale, "timebase.scale", true)
  number(meta.timebase?.delay, "timebase.delay")
  if (!Array.isArray(meta.channels) || meta.channels.length < 1 || meta.channels.length > 4)
    throw new Error("scope: capture needs 1–4 channels")
  const seen = new Set<number>()
  for (const ch of meta.channels) {
    integer(ch.ch, "channel", 4)
    if (seen.has(ch.ch)) throw new Error("scope: duplicate capture channel")
    seen.add(ch.ch)
    filename(ch.file, /^c[1-4]\.i16$/)
    if (ch.file !== `c${ch.ch}.i16`) throw new Error("scope: channel filename mismatch")
    integer(ch.points, "points", MAX_CHANNEL_BYTES / 2)
    for (const key of ["gain", "probe", "codePerDiv", "vdiv"] as const) number(ch[key], key, true)
    number(ch.offset, "offset")
    number(ch.rawOffset, "rawOffset")
    number(((32768 * ch.gain) / ch.codePerDiv + Math.abs(ch.rawOffset)) * ch.probe, "voltage conversion", true)
    if (typeof ch.unit !== "string" || ch.unit.length > 16) throw new Error("scope: invalid capture unit")
    if (ch.time) {
      number(ch.time.interval, "channel.interval", true)
      number(ch.time.tdiv, "channel.tdiv", true)
      number(ch.time.delay, "channel.delay")
      number(ch.time.grid, "channel.grid", true)
    }
    if (ch.stride !== undefined) integer(ch.stride, "channel.stride")
    if (ch.recordPoints !== undefined) integer(ch.recordPoints, "channel.recordPoints")
    if (ch.sampleRate !== undefined) number(ch.sampleRate, "channel.sampleRate", true)
    if (ch.clipped !== undefined) {
      if (typeof ch.clipped !== "object" || ch.clipped === null) throw new Error("scope: invalid capture clipped")
      for (const key of ["low", "high"] as const) {
        const value = ch.clipped[key]
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("scope: invalid capture clipped")
      }
    }
    if (meta.quality === "exact" && (ch.stride ?? meta.stride) !== 1)
      throw new Error("scope: exact capture cannot be decimated")
    if (meta.quality === "exact" && ch.points !== (ch.recordPoints ?? meta.recordPoints))
      throw new Error("scope: exact capture is incomplete")
  }
  if (meta.driver !== undefined && (typeof meta.driver !== "string" || meta.driver.length > 32))
    throw new Error("scope: invalid capture driver")
  if (meta.acquiredAt !== undefined && (typeof meta.acquiredAt !== "string" || meta.acquiredAt.length > 40))
    throw new Error("scope: invalid capture acquiredAt")
  if (meta.screenshot) {
    filename(meta.screenshot.file, /^[a-zA-Z0-9_-]+\.png$/)
    number(meta.screenshot.createdAt, "screenshot.createdAt", true)
  }
}

export async function writeCapture(
  dir: string,
  meta: ScopeCaptureMeta,
  samples: Map<number, Int16Array>,
): Promise<void> {
  validateCapture(meta)
  // Reusing an id would silently replace the evidence behind an old conversation.
  if (
    await stat(path.join(dir, CAPTURE_JSON)).then(
      () => true,
      () => false,
    )
  )
    throw new Error("scope: capture already exists")
  for (const ch of meta.channels) {
    if (samples.get(ch.ch)?.length !== ch.points) throw new Error(`scope: C${ch.ch} sample count mismatch`)
  }
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(path.dirname(dir), ".gitignore"), "*\n", { flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    },
  )
  for (const ch of meta.channels) {
    const codes = samples.get(ch.ch)!
    const bytes = Buffer.allocUnsafe(codes.length * 2)
    for (let i = 0; i < codes.length; i++) bytes.writeInt16LE(codes[i]!, i * 2)
    await writeFile(path.join(dir, ch.file), bytes, { flag: "wx" })
  }
  const tmp = path.join(dir, `capture-${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify({ ...meta, schema: "yoma/scope@1" }) + "\n", { flag: "wx" })
  await rename(tmp, path.join(dir, CAPTURE_JSON))
}

export async function readCaptureMeta(dir: string): Promise<ScopeCaptureMeta> {
  const file = path.join(dir, CAPTURE_JSON)
  const info = await lstat(file)
  if (!info.isFile()) throw new Error("scope: invalid capture metadata file")
  if (info.size > 128 * 1024) throw new Error("scope: oversized capture metadata")
  const meta = JSON.parse(await readFile(file, "utf8")) as ScopeCaptureMeta
  validateCapture(meta)
  return meta
}

const cache = new Map<string, { key: string; codes: Int16Array }>()
const pending = new Map<string, Promise<Int16Array>>()
let cachedBytes = 0

export async function readChannelCodes(dir: string, ch: StoredChannel): Promise<Int16Array> {
  filename(ch.file, /^c[1-4]\.i16$/)
  const file = path.join(dir, ch.file)
  const info = await lstat(file)
  if (!info.isFile() || info.size !== ch.points * 2 || info.size > MAX_CHANNEL_BYTES) {
    throw new Error(
      `scope: C${ch.ch} saved data is missing or incomplete (expected ${ch.points * 2} bytes, found ${info.size})`,
    )
  }
  const key = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`
  const hit = cache.get(file)
  if (hit?.key === key) {
    cache.delete(file)
    cache.set(file, hit)
    return hit.codes
  }
  const pendingKey = `${file}:${key}`
  if (pending.has(pendingKey)) return pending.get(pendingKey)!
  const task = (async () => {
    const bytes = await readFile(file)
    if (bytes.length !== info.size) throw new Error("scope: saved data changed while reading")
    const codes = new Int16Array(ch.points)
    for (let i = 0; i < codes.length; i++) codes[i] = bytes.readInt16LE(i * 2)
    const old = cache.get(file)
    if (old) {
      cachedBytes -= old.codes.byteLength
      cache.delete(file)
    }
    if (codes.byteLength <= CACHE_BYTES) {
      while (cachedBytes + codes.byteLength > CACHE_BYTES && cache.size) {
        const oldest = cache.keys().next().value!
        cachedBytes -= cache.get(oldest)!.codes.byteLength
        cache.delete(oldest)
      }
      cache.set(file, { key, codes })
      cachedBytes += codes.byteLength
    }
    return codes
  })().finally(() => pending.delete(pendingKey))
  pending.set(pendingKey, task)
  return task
}

export async function listCaptures(projectDir: string): Promise<ScopeCaptureListing[]> {
  const root = path.join(projectDir, SCOPE_DIR)
  const ids = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const result: ScopeCaptureListing[] = []
  for (const id of ids) {
    if (!id.isDirectory() || id.name === SCOPE_SCREENS_DIR) continue
    const dir = path.join(root, id.name)
    try {
      result.push({ ...(await readCaptureMeta(dir)), dir })
    } catch {
      /* incomplete captures have no committed metadata */
    }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}

export async function readScopeConfig(projectDir: string): Promise<ScopeConfig | undefined> {
  for (const file of [SCOPE_CONFIG_FILE, path.join(".yoma", "scope.json")]) {
    try {
      const raw = JSON.parse(await readFile(path.join(projectDir, file), "utf8"))
      if (typeof raw.address === "string" && raw.address) return { address: raw.address }
    } catch {
      // Older installs kept the local instrument address beside the scope directory.
    }
  }
  return undefined
}

export async function ensureScopeDir(projectDir: string): Promise<string> {
  const dir = path.join(projectDir, SCOPE_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, ".gitignore"), "*\n", { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error
  })
  return dir
}

export async function writeScopeConfig(projectDir: string, config: ScopeConfig): Promise<void> {
  const dir = await ensureScopeDir(projectDir)
  const tmp = path.join(dir, `config-${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify(config) + "\n")
  await rename(tmp, path.join(projectDir, SCOPE_CONFIG_FILE))
}
