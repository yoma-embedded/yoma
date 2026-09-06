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

import type { FileDiff, FileEntry, VcsGroup, VcsInfo } from "../types.ts"

const run = promisify(execFile)

/**
 * 文件树的隐藏名单 = VS Code `files.exclude` 的默认值。其余一律显示 —— node_modules、点文件都显示,
 * 被 gitignore 的条目带 `ignored` 标记交给前端灰显,和 VS Code 资源管理器一致。
 * 从前多藏了 node_modules / dist / out 和所有点文件,用户在 VS Code 里看得见的目录到这里是空的(2026-09-06)。
 */
const TREE_HIDDEN = new Set([".git", ".svn", ".hg", "CVS", ".DS_Store", "Thumbs.db"])

/** @提及搜索跳过的目录:VS Code 的 search.exclude 也默认排除 node_modules;点开头的目录同样跳过(.yoma 运行产物不该进候选)。 */
const SEARCH_SKIP = new Set([...TREE_HIDDEN, "node_modules", ".venv", "target", "dist", "out", ".turbo", "__pycache__"])

export async function listFiles(directory: string, relative?: string): Promise<FileEntry[]> {
  const root = path.resolve(directory)
  const dir = relative ? path.resolve(root, relative) : root
  // 越界保护:renderer 传什么都不该能读到工作目录之外。
  if (!isInside(root, dir)) throw new Error("路径越界")

  const entries = (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => !TREE_HIDDEN.has(entry.name))
  const ignored = await gitIgnored(
    dir,
    entries.map((entry) => entry.name),
  )
  return entries
    .map((entry) => {
      const item: FileEntry = {
        path: path.relative(root, path.join(dir, entry.name)),
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }
      if (ignored.has(entry.name)) item.ignored = true
      return item
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
}

/**
 * 这一层里哪些名字被 gitignore 了 —— 一次 `check-ignore --stdin` 查完整层。
 * 退出码 1 只是"没有一个被忽略",128 是不在仓库里(或机器上没有 git),都当作"没有忽略项"。
 */
function gitIgnored(dir: string, names: string[]): Promise<Set<string>> {
  return new Promise((resolve) => {
    if (names.length === 0) return resolve(new Set())
    const child = execFile(
      "git",
      [...GIT_CONFIG, "check-ignore", "--stdin", "-z"],
      { cwd: dir, maxBuffer: GIT_MAX_BUFFER },
      (_error, stdout) => resolve(new Set(String(stdout ?? "").split("\0").filter(Boolean))),
    )
    // git 早退(不在仓库里)时再写 stdin 会 EPIPE,吞掉即可。
    child.stdin?.on("error", () => {})
    child.stdin?.end(names.map((name) => `${name}\0`).join(""))
  })
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
      if (SEARCH_SKIP.has(entry.name) || entry.name.startsWith(".")) continue
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
/** 列表上限:没写 .gitignore 的工程能有几千个未跟踪文件,全列只会把面板卡死。 */
const MAX_ENTRIES = 500
/** 同时在飞的 git 子进程数。 */
const GIT_CONCURRENCY = 8
/** 分组顺序照 VS Code:合并冲突、暂存的更改、更改、未跟踪。 */
const GROUP_ORDER: Record<VcsGroup, number> = { conflict: 0, staged: 1, changes: 2, untracked: 3 }

interface StatusEntry {
  path: string
  group: VcsGroup
  letter: string
  status: FileDiff["status"]
  origPath?: string
  /** patch 和行数对着谁算:HEAD→工作树、HEAD→暂存区、还是没有基线(未跟踪)。 */
  base: "head" | "index" | "none"
}

/**
 * 审查页的数据源,与 VS Code 源代码管理视图同源:`git status --porcelain=v2`,按它的四个分组、
 * 它的单字母状态。每一项带全上下文 patch(面板靠它还原前后文本,不另请求;没有它列表能出、
 * 展开却是空的),未跟踪的新文件也算 —— agent 用 write 新建的文件正是最该被审查的那种。
 *
 * 与 VS Code 的两处刻意差异:范围按**项目目录**而不是仓库根(列出的文件都在项目内,点开能直接
 * 进文件页);同一文件既暂存又有未暂存改动时只列一次归"更改",diff 是 HEAD→工作树的合并视图。
 */
export async function vcsDiff(directory: string): Promise<FileDiff[]> {
  // 项目目录相对仓库根的前缀(仓库根时为空串)。porcelain 的路径永远相对仓库根,要自己剥。
  const prefix = await git(directory, ["rev-parse", "--show-prefix"])
    .then((out) => out.trim())
    .catch(() => undefined)
  if (prefix === undefined) return []
  // pathspec "." 把范围收到项目目录;--untracked-files=all 让未跟踪的文件逐个列出,而不是折成一个目录。
  const status = await git(directory, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", "."]).catch(
    () => "",
  )
  const entries = parseStatus(status, prefix)
    .sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.path.localeCompare(b.path))
    .slice(0, MAX_ENTRIES)

  // --relative:路径相对项目目录(前端拿它去拼 file.read);--no-renames:改名拆成删 + 增,路径永远一个文件一条。
  const common = ["--no-ext-diff", "--no-renames", "--relative"]
  const [headStat, indexStat] = await Promise.all([
    numstat(directory, ["diff", "--numstat", ...common, "HEAD"]),
    numstat(directory, ["diff", "--numstat", "--cached", ...common]),
  ])

  const out: FileDiff[] = entries.map((entry) => {
    const stat = (entry.base === "index" ? indexStat : headStat).get(entry.path)
    const diff: FileDiff = {
      path: entry.path,
      added: stat?.[0] ?? 0,
      removed: stat?.[1] ?? 0,
      status: entry.status,
      group: entry.group,
      letter: entry.letter,
    }
    if (entry.origPath) diff.origPath = entry.origPath
    return diff
  })

  await mapLimit(out.slice(0, MAX_PATCHES), GIT_CONCURRENCY, async (diff, index) => {
    const entry = entries[index]!
    const patch =
      entry.base === "none"
        ? await untrackedPatch(directory, diff.path)
        : await git(directory, [
            "diff",
            ...(entry.base === "index" ? ["--cached"] : []),
            `--unified=${FULL_CONTEXT}`,
            ...common,
            ...(entry.base === "head" ? ["HEAD"] : []),
            "--",
            diff.path,
          ]).catch(() => undefined)
    if (!patch) return
    diff.patch = patch
    if (entry.base === "none") diff.added = countAdded(patch)
  })
  return out
}

/**
 * 解析 `git status --porcelain=v2 -z`。条目以 NUL 分隔;改名条目(2)后面多跟一个 NUL 结尾的旧路径。
 * 字段按空格切,路径是最后一个字段之后的全部(路径里可以有空格)。
 */
export function parseStatus(text: string, prefix: string): StatusEntry[] {
  const tokens = text.split("\0")
  const out: StatusEntry[] = []
  const strip = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p)
  const statusOf = (letter: string): FileDiff["status"] =>
    letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "R" ? "renamed" : "modified"

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!token) continue
    const kind = token[0]
    if (kind === "?") {
      out.push({ path: strip(token.slice(2)), group: "untracked", letter: "U", status: "added", base: "none" })
      continue
    }
    if (kind !== "1" && kind !== "2" && kind !== "u") continue

    // 1: XY sub mH mI mW hH hI <path>            → 8 个字段后是路径
    // 2: XY sub mH mI mW hH hI Xscore <path>     → 9 个字段,下一 token 是旧路径
    // u: XY sub m1 m2 m3 mW h1 h2 h3 <path>      → 10 个字段
    const fields = kind === "1" ? 8 : kind === "2" ? 9 : 10
    const rawPath = nthRest(token, fields)
    if (rawPath === undefined) continue
    const path = strip(rawPath)
    const xy = token.slice(2, 4)
    const origPath = kind === "2" ? tokens[++i] : undefined

    if (kind === "u") {
      // 合并冲突:VS Code 的字母是 "!"。patch 对着 HEAD 算,冲突标记原样进 diff。
      out.push({ path, group: "conflict", letter: "!", status: "modified", base: "head" })
      continue
    }
    const x = xy[0] ?? "."
    const y = xy[1] ?? "."
    if (y !== ".") {
      // 工作树有改动(不管暂存区有没有):归"更改",diff 是 HEAD→工作树。
      out.push({ path, group: "changes", letter: y, status: statusOf(y), origPath, base: "head" })
    } else if (x !== ".") {
      // 只在暂存区:归"暂存的更改",diff 是 HEAD→暂存区。改名/复制的字母照 git 给的 R / C。
      out.push({ path, group: "staged", letter: x, status: statusOf(x), origPath, base: "index" })
    }
  }
  return out
}

/** 跳过前 n 个空格分隔的字段,返回其余(路径)。 */
function nthRest(token: string, n: number): string | undefined {
  let pos = 0
  for (let k = 0; k < n; k++) {
    const next = token.indexOf(" ", pos)
    if (next === -1) return undefined
    pos = next + 1
  }
  return token.slice(pos)
}

/** `git diff --numstat` → 路径 → [增, 删]。二进制是 "-",记 0;没有 HEAD(刚 init)时整张表为空。 */
async function numstat(directory: string, args: string[]): Promise<Map<string, [number, number]>> {
  const out = new Map<string, [number, number]>()
  const text = await git(directory, args).catch(() => "")
  for (const line of text.split("\n")) {
    const [added, removed, file] = line.split("\t")
    if (file) out.set(file, [Number(added) || 0, Number(removed) || 0])
  }
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

async function mapLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      await fn(items[index]!, index)
    }
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
