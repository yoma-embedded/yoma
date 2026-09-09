/**
 * 宿主文件服务:file.list 交出的相对路径要能原样喂回 file.read,而且读不出工作目录之外。
 *
 * 2026-09-06 的教训:内核只有一个进程、服务多个项目,它的 cwd(桌面端里是 homedir)
 * 不可能是任何项目根。file.read 曾经拿相对路径直接 stat,于是每个文件都被拼到 ~/ 下面 ——
 * 文件树列得出来,点开全是 ENOENT。这里的临时目录刻意不是 cwd,相对路径读得通才算数。
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { listFiles, parseStatus, readFile, searchFiles, vcsDiff, vcsInfo, vcsInit } from "./services.ts"

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

describe("listFiles(VS Code 的资源管理器规则)", () => {
  test("点文件、node_modules 都显示,只藏 .git 这类;gitignore 的条目带 ignored 标记", async () => {
    const repo = tempRepo("yoma-services-tree-", { ".gitignore": "node_modules/\nbuild/\n", "src/a.c": "int a;\n" })
    try {
      mkdirSync(path.join(repo, "node_modules", "x"), { recursive: true })
      mkdirSync(path.join(repo, "build"))
      writeFileSync(path.join(repo, ".env.example"), "A=1\n")
      writeFileSync(path.join(repo, "build", "out.bin"), "x")

      const top = await listFiles(repo)
      const names = top.map((entry) => entry.name)
      expect(names).toContain(".gitignore")
      expect(names).toContain(".env.example")
      expect(names).toContain("node_modules")
      expect(names).toContain("build")
      expect(names).not.toContain(".git")

      const byName = Object.fromEntries(top.map((entry) => [entry.name, entry]))
      expect(byName["node_modules"]!.ignored).toBe(true)
      expect(byName["build"]!.ignored).toBe(true)
      expect(byName["src"]!.ignored).toBeUndefined()
      expect(byName[".gitignore"]!.ignored).toBeUndefined()

      // 被忽略的目录照样能往下列,里面的东西也标 ignored
      const inside = await listFiles(repo, "build")
      expect(inside.map((entry) => entry.name)).toEqual(["out.bin"])
      expect(inside[0]!.ignored).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("不是仓库的目录:照常列,没有 ignored 字段", async () => {
    const top = await listFiles(root)
    expect(top.map((entry) => entry.name)).toEqual(["docs", "stop-all.ps1"])
    expect(top.every((entry) => entry.ignored === undefined)).toBe(true)
  })
})

/**
 * @提及搜索。这一族从前**一条测试都没有**,而它同时踩了两个坑:
 *
 * 1. Windows 上 `path.relative` 交的是 `packages\app\x.ts`,而候选框的显示层无条件拼 `/` ——
 *    用户照着屏幕上的斜杠打过去一个都撞不上(2026-09-07 报障)。所以查询与结果都钉死 `/`。
 * 2. `searchFilesAndDirectories` 曾经是个空名字:目录只被入队递归、从不产出。
 *
 * 这里刻意不建 git 仓 —— 搜索不看 gitignore,建了反而让"为什么它没出现"多一种解释。
 */
describe("searchFiles(@提及)", () => {
  let tree: string

  beforeAll(() => {
    tree = mkdtempSync(path.join(tmpdir(), "yoma-services-search-"))
    const write = (relative: string, content = "x\n") => {
      const target = path.join(tree, relative)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    write("packages/app/src/prompt-input.tsx")
    write("packages/app/src/index.ts")
    write("packages/kernel/src/host/services.ts")
    write("docs/readme.md")
    write(".github/workflows/ci.yml")
    write(".gitignore", "node_modules/\n")
    write("node_modules/left-pad/index.js")
    write(".yoma/gdb/session.mi")
  })

  afterAll(() => {
    rmSync(tree, { recursive: true, force: true })
  })

  test("正斜杠与反斜杠两种写法都命中,交出来的一律是正斜杠", async () => {
    const forward = await searchFiles(tree, "packages/app/src")
    const backward = await searchFiles(tree, "packages\\app\\src")

    expect(forward).toEqual(backward)
    expect(forward).toContain("packages/app/src/index.ts")
    expect(forward).toContain("packages/app/src/prompt-input.tsx")
    expect(forward.some((hit) => hit.includes("\\"))).toBe(false)
  })

  test("默认只有文件;directories 打开时目录也进候选,以 / 结尾", async () => {
    expect(await searchFiles(tree, "docs")).toEqual(["docs/readme.md"])

    const both = await searchFiles(tree, "docs", 50, true)
    expect(both).toContain("docs/")
    expect(both).toContain("docs/readme.md")
  })

  test("排除名单挡住 node_modules 与 .yoma,连里面的文件一起", async () => {
    expect(await searchFiles(tree, "left-pad", 50, true)).toEqual([])
    expect(await searchFiles(tree, "session.mi", 50, true)).toEqual([])
    expect(await searchFiles(tree, "", 50, true)).not.toContain("node_modules/")
  })

  test("点文件与点目录搜得到 —— 文件树显示它们,这里也得显示", async () => {
    expect(await searchFiles(tree, "ci.yml")).toEqual([".github/workflows/ci.yml"])
    expect(await searchFiles(tree, "gitignore")).toEqual([".gitignore"])
    expect(await searchFiles(tree, "workflows", 50, true)).toContain(".github/workflows/")
  })

  test("空查询交出全部候选(按路径长度排),limit 封顶", async () => {
    const all = await searchFiles(tree, "")
    expect(all).toContain(".gitignore")
    expect(all).toContain("packages/kernel/src/host/services.ts")
    expect(all.length).toBeGreaterThan(2)
    expect((await searchFiles(tree, "", 2)).length).toBe(2)
  })
})

describe("parseStatus(porcelain v2)", () => {
  test("四种记录各归各组,字母照 git;路径含空格;改名带旧路径;仓库子目录剥前缀", () => {
    const text = [
      "1 .M N... 100644 100644 100644 abc def sub/a b.txt",
      "1 M. N... 100644 100644 100644 abc def sub/staged.txt",
      "1 MM N... 100644 100644 100644 abc def sub/both.txt",
      "1 .D N... 100644 100644 100644 abc def sub/gone.txt",
      "1 A. N... 000000 100644 100644 000 def sub/new-staged.txt",
      "2 R. N... 100644 100644 100644 abc abc R100 sub/renamed.txt",
      "sub/old.txt",
      "u UU N... 100644 100644 100644 100644 a b c sub/conflict.txt",
      "? sub/untracked.txt",
      "? other/outside.txt",
    ].join("\0")
    const entries = parseStatus(text, "sub/")
    expect(entries.map((e) => [e.path, e.group, e.letter, e.status, e.base])).toEqual([
      ["a b.txt", "changes", "M", "modified", "head"],
      ["staged.txt", "staged", "M", "modified", "index"],
      ["both.txt", "changes", "M", "modified", "head"],
      ["gone.txt", "changes", "D", "deleted", "head"],
      ["new-staged.txt", "staged", "A", "added", "index"],
      ["renamed.txt", "staged", "R", "renamed", "index"],
      ["conflict.txt", "conflict", "!", "modified", "head"],
      ["untracked.txt", "untracked", "U", "added", "none"],
      ["other/outside.txt", "untracked", "U", "added", "none"],
    ])
    expect(entries.find((e) => e.path === "renamed.txt")!.origPath).toBe("sub/old.txt")
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
      expect(atSub[0]!.patch).toContain("+++ b/src/main.c")
      expect((await readFile(sub, atSub[0]!.path)).content).toBe("int main(){return 0;}\n")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("按 VS Code 分组和字母:暂存 / 更改 / 未跟踪,顺序固定,每项带全上下文 patch 和行数", async () => {
    const repo = tempRepo("yoma-services-groups-", {
      "a.txt": "1\n2\n3\n",
      "staged.txt": "s\n",
      "both.txt": "b\n",
      "gone.txt": "bye\n",
      "old.txt": "o\n",
    })
    try {
      writeFileSync(path.join(repo, "a.txt"), "1\n2 changed\n3\n") // 未暂存 M
      writeFileSync(path.join(repo, "staged.txt"), "s2\n") // 暂存 M
      git(repo, "add", "staged.txt")
      writeFileSync(path.join(repo, "both.txt"), "b2\n") // 暂存后又改:归"更改"
      git(repo, "add", "both.txt")
      writeFileSync(path.join(repo, "both.txt"), "b3\n")
      rmSync(path.join(repo, "gone.txt")) // 未暂存 D
      writeFileSync(path.join(repo, "new-staged.txt"), "n\n") // 暂存 A
      git(repo, "add", "new-staged.txt")
      git(repo, "mv", "old.txt", "renamed.txt") // 暂存 R
      writeFileSync(path.join(repo, "fresh.txt"), "x\ny\n") // 未跟踪
      writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3])) // 未跟踪二进制

      const diffs = await vcsDiff(repo)
      expect(diffs.map((d) => [d.path, d.group, d.letter])).toEqual([
        ["new-staged.txt", "staged", "A"],
        ["renamed.txt", "staged", "R"],
        ["staged.txt", "staged", "M"],
        ["a.txt", "changes", "M"],
        ["both.txt", "changes", "M"],
        ["gone.txt", "changes", "D"],
        ["blob.bin", "untracked", "U"],
        ["fresh.txt", "untracked", "U"],
      ])
      const byPath = Object.fromEntries(diffs.map((d) => [d.path, d]))

      // 全上下文:整个文件收进一个 hunk,面板才能从 patch 还原出前后两份文本
      expect(byPath["a.txt"]).toMatchObject({ status: "modified", added: 1, removed: 1 })
      expect(byPath["a.txt"]!.patch).toContain("@@ -1,3 +1,3 @@")
      expect(byPath["a.txt"]!.patch).toContain("-2\n+2 changed\n")
      // 暂存的 diff 对着暂存区算
      expect(byPath["staged.txt"]).toMatchObject({ status: "modified", added: 1, removed: 1 })
      expect(byPath["staged.txt"]!.patch).toContain("-s\n+s2\n")
      // 既暂存又改:合并视图,HEAD→工作树
      expect(byPath["both.txt"]!.patch).toContain("-b\n+b3\n")
      expect(byPath["gone.txt"]).toMatchObject({ status: "deleted", added: 0, removed: 1 })
      expect(byPath["new-staged.txt"]).toMatchObject({ status: "added", added: 1, removed: 0 })
      expect(byPath["renamed.txt"]).toMatchObject({ status: "renamed", origPath: "old.txt" })
      expect(byPath["fresh.txt"]).toMatchObject({ status: "added", added: 2, removed: 0 })
      expect(byPath["fresh.txt"]!.patch).toContain("+x\n+y\n")
      expect(byPath["blob.bin"]).toMatchObject({ status: "added", added: 0, removed: 0 })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("合并冲突归第一组,字母是 VS Code 的 !", async () => {
    const repo = tempRepo("yoma-services-conflict-", { "c.txt": "base\n" })
    try {
      git(repo, "checkout", "-q", "-b", "other")
      writeFileSync(path.join(repo, "c.txt"), "theirs\n")
      git(repo, "commit", "-q", "-am", "theirs")
      git(repo, "checkout", "-q", "main")
      writeFileSync(path.join(repo, "c.txt"), "ours\n")
      git(repo, "commit", "-q", "-am", "ours")
      writeFileSync(path.join(repo, "z.txt"), "z\n")
      try {
        git(repo, "merge", "other")
      } catch {
        // 冲突时 git 退出码 1,正是要的状态
      }
      const diffs = await vcsDiff(repo)
      expect(diffs[0]).toMatchObject({ path: "c.txt", group: "conflict", letter: "!" })
      expect(diffs[0]!.patch).toContain("<<<<<<<")
      expect(diffs.map((d) => d.group)).toEqual(["conflict", "untracked"])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("中文文件名原样返回,不被 git 转义成八进制", async () => {
    const repo = tempRepo("yoma-services-cjk-", { "说明.md": "一\n" })
    try {
      writeFileSync(path.join(repo, "说明.md"), "二\n")
      writeFileSync(path.join(repo, "新 文件.txt"), "新\n")
      const diffs = await vcsDiff(repo)
      expect(diffs.map((d) => d.path)).toEqual(["说明.md", "新 文件.txt"])
      expect(diffs[1]!.patch).toContain("+新\n")
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test("不是仓库:空列表,不抛", async () => {
    expect(await vcsDiff(root)).toEqual([])
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
      // 空仓库:未跟踪的文件照样列(VS Code 也列),只是没有 HEAD 可比
      writeFileSync(path.join(dir, "a.txt"), "a\n")
      expect((await vcsInfo(dir)).dirty).toBe(true)
      expect((await vcsDiff(dir)).map((d) => [d.path, d.group])).toEqual([["a.txt", "untracked"]])

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
