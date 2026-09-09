import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { applySync, prepareSync } from "../sync-upstream.ts"
import { checkProtectedFiles, parseUpstreamLock, sha256, type UpstreamLock } from "../upstream-common.ts"

const execute = promisify(execFile)
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
