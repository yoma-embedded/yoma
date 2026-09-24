/**
 * `npm run trace` 找文件的那一半(docs/调试留痕-规划-20260924.md §3.6):会话在哪、轨迹在哪、有哪些子 agent 会话。
 * 分析本身在 `@yoma-desktop/kernel/host/trace-report`。全部只读。
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/** 桌面端的 userData:三个渠道各一个(appId 定目录,见 desktop 的 main/index.ts)。 */
export function userDataRoots(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const base =
    platform === "win32"
      ? (env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"))
      : platform === "darwin"
        ? path.join(homedir(), "Library", "Application Support")
        : (env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"))
  return ["com.yoma.desktop", "com.yoma.desktop.dev", "com.yoma.desktop.beta"]
    .map((name) => path.join(base, name))
    .filter((dir) => existsSync(dir))
}

export interface SessionFile {
  file: string
  /** 它所在的 userData(`<root>/sessions/<工程>/<会话>.jsonl`);找轨迹用。 */
  root: string
  mtimeMs: number
}

/** 一个 userData 下的全部会话文件(`sessions/<工程目录>/*.jsonl`,两层)。 */
export function sessionFiles(root: string): SessionFile[] {
  const sessions = path.join(root, "sessions")
  if (!existsSync(sessions)) return []
  const out: SessionFile[] = []
  for (const project of readdirSync(sessions)) {
    const dir = path.join(sessions, project)
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue
      const file = path.join(dir, name)
      const stat = statSync(file, { throwIfNoEntry: false })
      if (stat?.isFile()) out.push({ file, root, mtimeMs: stat.mtimeMs })
    }
  }
  return out
}

/**
 * 按参数找会话:给了存在的文件路径就用它;否则当成会话 id(或前缀),在所有 userData 里找文件名含它的;
 * 什么都没给就取最近改过的那一个。
 */
export function findSession(arg: string | undefined, roots: string[]): SessionFile | undefined {
  if (arg && statSync(arg, { throwIfNoEntry: false })?.isFile()) {
    const file = path.resolve(arg)
    return { file, root: path.resolve(file, "..", "..", ".."), mtimeMs: statSync(file).mtimeMs }
  }
  const all = roots.flatMap((root) => sessionFiles(root))
  const candidates = arg ? all.filter((entry) => path.basename(entry.file).includes(arg)) : all
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
}

/** 同一 userData 下各次启动的轨迹:`logs/<启动时间>/trace.jsonl` 与轮转出来的 `trace.1.jsonl`。 */
export function traceFiles(root: string): string[] {
  const logs = path.join(root, "logs")
  if (!existsSync(logs)) return []
  const out: string[] = []
  for (const run of readdirSync(logs)) {
    const dir = path.join(logs, run)
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const name of ["trace.1.jsonl", "trace.jsonl"]) {
      const file = path.join(dir, name)
      if (existsSync(file)) out.push(file)
    }
  }
  return out
}

/** 会话文件的第一行(文件头)。只读开头,不读整个几 MB 的会话。 */
export function readHeader(file: string): Record<string, unknown> | undefined {
  const fd = openSync(file, "r")
  try {
    const buffer = Buffer.alloc(4096)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytes).toString("utf8")
    const line = text.split("\n")[0] ?? ""
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/** 这个会话派出的子 agent 会话:同一个工程目录下,文件头的 parentSessionId 指着它。 */
export function childSessions(sessionFile: string, sessionID: string): Array<{ id: string; file: string }> {
  const dir = path.dirname(sessionFile)
  const out: Array<{ id: string; file: string }> = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue
    const file = path.join(dir, name)
    const header = readHeader(file)
    if (header?.parentSessionId === sessionID && typeof header.id === "string") out.push({ id: header.id, file })
  }
  return out
}
