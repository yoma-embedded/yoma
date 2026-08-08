/**
 * `.bench/.gitignore` 的边界:忽略运行产物,但**放行项目配置**。
 *
 * 这条是真跑逮住的:旧版写的是整目录 `*`,于是 `.bench` 下零个文件被 git 跟踪 ——
 * 判据脚本与项目模板传不到另一台机器,工位机克隆下来判据一律"命令起不来"。
 * 跨机器是这个功能存在的理由,所以用真 git 的 check-ignore 来钉。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { runGitReal } from "./git.ts"
import { ensureBenchDir } from "./runner.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "bench-ignore-"))
  dirs.push(dir)
  await runGitReal(["init", "-q", "-b", "main"], dir)
  return dir
}

/** git 自己说了算:返回 true 表示这条路径会被忽略。 */
async function ignored(repo: string, relative: string): Promise<boolean> {
  return (await runGitReal(["check-ignore", "-q", relative], repo)).ok
}

describe(".bench/.gitignore", () => {
  test("忽略运行产物,放行模板/判据/known-good", async () => {
    const repo = await makeRepo()
    const benchDir = path.join(repo, ".bench")
    await ensureBenchDir(benchDir)

    mkdirSync(path.join(benchDir, "checks"), { recursive: true })
    mkdirSync(path.join(benchDir, "known-good"), { recursive: true })
    mkdirSync(path.join(benchDir, "turns"), { recursive: true })
    writeFileSync(path.join(benchDir, "mailbox.template.json"), "{}")
    writeFileSync(path.join(benchDir, "checks", "alive.py"), "print(1)")
    mkdirSync(path.join(benchDir, "checks", "__pycache__"), { recursive: true })
    writeFileSync(path.join(benchDir, "checks", "__pycache__", "alive.cpython-314.pyc"), "bytecode")
    writeFileSync(path.join(benchDir, "known-good", "fw.elf"), "elf")
    writeFileSync(path.join(benchDir, "turns", "turn-1.json"), "{}")
    writeFileSync(path.join(benchDir, "decisions.jsonl"), "{}")

    // 项目配置必须能提交 —— 跨机器靠它。
    expect(await ignored(repo, ".bench/mailbox.template.json")).toBe(false)
    expect(await ignored(repo, ".bench/checks/alive.py")).toBe(false)
    expect(await ignored(repo, ".bench/known-good/fw.elf")).toBe(false)
    // 运行产物必须挡住 —— 否则 diff 里全是它们。
    expect(await ignored(repo, ".bench/turns/turn-1.json")).toBe(true)
    // 判据脚本放行,但它们编译出来的 .pyc 不是项目配置(实测第一次提交就带进去两个)。
    expect(await ignored(repo, ".bench/checks/__pycache__/alive.cpython-314.pyc")).toBe(true)
    expect(await ignored(repo, ".bench/decisions.jsonl")).toBe(true)
    // 忽略文件本身也要挡住:露出来就是一个未跟踪又不被忽略的文件,工作树因此
    // 永远"不干净",而开轮的第一道检查正是它(实测被自己挡死过)。
    expect(await ignored(repo, ".bench/.gitignore")).toBe(true)

    // add -A 之后暂存区里只有配置,没有产物。
    await runGitReal(["add", "-A"], repo)
    const staged = await runGitReal(["diff", "--cached", "--name-only"], repo)
    expect(staged.stdout.split("\n").filter((line) => line.startsWith(".bench/")).sort()).toEqual([
      ".bench/checks/alive.py",
      ".bench/known-good/fw.elf",
      ".bench/mailbox.template.json",
    ])
  })

  test("干净仓库里建 .bench 之后仍然干净 —— 否则每一轮开局就被自己挡死", async () => {
    const repo = await makeRepo()
    writeFileSync(path.join(repo, "main.c"), "int main(void){return 0;}\n")
    await runGitReal(["add", "-A"], repo)
    await runGitReal(["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], repo)

    await ensureBenchDir(path.join(repo, ".bench"))
    const status = await runGitReal(["status", "--porcelain"], repo)
    expect(status.stdout).toBe("")
  })

  test("历代旧版都会被升级,用户改过的不动", async () => {
    // 每一版都要能升上来:只认最老那一版的话,中间版本的仓库永远拿不到后续修正。
    const legacies = [
      "# 调试台的运行产物,不进版本库(含自身)\n*\n",
      "# 调试台的**运行产物**不进版本库;模板与判据脚本是项目配置,要跟着仓库走。\n*\n!mailbox.template.json\n!checks/\n!checks/**\n!known-good/\n!known-good/**\n",
    ]
    for (const legacy of legacies) {
      const upgraded = await makeRepo()
      const upgradedBench = path.join(upgraded, ".bench")
      mkdirSync(upgradedBench, { recursive: true })
      writeFileSync(path.join(upgradedBench, ".gitignore"), legacy)
      await ensureBenchDir(upgradedBench)
      const now = await readFile(path.join(upgradedBench, ".gitignore"), "utf8")
      expect(now).toContain("!checks/")
      expect(now).toContain("__pycache__")
    }

    const custom = await makeRepo()
    const customBench = path.join(custom, ".bench")
    mkdirSync(customBench, { recursive: true })
    writeFileSync(path.join(customBench, ".gitignore"), "*\n!我自己加的\n")
    await ensureBenchDir(customBench)
    expect(await readFile(path.join(customBench, ".gitignore"), "utf8")).toBe("*\n!我自己加的\n")
  })
})
