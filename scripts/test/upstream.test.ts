import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { applySync, MIRROR_DIRECTORY, prepareSync } from "../sync-upstream.ts"
import { checkProtectedFiles, parseUpstreamLock, sha256, type UpstreamLock } from "../upstream-common.ts"

const execute = promisify(execFile)

/**
 * 夹具仓库的 file:/// 地址。不许手拼 `file://${path}`:Windows 上拼出来的是 `file://C:\…`(两个斜杠、
 * 反斜杠),过不了 validateRepositoryUrl 的白名单 —— 这三条用例在 Windows 上因此一直是红的。
 */
function fileUrl(path: string): string {
  return pathToFileURL(path).href
}
const roots: string[] = []
const aiFile = "packages/ai/src/example.ts"
const generatedFile = "packages/ai/src/providers/data/faux.json"

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

async function fixture(generated = false) {
  const root = await mkdtemp(join(tmpdir(), "yoma-upstream-test-"))
  roots.push(root)
  const source = join(root, "pi")
  const projectRoot = join(root, "core")
  await mkdir(source)
  await mkdir(projectRoot)
  const git = async (...args: string[]) => (await execute("git", [
    "-c", "user.name=Upstream test", "-c", "user.email=upstream-test@example.invalid",
    "-c", "commit.gpgsign=false", "-C", source, ...args,
  ])).stdout.trim()
  await git("init", "--quiet", "--template=")
  const original = {
    [aiFile]: "original ai\n",
    "packages/agent/src/example.ts": "original agent\n",
    "packages/agent/test/example.test.ts": "original test\n",
    "packages/chord/src/example.ts": "original chord\n",
    "packages/telemetry/src/example.ts": "original telemetry\n",
    "packages/agent/scripts/generate-telemetry-docs.ts": "original generator\n",
  }
  for (const [path, content] of Object.entries(original)) {
    await put(source, path, content)
    await put(projectRoot, path, content)
  }
  for (const pkg of ["ai", "agent", "chord", "telemetry"]) {
    await put(source, `packages/${pkg}/package.json`, JSON.stringify({ name: pkg, version: "1.0.0" }))
  }
  await git("add", ".")
  await git("commit", "--quiet", "-m", "baseline")
  const from = await git("rev-parse", "HEAD")
  const lock: UpstreamLock = {
    repository: "local-test-fixture", commit: from, version: "1.0.0",
    sha256: Object.fromEntries(Object.entries(original).map(([path, content]) => [path, sha256(content)])),
  }
  if (generated) {
    await put(projectRoot, generatedFile, "{}\n")
    lock.generatedSnapshot = {
      kind: "pi-model-data", provenance: "test-generated-data",
      sha256: { [generatedFile]: sha256("{}\n") },
    }
  }
  await put(projectRoot, "upstream-lock.json", JSON.stringify(lock, null, 2) + "\n")
  await put(projectRoot, "packages/cli/src/index.ts", "local CLI must remain\n")
  const commit = async () => {
    await git("add", ".")
    await git("commit", "--quiet", "-m", "update")
    return git("rev-parse", "HEAD")
  }
  return { source, projectRoot, git, commit, lock, from, original }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** 把夹具仓库的 file:// 地址写进锁 —— 生产里那一格是 pi 的 https 地址。 */
async function pointLockAtRepository(projectRoot: string, repository: string): Promise<void> {
  const file = join(projectRoot, "upstream-lock.json")
  const lock = JSON.parse(await readFile(file, "utf8")) as UpstreamLock
  lock.repository = repository
  await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`)
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

describe("自管上游镜像(不依赖某台机器上的检出)", () => {
  it("不给 --source 时按锁里的仓库地址自己克隆,并在第二次运行时 fetch 到新提交", async () => {
    const { source, projectRoot, commit } = await fixture()
    await pointLockAtRepository(projectRoot, fileUrl(source))
    await put(source, aiFile, "upstream ai\n")
    const to = await commit()

    const plan = await prepareSync({ projectRoot })
    expect(plan.to).toBe(to)
    expect(await exists(join(projectRoot, MIRROR_DIRECTORY))).toBe(true)
    await applySync(plan)
    expect(await readFile(join(projectRoot, aiFile), "utf8")).toBe("upstream ai\n")

    // 第二次:上游又走了一步。镜像已经在了,必须 fetch 到新提交 —— 停在克隆那一刻的话,
    // 这个命令会永远报"已经是最新",而上游其实一直在走。
    await put(source, aiFile, "upstream ai 2\n")
    const next = await commit()
    const second = await prepareSync({ projectRoot })
    expect(second.to).toBe(next)
  })

  it("--offline 用已有镜像不联网:上游走了也看不见", async () => {
    const { source, projectRoot, commit } = await fixture()
    await pointLockAtRepository(projectRoot, fileUrl(source))
    await put(source, aiFile, "upstream ai\n")
    const first = await commit()
    expect((await prepareSync({ projectRoot })).to).toBe(first)

    await put(source, aiFile, "upstream ai 2\n")
    await commit()
    expect((await prepareSync({ projectRoot, offline: true })).to).toBe(first)
  })

  it("锁里的仓库地址不是 https/file 时拒绝 —— 它会被交给 git clone", async () => {
    const { projectRoot } = await fixture()
    // ext:: 这类地址能借 Git 传输层执行命令;夹具原本那个 "local-test-fixture" 也不是合法地址。
    await pointLockAtRepository(projectRoot, "ext::sh -c touch% /tmp/pwned")
    await expect(prepareSync({ projectRoot })).rejects.toThrow(/https:\/\/ 或 file:\/\/\//)
    await expect(prepareSync({ projectRoot })).rejects.toThrow(/repository/)
  })

  it("已有镜像指向别的上游时停下,不悄悄接着用", async () => {
    const { source, projectRoot, commit } = await fixture()
    await pointLockAtRepository(projectRoot, fileUrl(source))
    await put(source, aiFile, "upstream ai\n")
    await commit()
    await prepareSync({ projectRoot })
    // 换一个地址:同名目录里那份历史不再是锁说的那一份了。
    await pointLockAtRepository(projectRoot, fileUrl(`${source}-other`))
    await expect(prepareSync({ projectRoot })).rejects.toThrow(/与锁里的/)
  })

  it("--source 仍然可用,而且那条路一个字节都不下载", async () => {
    const { source, projectRoot, commit } = await fixture()
    await pointLockAtRepository(projectRoot, "file:///nonexistent-should-not-be-touched")
    await put(source, aiFile, "upstream ai\n")
    const to = await commit()
    const plan = await prepareSync({ projectRoot, source })
    expect(plan.to).toBe(to)
    expect(await exists(join(projectRoot, MIRROR_DIRECTORY))).toBe(false)
  })
})

describe("upstream synchronization", () => {
  it("previews without writes, then applies committed additions, modifications and deletions", async () => {
    const f = await fixture()
    await put(f.source, aiFile, "updated ai\n")
    await put(f.source, "packages/ai/test/event-stream.test.ts", "new test\n")
    await rm(join(f.source, "packages/agent/test/example.test.ts"))
    const target = await f.commit()
    await put(f.source, aiFile, "uncommitted edit\n")
    await put(f.source, "packages/ai/src/untracked.ts", "not part of commit\n")
    const plan = await prepareSync({ ...f, ref: target })
    expect(plan.changes.map(change => change.kind).sort()).toEqual(["add", "delete", "modify"])
    expect(await readFile(join(f.projectRoot, aiFile), "utf8")).toBe("original ai\n")
    expect(JSON.parse(await readFile(join(f.projectRoot, "upstream-lock.json"), "utf8")).commit).toBe(f.from)
    await applySync(plan)
    expect(await readFile(join(f.projectRoot, aiFile), "utf8")).toBe("updated ai\n")
    await expect(readFile(join(f.projectRoot, "packages/ai/src/untracked.ts"))).rejects.toThrow()
    await expect(readFile(join(f.projectRoot, "packages/agent/test/example.test.ts"))).rejects.toThrow()
    expect(await readFile(join(f.projectRoot, "packages/cli/src/index.ts"), "utf8")).toBe("local CLI must remain\n")
    expect(await checkProtectedFiles(f.projectRoot, plan.nextLock)).toEqual([])
    expect((await prepareSync({ ...f, ref: target })).changes).toEqual([])
  })

  it("rejects local edits and changes made after preview without overwriting them", async () => {
    const f = await fixture()
    const plan = await prepareSync(f)
    await put(f.projectRoot, aiFile, "local edit\n")
    await expect(prepareSync(f)).rejects.toThrow(/内容改变/)
    await expect(applySync(plan)).rejects.toThrow(/本地内容已变化/)
    expect(await readFile(join(f.projectRoot, aiFile), "utf8")).toBe("local edit\n")
  })

  it("checks the old Git objects even when the file and its lock hash were both changed", async () => {
    const f = await fixture()
    await put(f.projectRoot, aiFile, "forged local baseline\n")
    f.lock.sha256[aiFile] = sha256("forged local baseline\n")
    await put(f.projectRoot, "upstream-lock.json", JSON.stringify(f.lock))
    expect(await checkProtectedFiles(f.projectRoot, f.lock)).toEqual([])
    await expect(prepareSync(f)).rejects.toThrow(/旧锁与/)
  })

  it("refuses missing files and unmanaged additions in protected directories", async () => {
    const f = await fixture()
    await put(f.projectRoot, "packages/agent/src/unmanaged.ts", "keep my file\n")
    await expect(prepareSync(f)).rejects.toThrow(/未锁定的新增文件/)
    await rm(join(f.projectRoot, "packages/agent/src/unmanaged.ts"))
    await rm(join(f.projectRoot, aiFile))
    await expect(prepareSync(f)).rejects.toThrow(/缺失/)
  })

  it.skipIf(process.platform === "win32")("rejects local symlinks and upstream symlinks", async () => {
    const f = await fixture()
    await symlink(join(f.projectRoot, aiFile), join(f.projectRoot, "packages/agent/src/link.ts"))
    await expect(prepareSync(f)).rejects.toThrow(/符号链接/)
    await rm(join(f.projectRoot, "packages/agent/src/link.ts"))
    await symlink("example.ts", join(f.source, "packages/ai/src/link.ts"))
    const target = await f.commit()
    await expect(prepareSync({ ...f, ref: target })).rejects.toThrow(/符号链接/)
  })

  it("refuses unsafe lock paths and Git option injection", async () => {
    const f = await fixture()
    for (const path of ["../escape", "/absolute", "packages/ai/src/../../escape", "packages/cli/src/index.ts"]) {
      expect(() => parseUpstreamLock(JSON.stringify({ ...f.lock, sha256: { [path]: sha256("x") } }))).toThrow()
    }
    await expect(prepareSync({ ...f, ref: "--help" })).rejects.toThrow(/--ref/)
    await expect(prepareSync({ ...f, source: "" })).rejects.toThrow(/--source/)
  })

  it("requires review of the exact target when package manifests change and preserves local manifests", async () => {
    const f = await fixture()
    await put(f.source, "packages/ai/package.json", JSON.stringify({ name: "ai", version: "2.0.0" }))
    await f.commit()
    await put(f.projectRoot, "packages/ai/package.json", "local adapted manifest\n")
    const plan = await prepareSync(f)
    expect(plan.manifestChanges).toEqual(["packages/ai/package.json"])
    await expect(applySync(plan)).rejects.toThrow(/packages-reviewed/)
    await expect(applySync(plan, { packagesReviewed: plan.to.slice(0, 9) })).rejects.toThrow(/packages-reviewed/)
    await applySync(plan, { packagesReviewed: plan.to })
    expect(await readFile(join(f.projectRoot, "packages/ai/package.json"), "utf8")).toBe("local adapted manifest\n")
    expect(plan.nextLock.version).toBe("2.0.0")
  })

  it("keeps generated data pinned independently from Git and detects local data changes", async () => {
    const f = await fixture(true)
    await put(f.source, aiFile, "updated ai\n")
    const target = await f.commit()
    await put(f.source, generatedFile, "untracked newer model data\n")
    const plan = await prepareSync({ ...f, ref: target })
    await applySync(plan)
    expect(await readFile(join(f.projectRoot, generatedFile), "utf8")).toBe("{}\n")
    expect(plan.nextLock.generatedSnapshot).toEqual(f.lock.generatedSnapshot)
    await put(f.projectRoot, generatedFile, "mutated data\n")
    await expect(prepareSync({ ...f, ref: target })).rejects.toThrow(/内容改变/)
  })

  it("rejects automatic ownership transfer when Git starts tracking a generated data path", async () => {
    const f = await fixture(true)
    await put(f.source, generatedFile, "{}\n")
    const target = await f.commit()
    await expect(prepareSync({ ...f, ref: target })).rejects.toThrow()
  })

  it("requires explicit data compatibility review when generated catalog structure changes", async () => {
    const f = await fixture(true)
    await put(f.source, "packages/ai/src/models.generated.ts", "new model catalog structure\n")
    await f.commit()
    const plan = await prepareSync(f)
    await expect(applySync(plan)).rejects.toThrow(/model-data-reviewed/)
    await applySync(plan, { modelDataReviewed: plan.to })
    expect(await checkProtectedFiles(f.projectRoot, plan.nextLock)).toEqual([])
  })
})
