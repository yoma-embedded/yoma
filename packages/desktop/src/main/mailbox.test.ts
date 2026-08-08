/**
 * 接线层里不碰 electron 的两个纯函数面:composeJob(模板 → 任务书)与 probe 的入参护栏。
 * 守护 spawn / 杀树的真行为在 e2e-mailbox-ipc 里钉,这里不重复。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createMailboxMain, type MailboxMain } from "./mailbox.ts"

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
  const userData = tempDir("mailbox-main-")
  return createMailboxMain({
    userDataDir: userData,
    sessionsRoot: path.join(userData, "sessions"),
    bundleDir: userData,
    broadcast: () => {},
    setHardwareLock: () => {},
    persistence: { get: () => undefined, set: () => {} },
  })
}

describe("composeJob", () => {
  test("模板+描述+预算档合成任务书;repo.directory 缺省取模板所在项目根", async () => {
    const project = tempDir("proj-")
    const benchDir = path.join(project, ".bench")
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
    expect((job.repo as { directory: string }).directory).toBe(project)
    expect((job.budget as { maxTokens: number }).maxTokens).toBe(300_000)
    expect((job.mailbox as { maxRounds: number }).maxRounds).toBe(4)
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

  test("模板自己声明的 repo.directory 优先于推导", async () => {
    const project = tempDir("proj-")
    const templatePath = path.join(project, "template.json")
    writeFileSync(templatePath, JSON.stringify({ repo: { directory: "D:\\work\\fw" }, success: { checks: [] } }))
    const main = makeMain()
    const composed = await main.composeJob({ templatePath, description: "x", tier: "standard" })
    const job = JSON.parse(readFileSync(composed.jobFile!, "utf8")) as { repo: { directory: string } }
    expect(job.repo.directory).toBe("D:\\work\\fw")
  })

  test("坏模板与空描述都如实报,不产文件", async () => {
    const main = makeMain()
    const bad = await main.composeJob({ templatePath: path.join(tempDir("x-"), "missing.json"), description: "x", tier: "quick" })
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain("模板读不出来")

    const project = tempDir("proj-")
    const templatePath = path.join(project, "t.json")
    writeFileSync(templatePath, "{}")
    const empty = await main.composeJob({ templatePath, description: "   ", tier: "quick" })
    expect(empty.ok).toBe(false)
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
