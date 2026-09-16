/** Immutable, content-verified snapshots. Incomplete builds never become visible. */
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export function aborted(signal?: AbortSignal) {
  signal?.throwIfAborted()
}

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export async function fileDigest(file: string): Promise<string> {
  return digest(await readFile(file))
}

export async function filesBelow(root: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string, ancestors = new Set<string>()) {
    aborted(signal)
    const resolved = await realpath(dir)
    if (ancestors.has(resolved)) throw new Error(`Circular directory link in STM32 resource: ${dir}`)
    const visited = new Set([...ancestors, resolved])
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      // ST component packages may use symlinks; stat follows their actual local contents.
      const info = entry.isSymbolicLink() ? await stat(file) : entry
      if (info.isDirectory()) await walk(file, visited)
      else if (info.isFile()) files.push(path.relative(root, file).replaceAll("\\", "/"))
    }
  }
  await walk(root)
  return files.sort()
}

/** Cache digests by size/mtime/ctime, but always enumerate so additions/removals invalidate. */
const hashes = new Map<string, { stamp: string; hash: string }>()
export async function treeDigest(root: string, signal?: AbortSignal, include = (_file: string) => true) {
  const entries: Record<string, string> = {}
  for (const relative of (await filesBelow(root, signal)).filter(include)) {
    aborted(signal)
    const file = path.join(root, relative)
    const info = await stat(file)
    const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`
    const cached = hashes.get(file)
    const hash = cached?.stamp === stamp ? cached.hash : await fileDigest(file)
    hashes.set(file, { stamp, hash })
    entries[relative] = hash
  }
  return { hash: digest(JSON.stringify(entries)), files: entries }
}

type SnapshotRecord = { key: string; files: Record<string, string> }
async function intact(root: string, key: string, signal?: AbortSignal): Promise<boolean> {
  try {
    aborted(signal)
    const record = JSON.parse(await readFile(path.join(root, ".snapshot.json"), "utf8")) as SnapshotRecord
    if (record.key !== key || !record.files || Object.keys(record.files).length === 0) return false
    const actual = (await filesBelow(root, signal)).filter((file) => file !== ".snapshot.json")
    if (JSON.stringify(actual) !== JSON.stringify(Object.keys(record.files).sort())) return false
    for (const [file, hash] of Object.entries(record.files)) {
      aborted(signal)
      const resolved = path.resolve(root, file)
      if (!resolved.startsWith(path.resolve(root) + path.sep) || (await fileDigest(resolved)) !== hash) return false
    }
    return true
  } catch {
    aborted(signal)
    return false
  }
}

async function cachedSnapshot(parent: string, key: string, signal?: AbortSignal) {
  const entries = await readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  for (const entry of entries) {
    aborted(signal)
    if (!entry.isDirectory() || !entry.name.startsWith(`${key}-`)) continue
    const candidate = path.join(parent, entry.name)
    if (await intact(candidate, key, signal)) return candidate
  }
  return undefined
}

/** Only ever remove a private staging directory created by this module. */
async function removeStage(parent: string, stage: string) {
  if (path.dirname(path.resolve(stage)) !== path.resolve(parent) || !path.basename(stage).startsWith(".building-")) {
    throw new Error("Invalid STM32 staging directory")
  }
  await rm(stage, { recursive: true, force: true })
}

type Flight = {
  controller: AbortController
  listeners: Set<(message: string) => void>
  waiters: number
  done: Promise<string>
}
const flights = new Map<string, Flight>()

export async function snapshot(
  parent: string,
  key: string,
  build: (stage: string, signal: AbortSignal, progress: (message: string) => void) => Promise<void>,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<string> {
  aborted(signal)
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error("Invalid STM32 snapshot key")
  const destination = path.join(parent, key)
  const cached = await cachedSnapshot(parent, key, signal)
  aborted(signal)
  if (cached) return cached
  let flight = flights.get(destination)
  // A cancelled last waiter may have left a child in the process of terminating.
  if (flight?.controller.signal.aborted) {
    await flight.done.catch(() => undefined)
    aborted(signal)
    return snapshot(parent, key, build, signal, onProgress)
  }
  if (!flight) {
    const controller = new AbortController()
    const listeners = new Set<(message: string) => void>()
    flight = { controller, listeners, waiters: 0, done: Promise.resolve("") }
    const current = flight
    flight.done = (async () => {
      await mkdir(parent, { recursive: true })
      const ready = await cachedSnapshot(parent, key, controller.signal)
      if (ready) return ready
      const stage = path.join(parent, `.building-${randomUUID()}`)
      await mkdir(stage)
      try {
        await build(stage, controller.signal, (message) => {
          for (const listener of listeners) {
            try {
              listener(message)
            } catch {
              /* Progress must not invalidate prepared resources. */
            }
          }
        })
        aborted(controller.signal)
        const content = await treeDigest(stage, controller.signal)
        await writeFile(path.join(stage, ".snapshot.json"), JSON.stringify({ key, files: content.files }))
        aborted(controller.signal)
        // Separate generations make cross-process publication race-free. Never move/delete an
        // existing snapshot: desktop or bench may still be using its path. Bad ones are ignored.
        const ready = await cachedSnapshot(parent, key, controller.signal)
        if (ready) return ready
        const published = path.join(parent, `${key}-${randomUUID()}`)
        await rename(stage, published)
        return published
      } finally {
        await removeStage(parent, stage)
      }
    })().finally(() => {
      if (flights.get(destination) === current) flights.delete(destination)
    })
    flights.set(destination, flight)
  }
  flight.waiters++
  if (onProgress) flight.listeners.add(onProgress)
  const current = flight
  return new Promise<string>((resolve, reject) => {
    let finished = false
    const settle = (error?: unknown, result?: string) => {
      if (finished) return
      finished = true
      signal?.removeEventListener("abort", cancel)
      if (onProgress) current.listeners.delete(onProgress)
      if (--current.waiters === 0) current.controller.abort()
      if (error !== undefined) reject(error)
      else resolve(result!)
    }
    const cancel = () => settle(signal?.reason ?? new Error("STM32 resource preparation cancelled"))
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    current.done.then(
      (result) => settle(undefined, result),
      (error) => settle(error),
    )
  })
}
