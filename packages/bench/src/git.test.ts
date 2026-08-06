/**
 * git 层对**真仓库**测,不 mock —— 这一层的价值全在"git 真的会这么反应"上,
 * mock 掉就只是在验证我对 git 的记忆。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { commitAll, currentBranch, diffNameStatus, diffStat, isClean, isRepo, logSince, prepareBranch, runGitReal } from "./git.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "bench-git-"))
  dirs.push(dir)
  await runGitReal(["init", "-q", "-b", "main"], dir)
  await runGitReal(["config", "user.email", "test@example.com"], dir)
  await runGitReal(["config", "user.name", "test"], dir)
  writeFileSync(path.join(dir, "main.c"), "int main(void){return 0;}\n")
  await runGitReal(["add", "-A"], dir)
  await runGitReal(["commit", "-q", "-m", "init"], dir)
  return dir
}

describe("git", () => {
  test("识别仓库与干净工作树", async () => {
    const cwd = await makeRepo()
    expect(await isRepo({ cwd })).toBe(true)
    expect(await isClean({ cwd })).toBe(true)
    expect(await currentBranch({ cwd })).toBe("main")

    writeFileSync(path.join(cwd, "main.c"), "changed\n")
    expect(await isClean({ cwd })).toBe(false)
  })

  test("非仓库目录直接拒绝开跑", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bench-nogit-"))
    dirs.push(dir)
    const prepared = await prepareBranch({ cwd: dir }, { branch: "agent/j-1" })
    expect(prepared.ok).toBe(false)
    expect(prepared.message).toContain("不是一个 git 仓库")
  })

  test("工作树不干净时拒绝开跑 —— agent 的改动必须能和人的区分开", async () => {
    const cwd = await makeRepo()
    writeFileSync(path.join(cwd, "main.c"), "人手改了一半\n")
    const prepared = await prepareBranch({ cwd }, { branch: "agent/j-1" })
    expect(prepared.ok).toBe(false)
    expect(prepared.message).toContain("工作树不干净")
  })

  test("开新分支,主干不动", async () => {
    const cwd = await makeRepo()
    const prepared = await prepareBranch({ cwd }, { branch: "agent/j-1" })
    expect(prepared.ok).toBe(true)
    expect(prepared.baseCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(await currentBranch({ cwd })).toBe("agent/j-1")
  })

  test("分支已存在时复用 —— 打回续跑走的正是这条路", async () => {
    const cwd = await makeRepo()
    await prepareBranch({ cwd }, { branch: "agent/j-1" })
    await runGitReal(["checkout", "-q", "main"], cwd)

    const again = await prepareBranch({ cwd }, { branch: "agent/j-1" })
    expect(again.ok).toBe(true)
    expect(again.message).toContain("复用")
    expect(await currentBranch({ cwd })).toBe("agent/j-1")
  })

  test("提交改动并能算出 diff 统计与提交列表", async () => {
    const cwd = await makeRepo()
    const prepared = await prepareBranch({ cwd }, { branch: "agent/j-1" })
    writeFileSync(path.join(cwd, "main.c"), "int main(void){return 1;}\n")
    writeFileSync(path.join(cwd, "extra.c"), "// new\n")

    const committed = await commitAll({ cwd }, { message: "fix: 修一个 bug", author: { name: "bench", email: "b@x" } })
    expect(committed.committed).toBe(true)
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/)

    const stat = await diffStat({ cwd }, prepared.baseCommit!)
    expect(stat).toContain("main.c")
    expect(await diffNameStatus({ cwd }, prepared.baseCommit!)).toEqual(
      expect.arrayContaining([expect.stringContaining("main.c"), expect.stringContaining("extra.c")]),
    )
    expect((await logSince({ cwd }, prepared.baseCommit!))[0]).toContain("修一个 bug")
  })

  test("没有改动时不算失败 —— 这一轮可能只是看了看", async () => {
    const cwd = await makeRepo()
    await prepareBranch({ cwd }, { branch: "agent/j-1" })
    const committed = await commitAll({ cwd }, { message: "空轮" })
    expect(committed.committed).toBe(false)
    expect(committed.message).toContain("没有改动")
  })

  test("提交归属只作用于这一次,不污染仓库配置", async () => {
    const cwd = await makeRepo()
    await prepareBranch({ cwd }, { branch: "agent/j-1" })
    writeFileSync(path.join(cwd, "main.c"), "changed\n")
    await commitAll({ cwd }, { message: "x", author: { name: "yoma-bench", email: "bench@yoma.local" } })

    const author = await runGitReal(["log", "-1", "--format=%an <%ae>"], cwd)
    expect(author.stdout).toBe("yoma-bench <bench@yoma.local>")
    const configured = await runGitReal(["config", "user.name"], cwd)
    expect(configured.stdout).toBe("test")
  })
})
