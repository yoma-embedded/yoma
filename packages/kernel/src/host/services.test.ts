/**
 * 宿主文件服务:file.list 交出的相对路径要能原样喂回 file.read,而且读不出工作目录之外。
 *
 * 2026-09-06 的教训:内核只有一个进程、服务多个项目,它的 cwd(桌面端里是 homedir)
 * 不可能是任何项目根。file.read 曾经拿相对路径直接 stat,于是每个文件都被拼到 ~/ 下面 ——
 * 文件树列得出来,点开全是 ENOENT。这里的临时目录刻意不是 cwd,相对路径读得通才算数。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { listFiles, readFile, vcsDiff, vcsInfo, vcsInit } from "./services.ts"

let root: string
let outside: string

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "yoma-services-"))
  mkdirSync(path.join(root, "docs"))
  writeFileSync(path.join(root, "docs", "readme.md"), "# hi\n")
  writeFileSync(path.join(root, "stop-all.ps1"), "exit 0\n")
  outside = mkdtempSync(path.join(tmpdir(), "yoma-services-outside-"))
  writeFileSync(path.join(outside, "secret.txt"), "nope\n")
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/** 测试里的 git:身份写死、不签名、不做换行转换(开发机的 autocrlf 会让 diff 多出整文件的 EOL 改动)。 */
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { cwd, stdio: "pipe" },
  )

/** 建一个有一次提交的临时仓库,返回目录;调用方负责 rmSync。 */
function tempRepo(prefix: string, files: Record<string, string>): string {
  const repo = mkdtempSync(path.join(tmpdir(), prefix))
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "core.autocrlf", "false")
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), content)
  }
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "init")
  return repo
}

describe("readFile", () => {
  test("file.list 交出的相对路径原样喂回去就能读,与进程 cwd 无关", async () => {
    expect(path.resolve(root)).not.toBe(process.cwd())

    const top = await listFiles(root)
    const script = top.find((entry) => entry.name === "stop-all.ps1")
    expect(script?.path).toBe("stop-all.ps1")
    expect((await readFile(root, script!.path)).content).toBe("exit 0\n")

    const docs = await listFiles(root, "docs")
    const readme = docs.find((entry) => entry.name === "readme.md")
    expect(readme?.path).toBe(path.join("docs", "readme.md"))
    expect(await readFile(root, readme!.path)).toEqual({ content: "# hi\n", mime: "text/markdown", truncated: false })
  })

  test("正斜杠写法各平台都认(前端一律用 / 拼路径)", async () => {
    expect((await readFile(root, "docs/readme.md")).content).toBe("# hi\n")
  })

  test("工作目录内的绝对路径也收", async () => {
    expect((await readFile(root, path.join(root, "docs", "readme.md"))).content).toBe("# hi\n")
  })

  test("越界一律拒绝:.. 爬出去、外部绝对路径,不管文件存不存在", async () => {
    const climb = path.relative(root, path.join(outside, "secret.txt"))
    expect(climb.startsWith("..")).toBe(true)
    await expect(readFile(root, climb)).rejects.toThrow("路径越界")
    await expect(readFile(root, path.join(outside, "secret.txt"))).rejects.toThrow("路径越界")
    await expect(readFile(root, "../nope.txt")).rejects.toThrow("路径越界")
  })

  test("不存在的文件报 ENOENT,而且报的是工作目录下的路径,不是 cwd 下的", async () => {
    const error = (await readFile(root, "missing.md").catch((e: unknown) => e)) as NodeJS.ErrnoException
    expect(error.code).toBe("ENOENT")
    expect(error.message).toContain(path.join(root, "missing.md"))
  })
})

describe("vcsDiff", () => {
  test("路径相对传入的目录而不是仓库根:项目是仓库子目录时才能原样喂给 file.read", async () => {
    const repo = tempRepo("yoma-services-git-", { "README.md": "root\n", "firmware/src/main.c": "int main(){}\n" })
    try {
      writeFileSync(path.join(repo, "README.md"), "root changed\n")
      writeFileSync(path.join(repo, "firmware", "src", "main.c"), "int main(){return 0;}\n")

      // 项目就是仓库根:两处改动都列出,路径相对根
      const atRoot = await vcsDiff(repo)
      expect(atRoot.map((d) => d.path).sort()).toEqual(["README.md", "firmware/src/main.c"])

      // 项目是仓库子目录:只列该目录下的改动,路径相对该目录,file.read 直接能读
      const sub = path.join(repo, "firmware")
      const atSub = await vcsDiff(sub)
      expect(atSub.map((d) => d.path)).toEqual(["src/main.c"])
      expect((await readFile(sub, atSub[0]!.path)).content).toBe("int main(){return 0;}\n")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("每一项带全上下文 patch;删除标 deleted,未跟踪的新文件标 added 并数出行数,二进制不数", async () => {
    const repo = tempRepo("yoma-services-patch-", { "a.txt": "1\n2\n3\n", "gone.txt": "bye\n" })
    try {
      writeFileSync(path.join(repo, "a.txt"), "1\n2 changed\n3\n")
      rmSync(path.join(repo, "gone.txt"))
      writeFileSync(path.join(repo, "fresh.txt"), "x\ny\n")
      writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3]))

      const byPath = Object.fromEntries((await vcsDiff(repo)).map((d) => [d.path, d]))
      expect(Object.keys(byPath).sort()).toEqual(["a.txt", "blob.bin", "fresh.txt", "gone.txt"])

      expect(byPath["a.txt"]).toMatchObject({ status: "modified", added: 1, removed: 1 })
      // 全上下文:整个文件收进一个 hunk,面板才能从 patch 还原出前后两份文本
      expect(byPath["a.txt"]!.patch).toContain("@@ -1,3 +1,3 @@")
      expect(byPath["a.txt"]!.patch).toContain("-2\n+2 changed\n")

      expect(byPath["gone.txt"]).toMatchObject({ status: "deleted", added: 0, removed: 1 })

      expect(byPath["fresh.txt"]).toMatchObject({ status: "added", added: 2, removed: 0 })
      expect(byPath["fresh.txt"]!.patch).toContain("+++ b/fresh.txt")
      expect(byPath["fresh.txt"]!.patch).toContain("+x\n+y\n")

      expect(byPath["blob.bin"]).toMatchObject({ status: "added", added: 0, removed: 0 })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("中文文件名原样返回,不被 git 转义成八进制", async () => {
    const repo = tempRepo("yoma-services-cjk-", { "说明.md": "一\n" })
    try {
      writeFileSync(path.join(repo, "说明.md"), "二\n")
      writeFileSync(path.join(repo, "新 文件.txt"), "新\n")
      const paths = (await vcsDiff(repo)).map((d) => d.path).sort()
      expect(paths).toEqual(["新 文件.txt", "说明.md"])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe("vcsInfo / vcsInit", () => {
  test("裸目录 → init 后是空仓库(root 有、empty:true、有分支名),提交一次之后 empty 消失", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yoma-services-init-"))
    try {
      expect(await vcsInfo(dir)).toEqual({ dirty: false })

      const inited = await vcsInit(dir)
      expect(inited.root).toBeDefined()
      expect(inited.empty).toBe(true)
      expect(inited.dirty).toBe(false)
      expect(typeof inited.branch).toBe("string")
      // 幂等:再按一次按钮不报错
      expect((await vcsInit(dir)).empty).toBe(true)
      // 空仓库没有基线,diff 是空的而不是报错
      expect(await vcsDiff(dir)).toEqual([])

      writeFileSync(path.join(dir, "a.txt"), "a\n")
      expect((await vcsInfo(dir)).dirty).toBe(true)
      git(dir, "add", ".")
      git(dir, "commit", "-q", "-m", "init")
      const after = await vcsInfo(dir)
      expect(after.empty).toBeUndefined()
      expect(after.dirty).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
