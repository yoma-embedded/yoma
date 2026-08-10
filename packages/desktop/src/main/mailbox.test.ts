/**
 * 接线层里不碰 electron 的两个纯函数面:composeJob(模板 → 任务书)与 probe 的入参护栏。
 * 守护 spawn / 杀树的真行为在 e2e-mailbox-ipc 里钉,这里不重复。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { cloneDirFor, createMailboxMain, type MailboxMain } from "./mailbox.ts"

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
    persistence: { get: () => undefined, set: () => {} },
  })
}

describe("composeJob", () => {
  test("模板+描述合成任务书;不带绝对路径,项目根单独回给本机", async () => {
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

describe("cloneDirFor", () => {
  const REMOTE = "git@github.com:me/mailbox.git"

  test("换分支就换目录 —— 复用停在旧分支的克隆会让 init 死在 git 报错上", () => {
    // ensureClone 见到 .git/HEAD 就早返回、不改分支,孤儿分支逻辑因此不会跑;
    // 最后 `push -u origin run-1:run-1` 报 "src refspec run-1 does not match any"。
    // 目录带上分支,这条路就走不到了。
    expect(cloneDirFor("/m", REMOTE, "mother", "run-1")).not.toBe(cloneDirFor("/m", REMOTE, "mother", "run-2"))
  })

  test("留空 / 显式 main / 带空格的 main 都是同一条分支,必须同一个目录", () => {
    // sync.ts 的 branchOf 就是 `branch ?? "main"` —— 这里不归一的话,同一条分支会有
    // 两个克隆,而用户在界面上看不出任何区别。
    const canonical = cloneDirFor("/m", REMOTE, "mother", "main")
    expect(cloneDirFor("/m", REMOTE, "mother")).toBe(canonical)
    expect(cloneDirFor("/m", REMOTE, "mother", "")).toBe(canonical)
    expect(cloneDirFor("/m", REMOTE, "mother", "  main  ")).toBe(canonical)
  })

  test("角色仍然分目录 —— 同机双角色不共享工作树", () => {
    expect(cloneDirFor("/m", REMOTE, "mother", "run-1")).not.toBe(cloneDirFor("/m", REMOTE, "runner", "run-1"))
  })

  test("远端与分支的拼接不会撞车", () => {
    // 用 \n 分隔(分支名不能含换行),否则 ("a","b") 与 ("ab","") 会哈希到一起。
    expect(cloneDirFor("/m", "a", "mother", "b")).not.toBe(cloneDirFor("/m", "ab", "mother", ""))
  })
})
