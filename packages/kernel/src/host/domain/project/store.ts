import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, writeFile, rename, rm, stat, realpath, lstat } from "node:fs/promises"
import path from "node:path"
import type { MemoryInput, ProjectBaseline, ProjectContextView, ProjectMemory, ProjectProfile } from "./model.ts"
import { detectProject } from "./detect.ts"

export const emptyProfile = (): ProjectProfile => ({
  name: "",
  chip: "",
  board: "",
  framework: "",
  buildCommand: "",
  firmware: "",
  probe: "",
  log: "",
  verification: "",
})
interface Stored {
  version: 1
  profile?: ProjectProfile
  memories: ProjectMemory[]
  forgotten: string[]
  baseline?: ProjectBaseline
}
const MAX_BYTES = 512 * 1024
const empty = (): Stored => ({ version: 1, memories: [], forgotten: [] })
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex")
const memoryKey = (title: string) => fingerprint(title.trim().normalize("NFKC").toLocaleLowerCase())
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT"

/** Respect the nearest project file or Git boundary, including .git worktree pointer files. */
export async function projectRoot(cwd: string): Promise<string> {
  const start = await realpath(cwd)
  if (!(await stat(start)).isDirectory()) throw new Error("工程路径不是目录")
  let dir = start
  for (;;) {
    for (const marker of [".yoma/project.json", ".yoma/knowledge/state.json", ".git"]) {
      try {
        await lstat(path.join(dir, marker))
        return dir
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}
const statePath = (root: string) => path.join(root, ".yoma", "knowledge", "state.json")

function field(value: unknown, label: string, max = 4000): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`无效的 ${label}（最多 ${max} 字符）`)
  return value.trim()
}
export function validateProfile(value: ProjectProfile): ProjectProfile {
  const result = emptyProfile()
  for (const key of Object.keys(result) as Array<keyof ProjectProfile>) result[key] = field(value?.[key], key)
  if (
    result.firmware &&
    (path.posix.isAbsolute(result.firmware) ||
      path.win32.isAbsolute(result.firmware) ||
      result.firmware.replaceAll("\\", "/").split("/").includes(".."))
  ) {
    throw new Error("固件路径必须相对工程根目录，不能包含 .. 或绝对路径")
  }
  return result
}
function validateMemory(input: MemoryInput): MemoryInput {
  const title = field(input?.title, "记忆标题", 160)
  const content = field(input?.content, "记忆内容", 6000)
  if (!title || !content) throw new Error("记忆标题和内容不能为空")
  if (!["fact", "experience", "handoff"].includes(input.kind)) throw new Error("未知记忆类型")
  if (!["verified", "hypothesis"].includes(input.confidence)) throw new Error("未知验证状态")
  const evidence = field(input.evidence, "依据", 2000)
  if (input.confidence === "verified" && !evidence) throw new Error("已验证的记忆必须填写依据")
  if (typeof input.enabled !== "boolean") throw new Error("enabled 必须为布尔值")
  const id = input.id === undefined ? undefined : field(input.id, "记忆 ID", 160)
  if (id === "") throw new Error("记忆 ID 不能为空")
  return {
    id,
    title,
    content,
    evidence,
    scope: field(input.scope, "适用范围", 500),
    kind: input.kind,
    confidence: input.confidence,
    enabled: input.enabled,
  }
}
async function boundedRead(file: string): Promise<string | undefined> {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error(`文件不是普通文件或超过 512 KB：${file}`)
    return await readFile(file, "utf8")
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}
async function load(root: string) {
  for (const folder of [path.join(root, ".yoma"), path.dirname(statePath(root))]) {
    try {
      if (!(await lstat(folder)).isDirectory()) throw new Error("项目数据目录必须为普通目录，不能是符号链接")
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  const profileText = await boundedRead(path.join(root, ".yoma", "project.json"))
  const stateText = await boundedRead(statePath(root))
  const state: Stored = stateText ? JSON.parse(stateText) : empty()
  if (
    state.version !== 1 ||
    !Array.isArray(state.memories) ||
    state.memories.length > 200 ||
    !Array.isArray(state.forgotten) ||
    !state.forgotten.every((x) => typeof x === "string")
  )
    throw new Error("项目记忆格式不受支持")
  for (const item of state.memories) {
    validateMemory(item)
    if (typeof item.id !== "string" || typeof item.updatedAt !== "string" || typeof item.source !== "string")
      throw new Error("项目记忆来源信息损坏")
  }
  if (new Set(state.memories.map((item) => item.id)).size !== state.memories.length) throw new Error("项目记忆 ID 重复")
  if (state.baseline) {
    const baseline = state.baseline
    validateProfile(baseline.profile)
    field(baseline.command, "构建命令")
    field(baseline.output, "构建输出", 16000)
    if (
      typeof baseline.ok !== "boolean" ||
      !Number.isInteger(baseline.exitCode) ||
      typeof baseline.checkedAt !== "string" ||
      (baseline.firmwareHash !== undefined && !/^[a-f0-9]{64}$/.test(baseline.firmwareHash))
    )
      throw new Error("构建记录损坏")
  }
  if (profileText) {
    const profile = JSON.parse(profileText)
    if (profile.version !== 1) throw new Error("工程档案版本不受支持")
    state.profile = validateProfile(profile.profile)
  } else {
    delete state.profile
  }
  return { state, revision: fingerprint((profileText ?? "") + "\n" + (stateText ?? "")) }
}
export async function inspectProject(cwd: string, detect = true): Promise<ProjectContextView> {
  const root = await projectRoot(cwd)
  try {
    const { state, revision } = await load(root)
    const detected = detect
      ? await detectProject(root)
      : { profile: state.profile ?? { ...emptyProfile(), name: path.basename(root) }, files: [], warnings: [] }
    return {
      root,
      revision,
      profile: state.profile ?? detected.profile,
      saved: !!state.profile,
      detectedFrom: detected.files,
      memories: state.memories,
      baseline: state.baseline,
      warnings: detected.warnings,
    }
  } catch (error) {
    return {
      root,
      revision: "",
      profile: emptyProfile(),
      saved: false,
      detectedFrom: [],
      memories: [],
      warnings: [`读取项目档案/记忆失败，原文件未修改：${String(error)}`],
    }
  }
}
async function atomicWrite(file: string, value: unknown) {
  const text = JSON.stringify(value, null, 2) + "\n"
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("项目记忆超过 512 KB，请清理旧条目")
  const tmp = file + "." + randomUUID() + ".tmp"
  try {
    const handle = await open(tmp, "wx", 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Windows antivirus may temporarily hold the destination; never unlink the original.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file)
        break
      } catch (error) {
        if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error
        await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)))
      }
    }
  } finally {
    await rm(tmp, { force: true })
  }
}
/** One lock covers both files and all processes. An abandoned lock is recovered only for a dead owner. */
async function locked<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const dir = path.dirname(statePath(root))
  for (const folder of [path.join(root, ".yoma"), dir]) {
    await mkdir(folder, { recursive: true })
    if ((await lstat(folder)).isSymbolicLink()) throw new Error("项目数据目录不能是符号链接")
  }
  try {
    await writeFile(path.join(dir, ".gitignore"), "*\n", { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  const lock = path.join(dir, ".write-lock")
  let acquired = false
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await mkdir(lock)
      acquired = true
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        const pid = Number(await readFile(path.join(lock, "pid"), "utf8"))
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0)
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH") await rm(lock, { recursive: true, force: true })
          }
        }
      } catch {
        /* another writer is still creating/releasing the lock */
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  if (!acquired) throw new Error("项目记忆正在被另一个进程更新，请稍后重试")
  try {
    await writeFile(path.join(lock, "pid"), String(process.pid))
    return await fn()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}
async function mutate(cwd: string, revision: string, change: (state: Stored, root: string) => Promise<void>) {
  const root = await projectRoot(cwd)
  await locked(root, async () => {
    const loaded = await load(root)
    if (!revision || revision !== loaded.revision)
      throw new Error("工程档案或记忆已变化，请刷新后重试；没有覆盖其他修改")
    await change(loaded.state, root)
  })
  return inspectProject(root)
}
export async function saveProfile(cwd: string, revision: string, profile: ProjectProfile) {
  const clean = validateProfile(profile)
  return mutate(cwd, revision, async (_state, root) => {
    await atomicWrite(path.join(root, ".yoma", "project.json"), { version: 1, profile: clean })
  })
}
export async function saveMemory(cwd: string, revision: string, input: MemoryInput, source: string) {
  const clean = validateMemory(input)
  return mutate(cwd, revision, async (state, root) => {
    const key = memoryKey(clean.title)
    const index = state.memories.findIndex((item) => item.id === clean.id)
    if (clean.id && index < 0) throw new Error("这条记忆已删除，请刷新")
    if (state.memories.some((item, i) => i !== index && memoryKey(item.title) === key))
      throw new Error("同名记忆已存在，请读取并更新原条目")
    if (source !== "user" && state.forgotten.includes(key)) throw new Error("用户已删除这条记忆，不能自动重新创建")
    if (index >= 0 && source !== "user" && !state.memories[index].enabled && clean.enabled)
      throw new Error("用户停用的记忆不能由 agent 重新启用")
    if (index < 0 && state.memories.length >= 200) throw new Error("项目记忆已满 200 条，请更新或清理已有条目")
    const item: ProjectMemory = { ...clean, id: clean.id ?? randomUUID(), updatedAt: new Date().toISOString(), source }
    if (index < 0) state.memories.push(item)
    else state.memories[index] = item
    if (source === "user") state.forgotten = state.forgotten.filter((x) => x !== key)
    await atomicWrite(statePath(root), { ...state, profile: undefined })
  })
}
export async function forgetMemory(cwd: string, revision: string, id: string) {
  return mutate(cwd, revision, async (state, root) => {
    const item = state.memories.find((entry) => entry.id === id)
    if (!item) throw new Error("记忆不存在或已删除")
    state.forgotten = [...new Set([...state.forgotten, memoryKey(item.title)])]
    state.memories = state.memories.filter((entry) => entry.id !== id)
    await atomicWrite(statePath(root), { ...state, profile: undefined })
  })
}
export async function recordBaseline(cwd: string, profile: ProjectProfile, baseline: ProjectBaseline) {
  const root = await projectRoot(cwd)
  await locked(root, async () => {
    const { state } = await load(root)
    if (JSON.stringify(state.profile) !== JSON.stringify(profile))
      throw new Error("构建期间配置已变化，未将结果记录为当前基线")
    state.baseline = baseline
    await atomicWrite(statePath(root), { ...state, profile: undefined })
  })
  return inspectProject(root)
}
