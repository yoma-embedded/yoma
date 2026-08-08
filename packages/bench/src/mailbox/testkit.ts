/**
 * mailbox 测试的公共搭台。不是测试文件 —— 只是把"裸仓 + 两个克隆 + 目标仓"这套
 * 重复度极高的布景收拢到一处。git 一律真跑(与 git.test.ts 同一条纪律:
 * mock 掉的 git 只是在验证我们对 git 的记忆)。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { runGitReal } from "../git.ts"
import type { GradeResult } from "../grader.ts"
import type { TurnResult, TurnUsage } from "../turn.ts"
import { cloneMailbox, initBareMailbox } from "./sync.ts"

export class Temp {
  private dirs: string[] = []

  dir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    this.dirs.push(dir)
    return dir
  }

  cleanup(): void {
    for (const dir of this.dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  }
}

/** 一个有初始提交的目标仓(被调试的固件仓)。 */
export async function makeTargetRepo(temp: Temp): Promise<string> {
  const dir = temp.dir("mailbox-target-")
  await runGitReal(["init", "-q", "-b", "main"], dir)
  await runGitReal(["config", "user.email", "test@example.com"], dir)
  await runGitReal(["config", "user.name", "test"], dir)
  writeFileSync(path.join(dir, "main.c"), "int main(void){return 0;}\n")
  await runGitReal(["add", "-A"], dir)
  await runGitReal(["commit", "-q", "-m", "init"], dir)
  return dir
}

export interface MailboxFixture {
  bare: string
  runnerClone: string
  motherClone: string
}

/** 裸仓 + runner/mother 各一个克隆 —— 单机模拟的最小布景。 */
export async function makeMailbox(temp: Temp): Promise<MailboxFixture> {
  const root = temp.dir("mailbox-")
  const bare = path.join(root, "origin.git")
  await initBareMailbox(bare)
  const runnerClone = path.join(root, "runner-clone")
  const motherClone = path.join(root, "mother-clone")
  await cloneMailbox(bare, runnerClone)
  await cloneMailbox(bare, motherClone)
  return { bare, runnerClone, motherClone }
}

/** 从裸仓拉一个全新克隆来断言"已推送的真相"(不信任何一侧的工作副本)。 */
export async function freshClone(temp: Temp, bare: string): Promise<string> {
  const dir = temp.dir("mailbox-verify-")
  const clone = path.join(dir, "clone")
  await cloneMailbox(bare, clone)
  return clone
}

/**
 * 信箱里那份 job.json 的原文。**不带 `repo.directory`** —— 它是本机事实,
 * 两侧各自用 `projectDir` 提供(这正是机器无关的支点)。
 */
export function rawMailboxJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m-1",
    title: "测试任务",
    task: "修 bug",
    repo: { name: "m-1" },
    success: { checks: [{ type: "bash", command: "true" }] },
    policy: "unattended",
    budget: { maxIterations: 3, maxTokens: 100_000, wallClockMin: 60 },
    mailbox: { maxRounds: 3, pollSeconds: 1, mother: { maxTokensPerAnalysis: 50_000 } },
    ...overrides,
  }
}

export function usage(input: number, output = 50): TurnUsage {
  return { tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.01 }
}

export function fakeTurn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    sessionID: "ses-1",
    text: "我看了一圈",
    toolCalls: [],
    usage: usage(100),
    decisions: [],
    errors: [],
    elapsedMs: 1000,
    ...overrides,
  }
}

export function fakeGrade(passed: boolean, overrides: Partial<GradeResult> = {}): GradeResult {
  return {
    passed,
    checks: [
      {
        check: { type: "bash", command: "true" },
        outcome: passed ? "pass" : "fail",
        summary: passed ? "通过" : "退出码 1",
        evidence: passed ? "" : "assertion failed at main.c:42",
        elapsedMs: 10,
      },
    ],
    hasEnvironmentError: false,
    ...overrides,
  }
}
