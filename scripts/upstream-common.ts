import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

export const UPSTREAM_DIRECTORIES = [
  "packages/ai/src",
  "packages/agent/src",
  "packages/agent/test",
  "packages/chord/src",
  "packages/telemetry/src",
] as const
export const UPSTREAM_FILES = [
  "packages/agent/scripts/generate-telemetry-docs.ts",
  "packages/ai/test/event-stream.test.ts",
] as const
export const UPSTREAM_SCOPES = [...UPSTREAM_DIRECTORIES, ...UPSTREAM_FILES]
export const UPSTREAM_MANIFESTS = ["agent", "ai", "chord", "telemetry"].map((name) => `packages/${name}/package.json`)

export interface UpstreamLock {
  repository: string
  commit: string
  version?: string
  sha256: Record<string, string>
  generatedSnapshot?: {
    kind: "pi-model-data"
    provenance: string
    sha256: Record<string, string>
  }
  [key: string]: unknown
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function validateRelativePath(path: string): void {
  if (!path || /[\\:\x00-\x1f\x7f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`不安全的相对路径：${JSON.stringify(path)}`)
  }
}

export function inUpstreamScope(path: string): boolean {
  return UPSTREAM_DIRECTORIES.some((dir) => path.startsWith(`${dir}/`)) || UPSTREAM_FILES.some((file) => path === file)
}

export function parseUpstreamLock(text: string): UpstreamLock {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("upstream-lock.json 必须是对象")
  const lock = value as UpstreamLock
  if (typeof lock.repository !== "string" || !lock.repository.trim() || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(lock.commit)) {
    throw new Error("上游锁必须包含 repository 和完整 commit SHA")
  }
  if (!lock.sha256 || typeof lock.sha256 !== "object" || Array.isArray(lock.sha256) || !Object.keys(lock.sha256).length) {
    throw new Error("上游锁的 sha256 文件清单不能为空")
  }
  for (const [path, hash] of Object.entries(lock.sha256)) {
    validateRelativePath(path)
    if (!inUpstreamScope(path)) throw new Error(`锁文件包含同步范围外的路径：${path}`)
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`无效 SHA-256：${path}`)
  }
  if (lock.generatedSnapshot !== undefined) {
    const snapshot = lock.generatedSnapshot
    if (!snapshot || typeof snapshot !== "object" || snapshot.kind !== "pi-model-data" || typeof snapshot.provenance !== "string" || !snapshot.provenance.trim()) {
      throw new Error("generatedSnapshot 必须明确 pi-model-data 类型和 provenance")
    }
    if (!snapshot.sha256 || typeof snapshot.sha256 !== "object" || Array.isArray(snapshot.sha256) || !Object.keys(snapshot.sha256).length) {
      throw new Error("generatedSnapshot 的哈希清单不能为空")
    }
    for (const [path, hash] of Object.entries(snapshot.sha256)) {
      validateRelativePath(path)
      if (!/^packages\/ai\/src\/providers\/data\/[^/]+\.json$/.test(path)) throw new Error(`生成快照只允许模型数据目录内的直接 JSON 文件：${path}`)
      if (path in lock.sha256) throw new Error(`Git 与生成快照清单重叠：${path}`)
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`无效生成快照 SHA-256：${path}`)
    }
  }
  return lock
}

/** Refuse symlinks in every existing component. Missing destinations are allowed for new files. */
export async function safeProjectPath(root: string, path: string): Promise<string> {
  validateRelativePath(path)
  let current = root
  const parts = path.split("/")
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`拒绝符号链接：${path}`)
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`路径的父级不是目录：${path}`)
      if (index === parts.length - 1 && !info.isFile() && !info.isDirectory()) throw new Error(`拒绝特殊文件：${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break
      throw error
    }
  }
  return join(root, path)
}

export async function readProjectFile(root: string, path: string): Promise<Buffer> {
  const file = await safeProjectPath(root, path)
  if (!(await lstat(file)).isFile()) throw new Error(`不是普通文件：${path}`)
  return readFile(file)
}

/** Offline integrity check: compares with the saved lock, without rewriting it. */
export async function checkProtectedFiles(root: string, lock: UpstreamLock): Promise<string[]> {
  // Revalidate callers' objects as well as locks loaded by the CLI.
  parseUpstreamLock(JSON.stringify(lock))
  const failures: string[] = []
  const hashes = { ...lock.sha256, ...lock.generatedSnapshot?.sha256 }
  const seen = new Set<string>()
  async function scan(path: string): Promise<void> {
    try {
      const full = await safeProjectPath(root, path)
      const info = await lstat(full)
      if (info.isDirectory()) {
        for (const child of await readdir(full)) await scan(`${path}/${child}`)
      } else if (info.isFile()) seen.add(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(String(error))
    }
  }
  for (const scope of UPSTREAM_SCOPES) await scan(scope)
  for (const path of seen) if (!(path in hashes)) failures.push(`未锁定的新增文件：${path}`)
  for (const [path, expected] of Object.entries(hashes)) {
    try {
      if (sha256(await readProjectFile(root, path)) !== expected) failures.push(`${path in lock.sha256 ? "内容改变" : "生成快照内容改变"}：${path}`)
    } catch (error) {
      failures.push(`文件缺失或不可读取：${path} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return failures
}
