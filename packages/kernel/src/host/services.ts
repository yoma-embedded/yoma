/**
 * 与内核无关的宿主服务:文件浏览、@提及搜索、git 状态、最近项目。
 *
 * 这些在 opencode 那边是后端路由,现在是 host 里的纯 Node 函数。没有一行碰 my-pi ——
 * 放在这里只是因为它们需要 Node 权限,而 renderer 是沙箱化的。
 */

import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

import type { FileDiff, FileEntry, VcsInfo } from "../types.ts"

const run = promisify(execFile)

/** 永远不该出现在文件树或 @提及里的目录。 */
const IGNORED = new Set([
  ".git",
  "node_modules",
  ".venv",
  "target",
  "dist",
  "out",
  ".turbo",
  "__pycache__",
  ".DS_Store",
])

export async function listFiles(directory: string, relative?: string): Promise<FileEntry[]> {
  const root = path.resolve(directory)
  const dir = relative ? path.resolve(root, relative) : root
  // 越界保护:renderer 传什么都不该能读到工作目录之外。
  if (!isInside(root, dir)) throw new Error("路径越界")

  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => !IGNORED.has(entry.name) && !entry.name.startsWith("."))
    .map((entry) => ({
      path: path.relative(root, path.join(dir, entry.name)),
      name: entry.name,
      type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
}

const MAX_READ_BYTES = 2 * 1024 * 1024

export async function readFile(file: string): Promise<{ content: string; mime: string; truncated: boolean }> {
  const stat = await fs.stat(file)
  const truncated = stat.size > MAX_READ_BYTES
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES))
    await handle.read(buffer, 0, buffer.length, 0)
    return { content: buffer.toString("utf8"), mime: mimeOf(file), truncated }
  } finally {
    await handle.close()
  }
}

/**
 * @提及用的文件搜索。
 *
 * 走一次广度优先遍历而不是 shell 出去调 fd/rg —— my-pi 的工具集里没有移植 find/ls
 * (它的 index.ts 注释写着"尚未移植:find、ls"),而打包后的 app 不能假设机器上有 fd。
 */
export async function searchFiles(directory: string, query: string, limit = 50): Promise<string[]> {
  const root = path.resolve(directory)
  const needle = query.toLowerCase()
  const out: string[] = []
  const queue: string[] = [root]
  let visited = 0

  while (queue.length && out.length < limit && visited < 20_000) {
    const dir = queue.shift()!
    let entries: import("node:fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (IGNORED.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
        continue
      }
      const rel = path.relative(root, full)
      if (!needle || rel.toLowerCase().includes(needle)) {
        out.push(rel)
        if (out.length >= limit) break
      }
    }
  }
  // 路径越短越可能是用户想要的那个。
  return out.sort((a, b) => a.length - b.length)
}

export async function vcsInfo(directory: string): Promise<VcsInfo> {
  try {
    const { stdout: root } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: directory })
    const { stdout: branch } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory })
    const { stdout: status } = await run("git", ["status", "--porcelain"], { cwd: directory })
    return { root: root.trim(), branch: branch.trim(), dirty: status.trim().length > 0 }
  } catch {
    // 不是 git 仓库不是错误 —— 固件工程经常就是一个裸目录。
    return { dirty: false }
  }
}

export async function vcsDiff(directory: string): Promise<FileDiff[]> {
  try {
    const { stdout } = await run("git", ["diff", "--numstat", "HEAD"], { cwd: directory })
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added, removed, file] = line.split("\t")
        return {
          path: file ?? "",
          added: Number(added) || 0,
          removed: Number(removed) || 0,
          status: "modified" as const,
        }
      })
      .filter((entry) => entry.path)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------

export interface ProjectEntry {
  directory: string
  lastOpened: number
}

/** 最近打开的目录。顶替 opencode 的 project/worktree 那一整面 —— my-pi 里一个会话就是一个 cwd。 */
export class ProjectStore {
  private entries: ProjectEntry[] = []

  constructor(private readonly file: string) {}

  async load(): Promise<ProjectEntry[]> {
    try {
      this.entries = JSON.parse(await fs.readFile(this.file, "utf8"))
    } catch {
      this.entries = []
    }
    return this.list()
  }

  list(): ProjectEntry[] {
    return [...this.entries].sort((a, b) => b.lastOpened - a.lastOpened)
  }

  async add(directory: string): Promise<ProjectEntry[]> {
    const resolved = path.resolve(directory)
    this.entries = this.entries.filter((entry) => entry.directory !== resolved)
    this.entries.push({ directory: resolved, lastOpened: Date.now() })
    await this.persist()
    return this.list()
  }

  async remove(directory: string): Promise<ProjectEntry[]> {
    const resolved = path.resolve(directory)
    this.entries = this.entries.filter((entry) => entry.directory !== resolved)
    await this.persist()
    return this.list()
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.entries, null, 2))
  }
}

// ---------------------------------------------------------------------------

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".json": "application/json",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".rs": "text/x-rust",
  ".py": "text/x-python",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ld": "text/plain",
  ".s": "text/x-asm",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/plain",
}

function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "text/plain"
}
