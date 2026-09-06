/**
 * 与内核无关的宿主服务:文件浏览、@提及搜索、git 状态、最近项目。
 *
 * 这些在 opencode 那边是后端路由,现在是 host 里的纯 Node 函数。没有一行碰 yoma ——
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

/**
 * 读工作目录内的一个文件。`file` 是相对 `directory` 的路径(file.list 交出的就是这种),
 * 绝对路径也收,但必须落在 `directory` 之内。
 *
 * 绝不能拿相对路径直接 stat:内核只有一个进程、服务多个项目,它的 cwd(桌面端里是
 * homedir)不可能是任何项目根 —— 2026-09-06 之前就是这么写的,表现为文件树列得出来、
 * 点开每个文件都是 ENOENT,路径全落在 ~/ 下面。
 */
export async function readFile(
  directory: string,
  file: string,
): Promise<{ content: string; mime: string; truncated: boolean }> {
  const root = path.resolve(directory)
  const target = path.resolve(root, file)
  if (!isInside(root, target)) throw new Error("路径越界")

  const stat = await fs.stat(target)
  const truncated = stat.size > MAX_READ_BYTES
  const handle = await fs.open(target, "r")
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES))
    await handle.read(buffer, 0, buffer.length, 0)
    return { content: buffer.toString("utf8"), mime: mimeOf(target), truncated }
  } finally {
    await handle.close()
  }
}

/**
 * @提及用的文件搜索。
 *
 * 走一次广度优先遍历而不是 shell 出去调 fd/rg —— yoma 的工具集里没有移植 find/ls
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

/** 所有 git 调用共用:路径不转义(中文文件名原样输出),缓冲放大到装得下整仓的全上下文 diff。 */
const GIT_CONFIG = ["-c", "core.quotePath=false"]
const GIT_MAX_BUFFER = 64 * 1024 * 1024

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", [...GIT_CONFIG, ...args], { cwd, maxBuffer: GIT_MAX_BUFFER })
  return stdout
}

export async function vcsInfo(directory: string): Promise<VcsInfo> {
  let root: string
  try {
    root = (await git(directory, ["rev-parse", "--show-toplevel"])).trim()
  } catch {
    // 不是 git 仓库不是错误 —— 固件工程经常就是一个裸目录。
    return { dirty: false }
  }
  // 刚 git init 的仓库没有 HEAD:rev-parse HEAD 会失败,但 root 和分支名都在。从前这里整段一起
  // try,于是"刚建的仓库"在前端看来等于"不是仓库",创建按钮按了像没反应。
  const branch = await git(directory, ["symbolic-ref", "--short", "-q", "HEAD"])
    .then((out) => out.trim())
    .catch(() => git(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).then((out) => out.trim()))
    .catch(() => undefined)
  const hasHead = await git(directory, ["rev-parse", "--verify", "-q", "HEAD"]).then(
    () => true,
    () => false,
  )
  const status = await git(directory, ["status", "--porcelain"]).catch(() => "")
  const info: VcsInfo = { root, dirty: status.trim().length > 0 }
  if (branch) info.branch = branch
  if (!hasHead) info.empty = true
  return info
}

/**
 * 非 git 目录的审查页引导:就地 git init,再回同 vcsInfo 的结果(此时 empty:true,要先做一次提交)。
 * 只 init 不提交 —— 替用户把整个目录 add 进去太越界(没有 .gitignore 的固件工程会连 build/ 一起收),
 * 上游 opencode 的 initGit 也只做这一步。刻意不吞错:机器上没有 git 才会失败,得让用户看见原因。
 */
export async function vcsInit(directory: string): Promise<VcsInfo> {
  await git(directory, ["init", "--quiet"])
  return vcsInfo(directory)
}

/** 全上下文:审查面板要从 patch 还原出整份改动前/改动后的文本(session-diff 的 completePatchContents)。 */
const FULL_CONTEXT = 1_000_000
/** 超过这个数只列文件不带 patch:审查页本来就按需展开,一次拉几百份全文 diff 只会卡住内核进程。 */
const MAX_PATCHES = 200
/** 同时在飞的 git 子进程数。 */
const GIT_CONCURRENCY = 8

/**
 * 工作区相对 HEAD 的改动。每一项都带全上下文的 patch,否则审查面板列得出文件、展开却是空的
 * (它靠 patch 还原前后文本,不另请求;2026-09-06 之前就是这样)。未跟踪的新文件也算 ——
 * agent 用 write 新建的文件正是最该被审查的那种,而 git diff 天然不列它们。
 */
export async function vcsDiff(directory: string): Promise<FileDiff[]> {
  // --relative:git 默认按仓库根报路径,项目目录是仓库子目录时前端拿它去拼 file.read 会多一层;
  // 相对当前目录之后顺带只列这个目录下的改动,正是项目视图要的范围。
  // --no-renames:改名拆成删 + 增,路径永远一个文件一条,不用解析 "{old => new}"。
  const common = ["--no-ext-diff", "--no-renames", "--relative"]
  const tracked = await git(directory, ["diff", "--numstat", ...common, "HEAD"])
    .then((out) => out.split("\n").filter(Boolean))
    // 没有 HEAD(刚 init)或根本不是仓库:没有可比的基线。
    .catch(() => [] as string[])
  const untracked = await git(directory, ["ls-files", "--others", "--exclude-standard"])
    .then((out) => out.split("\n").filter(Boolean))
    .catch(() => [] as string[])

  const out: FileDiff[] = []
  for (const line of tracked) {
    const [added, removed, file] = line.split("\t")
    if (!file) continue
    out.push({ path: file, added: Number(added) || 0, removed: Number(removed) || 0, status: "modified" })
  }
  for (const file of untracked) out.push({ path: file, added: 0, removed: 0, status: "added" })

  await mapLimit(out.slice(0, MAX_PATCHES), GIT_CONCURRENCY, async (entry) => {
    const patch =
      entry.status === "added"
        ? await untrackedPatch(directory, entry.path)
        : await git(directory, ["diff", `--unified=${FULL_CONTEXT}`, ...common, "HEAD", "--", entry.path]).catch(
            () => undefined,
          )
    if (!patch) return
    entry.patch = patch
    if (entry.status === "added") entry.added = countAdded(patch)
    else if (/^deleted file mode /m.test(patch)) entry.status = "deleted"
    else if (/^new file mode /m.test(patch)) entry.status = "added"
  })
  return out
}

/**
 * 未跟踪文件没有基线,拿 --no-index 对着 /dev/null 生成 patch(Git for Windows 认这个名字)。
 * git 在有差异时退出码是 1 —— 那是正常路径,patch 就在 stdout 里,不是错误。
 */
async function untrackedPatch(cwd: string, file: string): Promise<string | undefined> {
  const args = [...GIT_CONFIG, "diff", "--no-index", "--no-ext-diff", `--unified=${FULL_CONTEXT}`, "--", "/dev/null", file]
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: GIT_MAX_BUFFER })
    return stdout || undefined
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout
    return typeof stdout === "string" && stdout.startsWith("diff --git") ? stdout : undefined
  }
}

/** 新文件的行数就是 patch 里的 + 行数(二进制文件没有 hunk,自然是 0)。 */
function countAdded(patch: string): number {
  let count = 0
  for (const line of patch.split("\n")) if (line.startsWith("+") && !line.startsWith("+++")) count += 1
  return count
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!)
  })
  await Promise.all(workers)
}

// ---------------------------------------------------------------------------

export interface ProjectEntry {
  directory: string
  lastOpened: number
}

/** 最近打开的目录。顶替 opencode 的 project/worktree 那一整面 —— yoma 里一个会话就是一个 cwd。 */
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
