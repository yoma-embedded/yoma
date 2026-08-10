/**
 * `.bench/.gitignore` 的边界:忽略运行产物,但**放行任务模板**。
 *
 * 模板是项目配置,要跟着仓库走到另一台机器上;轮次输入输出这类运行产物必须挡住 ——
 * 不挡的话研发打开 diff 看到的是几个 bench 内部文件加一处真改动。用真 git 的
 * check-ignore 来钉,因为这条规则的唯一裁判就是 git 自己。
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
  test("忽略运行产物,放行任务模板", async () => {
    const repo = await makeRepo()
    const benchDir = path.join(repo, ".bench")
    await ensureBenchDir(benchDir)

    mkdirSync(path.join(benchDir, "turns"), { recursive: true })
    writeFileSync(path.join(benchDir, "mailbox.template.json"), "{}")
    writeFileSync(path.join(benchDir, "turns", "turn-1.json"), "{}")

    // 任务模板是项目配置,跨机器靠它。
    expect(await ignored(repo, ".bench/mailbox.template.json")).toBe(false)
    // 运行产物必须挡住 —— 否则 diff 里全是它们。
    expect(await ignored(repo, ".bench/turns/turn-1.json")).toBe(true)
    // 忽略文件本身也要挡住:露出来就是一个未跟踪又不被忽略的文件,工作树因此
    // 永远"不干净",而开轮的第一道检查正是它(实测被自己挡死过)。
    expect(await ignored(repo, ".bench/.gitignore")).toBe(true)

    // add -A 之后暂存区里只有配置,没有产物。
    await runGitReal(["add", "-A"], repo)
    const staged = await runGitReal(["diff", "--cached", "--name-only"], repo)
    expect(staged.stdout.split("\n").filter((line) => line.startsWith(".bench/")).sort()).toEqual([
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

  test("已有的 .gitignore 不动 —— 那是用户的文件", async () => {
    const custom = await makeRepo()
    const customBench = path.join(custom, ".bench")
    mkdirSync(customBench, { recursive: true })
    writeFileSync(path.join(customBench, ".gitignore"), "*\n!我自己加的\n")
    await ensureBenchDir(customBench)
    expect(await readFile(path.join(customBench, ".gitignore"), "utf8")).toBe("*\n!我自己加的\n")
  })
})
