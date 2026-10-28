import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { createGunzip } from "node:zlib"
import type { createCodelibClient } from "./client.ts"

const MAX_ARCHIVE = 2 * 1024 ** 3
const MAX_EXPANDED = 8 * 1024 ** 3
const MAX_ENTRIES = 200_000
function cancelled(signal?: AbortSignal) { signal?.throwIfAborted() }
function samePath(left: string, right: string) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Reject Windows special names on every platform, including NTFS streams and aliases. */
export function archivePath(name: string): string[] {
  if (!name || name.includes("\\") || name.startsWith("/") || /[\x00-\x1f:]/.test(name)) throw new Error(`Unsafe archive path: ${name}`)
  while (name.startsWith("./")) name = name.slice(2)
  const parts = name.replace(/\/$/, "").split("/")
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`Unsafe archive path: ${name}`)
  return parts
}

async function directory(target: string) {
  try { await mkdir(target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
  const stat = await lstat(target)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Directory is a link or non-directory: ${target}`)
  if (!samePath(path.resolve(await realpath(target)), path.resolve(target))) throw new Error(`Directory redirects outside its path: ${target}`)
}

/** Small streaming tar reader. No external process, links, devices, execution, or mode restoration. */
export async function extractArchive(archive: string, dest: string, signal?: AbortSignal) {
  const source = createReadStream(archive)
  const input = source.pipe(createGunzip())
  source.on("error", error => input.destroy(error))
  const abort = () => input.destroy(signal?.reason instanceof Error ? signal.reason : new Error("Cancelled"))
  signal?.addEventListener("abort", abort, { once: true })
  const iterator = input[Symbol.asyncIterator]()
  let buffer = Buffer.alloc(0)
  let expanded = 0
  let entries = 0
  const seen = new Set<string>()
  // Track implicit parents too: Windows would otherwise merge Dir/a and dir/b,
  // while a case-sensitive filesystem would publish a different source tree.
  const spellings = new Map<string, string>()
  async function take(size: number): Promise<Buffer> {
    while (buffer.length < size) {
      cancelled(signal)
      const next = await iterator.next()
      if (next.done) throw new Error("Truncated tar archive")
      expanded += next.value.length
      if (expanded > MAX_EXPANDED) throw new Error("Expanded archive exceeds 8 GiB safety limit")
      buffer = Buffer.concat([buffer, next.value])
    }
    const out = buffer.subarray(0, size)
    buffer = buffer.subarray(size)
    return out
  }
  const text = (value: Buffer) => value.toString("utf8").replace(/\0.*$/s, "")
  const octal = (value: Buffer) => {
    const str = text(value).trim()
    if (!/^[0-7]+$/.test(str)) throw new Error("Unsupported tar numeric field")
    const number = Number.parseInt(str, 8)
    if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid tar size")
    return number
  }
  let extendedPath: string | undefined
  try {
    while (true) {
      cancelled(signal)
      const header = await take(512)
      if (header.every(byte => byte === 0)) {
        if (!(await take(512)).every(byte => byte === 0)) throw new Error("Invalid tar end marker")
        if (extendedPath) throw new Error("Dangling tar extension")
        // Consume and validate trailing padding: this also verifies the gzip checksum.
        if (buffer.some(byte => byte !== 0)) throw new Error("Nonzero trailing tar data")
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          cancelled(signal)
          expanded += chunk.length
          if (expanded > MAX_EXPANDED || chunk.some((byte: number) => byte !== 0)) throw new Error("Invalid trailing tar data")
        }
        return
      }
      const checksum = octal(header.subarray(148, 156))
      let sum = 0
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!
      if (sum !== checksum) throw new Error("Invalid tar header checksum")
      const size = octal(header.subarray(124, 136))
      const type = String.fromCharCode(header[156]!)
      const prefix = text(header.subarray(345, 500))
      const rawName = text(header.subarray(0, 100))
      const name = extendedPath ?? (prefix ? `${prefix}/${rawName}` : rawName)
      extendedPath = undefined
      if (++entries > MAX_ENTRIES || size > MAX_EXPANDED) throw new Error("Archive exceeds safety limits")
      if (type === "x" || type === "L") {
        if (size > 1024 * 1024) throw new Error("Tar extension too large")
        const data = await take(size)
        if (type === "L") extendedPath = text(data).replace(/\n$/, "")
        else {
          let offset = 0
          while (offset < data.length) {
            const space = data.indexOf(32, offset)
            const count = Number(data.subarray(offset, space).toString())
            if (space < offset || !Number.isSafeInteger(count) || count <= space - offset + 1 || offset + count > data.length || data[offset + count - 1] !== 10) throw new Error("Malformed pax record")
            const record = data.subarray(space + 1, offset + count - 1).toString("utf8")
            const eq = record.indexOf("=")
            const key = record.slice(0, eq)
            if (key === "path") extendedPath = record.slice(eq + 1)
            else if (!["mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "comment"].includes(key)) throw new Error(`Unsupported pax field: ${key}`)
            offset += count
          }
        }
        if (extendedPath) archivePath(extendedPath)
        await take((512 - size % 512) % 512)
        continue
      }
      if (type !== "0" && type !== "\0" && type !== "5") throw new Error(`Unsafe or unsupported tar entry type: ${type}`)
      if ((name === "." || name === "./") && type === "5" && size === 0) continue
      const parts = archivePath(name)
      const key = parts.join("/").toLowerCase()
      if (seen.has(key)) throw new Error(`Duplicate archive entry: ${name}`)
      for (let length = 1; length <= parts.length; length++) {
        const spelling = parts.slice(0, length).join("/")
        const folded = spelling.toLowerCase()
        const existing = spellings.get(folded)
        if (existing !== undefined && existing !== spelling) throw new Error(`Archive path case alias: ${spelling} conflicts with ${existing}`)
        spellings.set(folded, spelling)
      }
      seen.add(key)
      let parent = dest
      for (const part of parts.slice(0, -1)) { parent = path.join(parent, part); await directory(parent) }
      const target = path.join(parent, parts.at(-1)!)
      if (type === "5") {
        if (size !== 0) throw new Error("Tar directory contains data")
        await directory(target)
      } else {
        const file = await open(target, "wx", 0o600)
        try {
          let remaining = size
          while (remaining) { const chunk = await take(Math.min(remaining, 64 * 1024)); await file.writeFile(chunk); remaining -= chunk.length }
        } finally { await file.close() }
      }
      await take((512 - size % 512) % 512)
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    input.destroy()
    source.destroy()
  }
}

export async function materialize(client: ReturnType<typeof createCodelibClient>, cwd: string, corpusId: string, commit: string, sha: string, bytes: number | null, signal?: AbortSignal) {
  if (!commit.trim() || !/^[a-f0-9]{64}$/i.test(sha)) throw new Error("Selected hit has no valid commit/archive SHA pin; search again.")
  if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ARCHIVE)) throw new Error("Archive exceeds 2 GiB safety limit or has invalid size.")
  cancelled(signal)
  const root = await realpath(cwd)
  const base = path.join(root, ".yoma", "codelib")
  await directory(path.join(root, ".yoma"))
  await directory(base)
  const temp = await mkdtemp(path.join(base, ".tmp-"))
  const archive = path.join(temp, "archive.tar.gz")
  const staging = path.join(temp, "source")
  let reserved: string | undefined
  try {
    await client.archive(corpusId, commit, sha, async response => {
      if (response.status !== 200 || !response.body) throw new Error("Expected a complete archive response (HTTP 200)")
      const hash = createHash("sha256")
      const file = await open(archive, "wx", 0o600)
      let count = 0
      try {
        for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
          cancelled(signal)
          count += chunk.length
          if (count > MAX_ARCHIVE || (bytes !== null && count > bytes)) throw new Error("Archive download exceeds expected size or 2 GiB limit")
          hash.update(chunk)
          await file.writeFile(chunk)
        }
      } finally { await file.close() }
      if ((bytes !== null && count !== bytes) || hash.digest("hex") !== sha.toLowerCase()) throw new Error("Archive SHA256/size mismatch: selected source changed; search again.")
    })
    cancelled(signal)
    await mkdir(staging)
    await extractArchive(archive, staging, signal)
    cancelled(signal)
    // Recheck managed parents after network and extraction. Reserve a NEW destination;
    // rename only inside it, never over an existing user directory (including empty ones).
    await directory(path.join(root, ".yoma"))
    await directory(base)
    const safeId = corpusId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "corpus"
    const candidate = path.join(base, `${safeId}-${randomUUID()}`)
    await mkdir(candidate)
    reserved = candidate
    await writeFile(path.join(reserved, ".gitignore"), "*\n", { flag: "wx" })
    await rename(staging, path.join(reserved, "source"))
    const result = path.join(reserved, "source")
    reserved = undefined
    return result
  } finally {
    // Only invocation-owned, checked paths. Never recursively remove a path after a
    // managed parent became a junction; fail closed and leave the temp for inspection.
    const actualBase = await realpath(base).catch(() => "")
    if (samePath(actualBase, base)) {
      await rm(temp, { recursive: true, force: true })
      if (reserved) await rm(reserved, { recursive: true, force: true })
    }
  }
}
