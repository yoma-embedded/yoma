import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs, promisify } from "node:util"
import {
  checkProtectedFiles, inUpstreamScope, parseUpstreamLock, readProjectFile, safeProjectPath, sha256,
  UPSTREAM_MANIFESTS, UPSTREAM_SCOPES, validateRelativePath, type UpstreamLock,
} from "./upstream-common.ts"

const execute = promisify(execFile)
type GitFile = { bytes: Buffer; mode: number }
export type SyncChange = { path: string; kind: "add" | "modify" | "delete" }
export interface SyncPlan {
  projectRoot: string
  source: string
  from: string
  to: string
  changes: SyncChange[]
  manifestChanges: string[]
  modelDataChanges: string[]
  previousLockText: string
  previousLock: UpstreamLock
  nextLock: UpstreamLock
  files: Map<string, GitFile>
}

async function git(source: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execute("git", ["--no-optional-locks", "-C", source, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

async function resolveCommit(source: string, ref: string): Promise<string> {
  if (!ref.trim() || ref.startsWith("-") || /[\x00-\x20\x7f]/.test(ref)) throw new Error("--ref 必须是非空 Git commit/ref，不能包含选项或控制字符")
  const sha = (await git(source, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).toString("utf8").trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error(`没有解析到完整 commit SHA：${ref}`)
  return sha
}

async function snapshot(source: string, commit: string, blobs: Map<string, Buffer>): Promise<Map<string, GitFile>> {
  const tree = await git(source, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...UPSTREAM_SCOPES])
  if (!Buffer.from(tree.toString("utf8")).equals(tree)) throw new Error("目标 Git 路径不是有效 UTF-8，拒绝有损路径转换")
  const files = new Map<string, GitFile>()
  for (const record of tree.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(record)
    if (!match) throw new Error(`拒绝上游符号链接、子模块或不支持的 Git 条目：${record}`)
    const mode = match[1]!, blobId = match[2]!, path = match[3]!
    validateRelativePath(path)
    if (!inUpstreamScope(path)) throw new Error(`上游条目越出同步范围：${path}`)
    let bytes = blobs.get(blobId)
    if (!bytes) { bytes = await git(source, ["cat-file", "blob", blobId]); blobs.set(blobId, bytes) }
    files.set(path, { bytes, mode: mode === "100755" ? 0o755 : 0o644 })
  }
  return files
}

function checkBaseline(lock: UpstreamLock, files: Map<string, GitFile>): void {
  const errors: string[] = []
  for (const [path, hash] of Object.entries(lock.sha256)) {
    const file = files.get(path)
    if (!file || sha256(file.bytes) !== hash) errors.push(`旧锁与 ${lock.commit} 的 Git 对象不一致：${path}`)
  }
  for (const path of files.keys()) if (!(path in lock.sha256)) errors.push(`旧锁遗漏该上游提交内的受保护文件：${path}`)
  if (errors.length) throw new Error(errors.join("\n"))
}

export async function prepareSync(options: { projectRoot: string; source?: string; ref?: string }): Promise<SyncPlan> {
  const sourceInput = options.source ?? join(options.projectRoot, "../pi")
  if (!sourceInput.trim() || /[\x00-\x1f\x7f]/.test(sourceInput)) throw new Error("--source 必须是非空本地 Git 仓库路径")
  const projectRoot = await realpath(options.projectRoot)
  const previousLockText = (await readProjectFile(projectRoot, "upstream-lock.json")).toString("utf8")
  const previousLock = parseUpstreamLock(previousLockText)
  const failures = await checkProtectedFiles(projectRoot, previousLock)
  if (failures.length) throw new Error(`本地保护文件不再等于旧锁；停止同步，保留你的改动：\n${failures.join("\n")}`)
  const source = await realpath(sourceInput)
  // Resolve both once. All subsequent reads use immutable commits/blob IDs, never the working tree.
  const to = await resolveCommit(source, options.ref ?? "HEAD")
  const from = await resolveCommit(source, previousLock.commit)
  const blobs = new Map<string, Buffer>()
  const before = await snapshot(source, from, blobs)
  checkBaseline(previousLock, before)
  const files = await snapshot(source, to, blobs)
  if (!files.size) throw new Error("目标提交的同步范围为空，拒绝清空本地核心")
  for (const path of Object.keys(previousLock.generatedSnapshot?.sha256 ?? {})) {
    if (files.has(path)) throw new Error(`目标 Git 已开始跟踪生成快照路径，需要先人工处理来源交接：${path}`)
  }
  const manifestChanges: string[] = []
  let version = previousLock.version
  for (const path of UPSTREAM_MANIFESTS) {
    const oldBytes = await git(source, ["show", `${from}:${path}`])
    const newBytes = await git(source, ["show", `${to}:${path}`])
    if (!oldBytes.equals(newBytes)) manifestChanges.push(path)
    if (path === "packages/ai/package.json") {
      const manifest: unknown = JSON.parse(newBytes.toString("utf8"))
      if (!manifest || typeof manifest !== "object" || typeof (manifest as { version?: unknown }).version !== "string") throw new Error("目标 pi-ai package.json 没有有效 version")
      version = (manifest as { version: string }).version
    }
  }
  const changes: SyncChange[] = []
  for (const path of [...new Set([...before.keys(), ...files.keys()])].sort()) {
    const previous = before.get(path)
    const next = files.get(path)
    if (!previous) changes.push({ path, kind: "add" })
    else if (!next) changes.push({ path, kind: "delete" })
    else if (!previous.bytes.equals(next.bytes) || previous.mode !== next.mode) changes.push({ path, kind: "modify" })
  }
  const hashes = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, file]) => [path, sha256(file.bytes)]))
  const nextLock: UpstreamLock = { ...previousLock, commit: to, version, sha256: hashes }
  parseUpstreamLock(JSON.stringify(nextLock))
  const modelDataChanges = changes.map(({ path }) => path).filter((path) => path === "packages/ai/src/models.generated.ts" || /^packages\/ai\/src\/providers\/[^/]+\.models\.ts$/.test(path))
  return { projectRoot, source, from, to, changes, manifestChanges, modelDataChanges, previousLockText, previousLock, nextLock, files }
}

/** Each replacement uses rename; the whole set is NOT atomic. Keep the old lock until every file succeeds. */
async function replaceFile(root: string, path: string, bytes: Buffer, mode = 0o644): Promise<void> {
  const destination = await safeProjectPath(root, path)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.upstream-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, "wx", mode)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await safeProjectPath(root, path)
    await rename(temporary, destination)
  } finally {
    await handle?.close()
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
  }
}

export async function applySync(plan: SyncPlan, options: { packagesReviewed?: string; modelDataReviewed?: string } = {}): Promise<void> {
  if (plan.manifestChanges.length && options.packagesReviewed !== plan.to) {
    throw new Error(`上游 package.json 已变化：${plan.manifestChanges.join(", ")}。先人工核对并适配本地 manifest/catalog，再传 --packages-reviewed ${plan.to}；工具不会覆盖本地 package.json。`)
  }
  if (options.packagesReviewed !== undefined && options.packagesReviewed !== plan.to) throw new Error("--packages-reviewed 必须精确等于本次目标的完整 SHA")
  if (plan.previousLock.generatedSnapshot && plan.modelDataChanges.length && options.modelDataReviewed !== plan.to) {
    throw new Error(`上游模型结构已变化：${plan.modelDataChanges.join(", ")}。请先另外准备匹配的数据快照或验证现有快照兼容，再传 --model-data-reviewed ${plan.to}；工具不生成或更新模型数据。`)
  }
  if (options.modelDataReviewed !== undefined && options.modelDataReviewed !== plan.to) throw new Error("--model-data-reviewed 必须精确等于本次目标的完整 SHA")
  // Prepare and validate the complete next lock and file contents before touching protected files.
  const lockText = `${JSON.stringify(parseUpstreamLock(JSON.stringify(plan.nextLock)), null, 2)}\n`
  for (const [path, hash] of Object.entries(plan.nextLock.sha256)) {
    const file = plan.files.get(path)
    if (!file || sha256(file.bytes) !== hash) throw new Error(`同步计划内容与新锁不一致：${path}`)
  }
  const guardPath = await safeProjectPath(plan.projectRoot, ".upstream-sync.lock")
  const guard = await open(guardPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("已有同步正在运行或异常退出留下 .upstream-sync.lock；确认其 PID 已退出后再移除该锁")
    throw error
  })
  try {
    await guard.writeFile(`pid=${process.pid}\nfrom=${plan.from}\nto=${plan.to}\n`)
    if ((await readProjectFile(plan.projectRoot, "upstream-lock.json")).toString("utf8") !== plan.previousLockText) throw new Error("预览后旧锁已变化；请重新生成同步计划")
    const failures = await checkProtectedFiles(plan.projectRoot, plan.previousLock)
    if (failures.length) throw new Error(`预览后本地内容已变化；停止同步：\n${failures.join("\n")}`)
    for (const change of plan.changes) {
      validateRelativePath(change.path)
      if (!inUpstreamScope(change.path)) throw new Error(`同步计划越出保护范围：${change.path}`)
      const destination = await safeProjectPath(plan.projectRoot, change.path)
      const expected = plan.previousLock.sha256[change.path]
      if (expected !== undefined) {
        if (sha256(await readProjectFile(plan.projectRoot, change.path)) !== expected) throw new Error(`写入前文件再次变化：${change.path}`)
      } else {
        try { await lstat(destination); throw new Error(`新增目标已存在：${change.path}`) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      }
      if (change.kind === "delete") await unlink(destination)
      else {
        const file = plan.files.get(change.path)
        if (!file) throw new Error(`同步计划缺少文件：${change.path}`)
        await replaceFile(plan.projectRoot, change.path, file.bytes, file.mode)
      }
    }
    const finalFailures = await checkProtectedFiles(plan.projectRoot, plan.nextLock)
    if (finalFailures.length) throw new Error(`写入后验证失败，旧锁保持不变：\n${finalFailures.join("\n")}`)
    await replaceFile(plan.projectRoot, "upstream-lock.json", Buffer.from(lockText))
  } finally {
    await guard.close()
    await unlink(guardPath)
  }
}

export function formatSyncPlan(plan: SyncPlan): string {
  const counts = { add: 0, modify: 0, delete: 0 }
  for (const change of plan.changes) counts[change.kind]++
  return [
    `FROM ${plan.from}`, `TO   ${plan.to}`,
    ...plan.changes.map((change) => `${change.kind.toUpperCase()}\t${change.path}`),
    ...plan.manifestChanges.map((path) => `PACKAGE_REVIEW\t${path}`),
    ...(plan.previousLock.generatedSnapshot ? plan.modelDataChanges.map((path) => `MODEL_DATA_REVIEW\t${path}`) : []),
    `SUMMARY ${JSON.stringify({ ...counts, packages: plan.manifestChanges.length, protectedFiles: plan.files.size, retainedGeneratedFiles: Object.keys(plan.previousLock.generatedSnapshot?.sha256 ?? {}).length })}`,
    ...(plan.manifestChanges.length ? [`先核对并适配本地 manifest/catalog；完成后使用 --packages-reviewed ${plan.to}。`] : []),
    ...(plan.previousLock.generatedSnapshot && plan.modelDataChanges.length ? [`先验证生成数据兼容性；完成后使用 --model-data-reviewed ${plan.to}。`] : []),
  ].join("\n")
}

const HELP = `用法：npm run upstream:diff -- [--source <本地pi仓库>] [--ref <commit/ref>] [--apply] [--packages-reviewed <完整目标SHA>] [--model-data-reviewed <完整目标SHA>]
默认 --source 为工程旁的 ../pi，--ref HEAD；默认只预览。只读取 Git 对象，不 fetch、不复制工作树、不提交代码。
--apply 逐文件写入并最后更新锁；多文件更新不是原子事务，中途失败需要检查工作树和旧锁。
上游四个 package.json 有变化时，先人工适配本地配置，再用精确目标 SHA 确认已核对。\n`

export async function runSyncCli(args: string[], projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))): Promise<void> {
  const { values } = parseArgs({ args, options: { source: { type: "string" }, ref: { type: "string" }, apply: { type: "boolean" }, "packages-reviewed": { type: "string" }, "model-data-reviewed": { type: "string" }, help: { type: "boolean", short: "h" } } })
  if (values.help) { process.stdout.write(HELP); return }
  const plan = await prepareSync({ projectRoot, source: values.source, ref: values.ref })
  process.stdout.write(`${formatSyncPlan(plan)}\n`)
  if (values.apply) {
    await applySync(plan, { packagesReviewed: values["packages-reviewed"], modelDataReviewed: values["model-data-reviewed"] })
    process.stdout.write(`APPLIED ${plan.to}\n`)
  } else process.stdout.write("PREVIEW_ONLY：没有写入文件；确认后加 --apply。\n")
}

if ("main" in import.meta && import.meta.main) {
  await runSyncCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
