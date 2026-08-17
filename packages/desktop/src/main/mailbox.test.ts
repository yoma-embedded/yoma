/**
 * 接线层里不碰 electron 的两个纯函数面:composeJob(模板 → 任务书)与 probe 的入参护栏。
 * 守护 spawn / 杀树的真行为在 e2e-mailbox-ipc 里钉,这里不重复。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// cloneDirFor 的用例搬去了 packages/bench/src/mailbox/paths.test.ts —— 函数本身
// 搬到了 bench 的叶子模块,好让桌面端与命令行只有一份克隆位置的实现。
import { createMailboxMain, inferProjectDir, type MailboxMain } from "./mailbox.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function makeMain(): MailboxMain {
  const configDir = tempDir("mailbox-main-")
  return createMailboxMain({
    configDir,
    sessionsRoot: path.join(configDir, "sessions"),
    bundleDir: configDir,
    broadcast: () => {},
    persistence: { get: () => undefined, set: () => {} },
  })
}

describe("composeJob", () => {
  test("模板+描述合成任务书;不带绝对路径,项目根单独回给本机", async () => {
    const project = tempDir("proj-")
    mkdirSync(path.join(project, ".git"), { recursive: true })
    const benchDir = path.join(project, ".yoma", "bench")
    mkdirSync(benchDir, { recursive: true })
    const templatePath = path.join(benchDir, "mailbox.template.json")
    writeFileSync(
      templatePath,
      JSON.stringify({
        id: "foc",
        title: "FOC 工位",
        bench: { chip: "STM32G431CB" },
        success: { checks: [{ type: "bash", command: "true" }] },
        policy: "unattended",
      }),
    )

    const main = makeMain()
    const composed = await main.composeJob({ templatePath, description: "修 CAN 掉帧", tier: "quick" })
    expect(composed.ok).toBe(true)

    const job = JSON.parse(readFileSync(composed.jobFile!, "utf8")) as Record<string, unknown>
    expect(job.task).toBe("修 CAN 掉帧")
    expect(String(job.id)).toStartWith("foc-")
    // 任务书要在另一台机器上被读:绝对路径一律不进去,工程根只回给本机。
    expect((job.repo as { directory?: string }).directory).toBeUndefined()
    expect((job.repo as { name: string }).name).toBe("foc")
    expect(composed.projectDir).toBe(project)
    // 模板里没写的字段原样保留(判据永远来自模板)。
    expect((job.success as { checks: unknown[] }).checks).toHaveLength(1)
  })

  test("模板的 task 是项目级前置约束,与描述拼接而不是被覆盖", async () => {
    const project = tempDir("proj-")
    const templatePath = path.join(project, "t.json")
    writeFileSync(templatePath, JSON.stringify({ task: "1. 绝不能让电机转动。", success: { checks: [] } }))
    const main = makeMain()
    const composed = await main.composeJob({ templatePath, description: "修 CAN 掉帧", tier: "quick" })
    const job = JSON.parse(readFileSync(composed.jobFile!, "utf8")) as { task: string }
    expect(job.task).toContain("绝不能让电机转动")
    expect(job.task).toContain("修 CAN 掉帧")
  })

  test("模板自己声明的 repo.directory 只当本机工程目录用,不进任务书", async () => {
    const project = tempDir("proj-")
    const templatePath = path.join(project, "template.json")
    writeFileSync(
      templatePath,
      JSON.stringify({ repo: { directory: "D:\\work\\fw", branch: "agent/foc" }, success: { checks: [] } }),
    )
    const main = makeMain()
    const composed = await main.composeJob({ templatePath, description: "x", tier: "standard" })
    const job = JSON.parse(readFileSync(composed.jobFile!, "utf8")) as { repo: { directory?: string; branch: string } }
    expect(job.repo.directory).toBeUndefined()
    // 模板声明的路径比推导更可信 —— 但它是**本机事实**,只能走 projectDir 这条路。
    expect(composed.projectDir).toBe("D:\\work\\fw")
    // repo 的其余字段原样保留。
    expect(job.repo.branch).toBe("agent/foc")
  })

  test("坏模板与空描述都如实报,不产文件", async () => {
    const main = makeMain()
    const bad = await main.composeJob({
      templatePath: path.join(tempDir("x-"), "missing.json"),
      description: "x",
      tier: "quick",
    })
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain("模板读不出来")

    const project = tempDir("proj-")
    const templatePath = path.join(project, "t.json")
    writeFileSync(templatePath, "{}")
    const empty = await main.composeJob({ templatePath, description: "   ", tier: "quick" })
    expect(empty.ok).toBe(false)
  })
})

describe("inferProjectDir", () => {
  test("往上找 .git,层数不再是承重信息", () => {
    // 从前写死 dirname×2,于是模板深一层(.bench → .yoma/bench)就把工程根推成
    // `<工程>/.yoma` —— 而且不报错,症状是"agent 说它看不到代码"。
    const project = tempDir("infer-")
    mkdirSync(path.join(project, ".git"), { recursive: true })
    const deep = path.join(project, ".yoma", "bench")
    mkdirSync(deep, { recursive: true })
    expect(inferProjectDir(path.join(deep, "mailbox.template.json"))).toBe(project)
    // 老布局(浅一层)照样对 —— 用户手上已经存在的 .bench 不能因为这次改动坏掉。
    const shallow = path.join(project, ".bench")
    mkdirSync(shallow, { recursive: true })
    expect(inferProjectDir(path.join(shallow, "mailbox.template.json"))).toBe(project)
  })

  test("`.git` 是 worktree 里的文件时也认", () => {
    const project = tempDir("infer-wt-")
    writeFileSync(path.join(project, ".git"), "gitdir: /somewhere/else\n")
    const deep = path.join(project, ".yoma", "bench")
    mkdirSync(deep, { recursive: true })
    expect(inferProjectDir(path.join(deep, "mailbox.template.json"))).toBe(project)
  })

  test("找不到 .git 就退回老写法 —— 研发端随后会以'不是 git 仓库'如实拒掉", () => {
    const loose = tempDir("infer-nogit-")
    const dir = path.join(loose, "sub")
    mkdirSync(dir, { recursive: true })
    expect(inferProjectDir(path.join(dir, "t.json"))).toBe(loose)
  })
})

describe("probe", () => {
  test("空远端直接拒,不去 spawn git", async () => {
    const main = makeMain()
    const result = await main.probe("   ")
    expect(result.ok).toBe(false)
  })

  test("本地裸仓真连通", async () => {
    const { execFileSync } = await import("node:child_process")
    const bare = path.join(tempDir("bare-"), "origin.git")
    execFileSync("git", ["init", "--bare", "-q", bare])
    const main = makeMain()
    const result = await main.probe(bare)
    expect(result.ok).toBe(true)
  }, 20_000)
})
