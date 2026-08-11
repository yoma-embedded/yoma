/**
 * `<工程>/.my-pi/.gitignore` 的边界:挡住运行产物,**放行 bench 的项目配置**。
 *
 * 配置要跟着仓库走到另一台机器上;轮次输入输出、gdb 转录这类运行产物必须挡住 ——
 * 不挡的话研发打开 diff 看到的是一堆内部文件加一处真改动(实测:第一次真跑,
 * 17 个改动文件里 16 个是工具日志)。用真 git 的 check-ignore 来钉,因为这条规则的
 * 唯一裁判就是 git 自己。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { runGitReal } from "./git.ts"
import { ensureYomaDir } from "./runner.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "yoma-ignore-"))
  dirs.push(dir)
  await runGitReal(["init", "-q", "-b", "main"], dir)
  return dir
}

/** git 自己说了算:返回 true 表示这条路径会被忽略。 */
async function ignored(repo: string, relative: string): Promise<boolean> {
  return (await runGitReal(["check-ignore", "-q", relative], repo)).ok
}

describe(".my-pi/.gitignore", () => {
  test("挡住运行产物,放行 bench 的项目配置", async () => {
    const repo = await makeRepo()
    await ensureYomaDir(repo)
    const yoma = path.join(repo, ".my-pi")

    mkdirSync(path.join(yoma, "bench", "turns"), { recursive: true })
    mkdirSync(path.join(yoma, "bench", "mailbox-sim"), { recursive: true })
    mkdirSync(path.join(yoma, "gdb"), { recursive: true })
    mkdirSync(path.join(yoma, "logs"), { recursive: true })
    writeFileSync(path.join(yoma, "bench", "mailbox.template.json"), "{}")
    writeFileSync(path.join(yoma, "bench", "mailbox.shell-faults.json"), "{}")
    writeFileSync(path.join(yoma, "bench", "turns", "turn-1.json"), "{}")
    writeFileSync(path.join(yoma, "bench", "mailbox-sim", "x.json"), "{}")
    writeFileSync(path.join(yoma, "gdb", "s.mi"), "")
    writeFileSync(path.join(yoma, "logs", "l.txt"), "")
    writeFileSync(path.join(yoma, "flash-state.json"), "{}")

    // 项目配置跨机器靠它,必须放行 —— 而且不止模板一个文件。
    expect(await ignored(repo, ".my-pi/bench/mailbox.template.json")).toBe(false)
    expect(await ignored(repo, ".my-pi/bench/mailbox.shell-faults.json")).toBe(false)
    // 运行产物必须挡住 —— 否则 diff 里全是它们。
    expect(await ignored(repo, ".my-pi/bench/turns/turn-1.json")).toBe(true)
    expect(await ignored(repo, ".my-pi/bench/mailbox-sim/x.json")).toBe(true)
    expect(await ignored(repo, ".my-pi/gdb/s.mi")).toBe(true)
    expect(await ignored(repo, ".my-pi/logs/l.txt")).toBe(true)
    expect(await ignored(repo, ".my-pi/flash-state.json")).toBe(true)
    // 忽略文件本身也要挡住:露出来就是一个未跟踪又不被忽略的文件,工作树因此
    // 永远"不干净",而开轮的第一道检查正是它(实测被自己挡死过)。
    expect(await ignored(repo, ".my-pi/.gitignore")).toBe(true)

    // add -A 之后暂存区里只有配置,没有产物。
    await runGitReal(["add", "-A"], repo)
    const staged = await runGitReal(["diff", "--cached", "--name-only"], repo)
    expect(staged.stdout.split("\n").filter((line) => line.startsWith(".my-pi/")).sort()).toEqual([
      ".my-pi/bench/mailbox.shell-faults.json",
      ".my-pi/bench/mailbox.template.json",
    ])
  })

  test("干净仓库里建 .my-pi 之后仍然干净 —— 否则每一轮开局就被自己挡死", async () => {
    const repo = await makeRepo()
    writeFileSync(path.join(repo, "main.c"), "int main(void){return 0;}\n")
    await runGitReal(["add", "-A"], repo)
    await runGitReal(["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], repo)

    await ensureYomaDir(repo)
    const status = await runGitReal(["status", "--porcelain"], repo)
    expect(status.stdout).toBe("")
  })

  test("用户手写的 .gitignore 不动 —— 那是他的文件", async () => {
    const repo = await makeRepo()
    const yoma = path.join(repo, ".my-pi")
    mkdirSync(yoma, { recursive: true })
    writeFileSync(path.join(yoma, ".gitignore"), "*\n!我自己加的\n")
    await ensureYomaDir(repo)
    expect(await readFile(path.join(yoma, ".gitignore"), "utf8")).toBe("*\n!我自己加的\n")
  })

  test("旧版(我们自己写的那份)会被升级 —— 否则老仓库永远漏 bench/turns", async () => {
    // 合并之前 .my-pi/.gitignore 只挡 gdb/logs/flash-state。两个 ensure 函数当初都是
    // "文件不存在才写",于是老仓库停在旧规则上,合并之后 bench/turns/ 会照旧漏进
    // 版本库 —— 而那正是当初加忽略要防的事。认第一行的标志决定敢不敢覆盖。
    const repo = await makeRepo()
    const yoma = path.join(repo, ".my-pi")
    mkdirSync(yoma, { recursive: true })
    writeFileSync(
      path.join(yoma, ".gitignore"),
      "# yoma 调试工具的运行产物,不进版本库(技能等用户文件不受影响)\n.gitignore\ngdb/\nlogs/\nflash-state.json\n",
    )

    await ensureYomaDir(repo)

    mkdirSync(path.join(yoma, "bench", "turns"), { recursive: true })
    writeFileSync(path.join(yoma, "bench", "turns", "turn-1.json"), "{}")
    expect(await ignored(repo, ".my-pi/bench/turns/turn-1.json")).toBe(true)
  })
})
