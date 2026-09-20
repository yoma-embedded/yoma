/**
 * 授权不满足时调试台的**生命周期**:在安全的轮次边界暂停、什么都不写、续费后自己接着跑。
 *
 * 这里不重测验签与状态判定(那在 kernel 的 licensing.test.ts)。这一份钉的是调试台特有的四件事:
 *
 * 1. **暂停发生在副作用之前**:工位端的附件没落进工作目录、turn 子进程没起、信箱快照逐字节不变;
 *    研发端的工作分支没建、decision 没写、什么都没推。
 * 2. **暂停不是失败也不是成功**,更不经模型:它是一个独立的 outcome(`license-paused`),
 *    守护对它按正常轮询间隔重试(不是 blocked 的指数退避),进度行只在进出时各一条。
 * 3. **续费不需要重启任何东西**:另一个 `LicenseService` 实例(桌面端进程)往同一个 configDir
 *    导入授权,同一组 options 的下一步就接着跑 —— 这正是 `status()` 每次重新读盘换来的东西。
 * 4. **到期不打断已经接受的轮次**:轮内过期照样跑完并回填,下一轮才停。
 *
 * 密钥是用例现场生成的临时 Ed25519 密钥,configDir 全是临时目录 —— 仓库里没有测试私钥,
 * 也不读写开发机真实的 `~/.yoma`。
 */

import { afterEach, describe, expect, test } from "vitest"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"

import { LicenseService, type LicensePolicy } from "@yoma-desktop/kernel/host"

import { generateSigningKey, issueLicense, loadPrivateKey } from "../../../../scripts/license/lib.ts"
import { runGitReal } from "../git.ts"
import type { TurnInput } from "../runner.ts"
import type { TurnResult } from "../turn.ts"
import { runMailboxHost, type MailboxHostEvent } from "./host.ts"
import { initMailbox } from "./init.ts"
import { motherStep, runMailboxMother, type MailboxMotherOptions, type MotherStepOutcome } from "./mother.ts"
import { runnerStep, type MailboxRunnerOptions } from "./runner.ts"
import { parseMailboxJob } from "./spec.ts"
import {
  attachArtifacts,
  scanMailbox,
  writeDecision,
  writeInstruction,
  writeRoundResult,
  type RoundArtifact,
  type RoundResultFile,
} from "./store.ts"
import { commitPush } from "./sync.ts"
import { fakeTurn, freshClone, makeMailbox, makeTargetRepo, rawMailboxJob, Temp, usage } from "./testkit.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 8, 20, 4, 0, 0) // 2026-09-20T04:00:00Z
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z")

/** 现场生成的签名密钥;`COMMERCIAL` 就是"这台机器装的是商业包"的那份编译期策略。 */
const KEY = (() => {
  const generated = generateSigningKey("bench-license-key")
  return { keyId: generated.keyId, privateKey: loadPrivateKey(generated.privateKeyPem), trusted: generated.trusted }
})()
const COMMERCIAL: LicensePolicy = { edition: "commercial", trustedKeys: [KEY.trusted] }

function licenseText(period: { notBefore: string; expiresAt: string }, licenseId = "ORD-2026-0001"): string {
  return issueLicense({
    privateKey: KEY.privateKey,
    keyId: KEY.keyId,
    licenseId,
    customerLabel: "测试客户 张工",
    issuedAt: iso(T0 - HOUR),
    ...period,
  }).text
}

/**
 * 导入一份授权。**故意用一个独立的 `LicenseService` 实例** —— 生产里干这件事的是桌面端那个
 * 进程,而正在暂停的守护是另一个进程。两边共享的只有 configDir 里那个文件。
 */
function importLicense(configDir: string, atMs: number, period: { notBefore: string; expiresAt: string }, licenseId?: string): void {
  new LicenseService({ configDir, policy: COMMERCIAL, now: () => atMs }).importText(licenseText(period, licenseId))
}

/** 守护那一侧看到的授权服务(时钟由用例推动)。 */
function licenseOf(configDir: string, now: () => number): LicenseService {
  return new LicenseService({ configDir, policy: COMMERCIAL, now })
}

async function fixture(jobOverrides: Record<string, unknown> = {}) {
  const mailbox = await makeMailbox(temp)
  const mailboxJob = parseMailboxJob(rawMailboxJob(jobOverrides))
  const initialized = await initMailbox({ clone: mailbox.motherClone, mailboxJob })
  expect(initialized.initialized).toBe(true)
  return { mailbox, mailboxJob }
}

/** 站在研发端下发一轮(与 runner.test.ts 同一个搭台动作)。 */
async function issue(clone: string, round: number, prompt: string, artifacts?: RoundArtifact[]): Promise<void> {
  await writeInstruction(clone, { round, prompt, issuedBy: "mother", artifacts, at: new Date(T0).toISOString() })
  await commitPush({ clone, author: { name: "t", email: "t@e.c" } }, `下发第 ${round} 轮`)
}

function workspaceOf(workRoot: string): string {
  return path.join(workRoot, "m-1", "work")
}

function runnerOptions(clone: string, workRoot: string, overrides: Partial<MailboxRunnerOptions> = {}): MailboxRunnerOptions {
  return {
    clone,
    workRoot,
    sessionsRoot: temp.dir("sessions-"),
    runTurn: async () => fakeTurn(),
    ...overrides,
  }
}

/** 远端已推的真相(全新克隆,不信任何一侧的工作副本)。 */
async function remoteSnapshot(bare: string) {
  return scanMailbox(await freshClone(temp, bare))
}

describe("工位端:授权暂停在动板子之前", () => {
  test("过期 → license-paused:附件没落地、turn 没被调用、信箱快照逐字段不变;续费后同一组 options 接着跑完这一轮", async () => {
    const { mailbox } = await fixture()
    const configDir = temp.dir("license-config-")
    const workRoot = temp.dir("work-")

    // 研发端下发第 1 轮并附了固件 —— 暂停时它一个字节都不该被拷进工作目录。
    const devBuild = temp.dir("dev-build-")
    writeFileSync(path.join(devBuild, "fw.elf"), "NEW-ELF")
    const attached = await attachArtifacts(
      mailbox.motherClone,
      1,
      [{ source: path.join(devBuild, "fw.elf"), name: "fw.elf", from: "build/fw.elf" }],
      1024 * 1024,
    )
    expect(attached.ok).toBe(true)
    await issue(mailbox.motherClone, 1, "新固件在附件里,弄上板然后复现", attached.ok ? attached.artifacts : undefined)

    // 授权在 T0 有效,现在已经是两天后。
    importLicense(configDir, T0, { notBefore: iso(T0 - DAY), expiresAt: iso(T0 + DAY) })
    let now = T0 + 2 * DAY
    let turns = 0
    const options = runnerOptions(mailbox.runnerClone, workRoot, {
      configDir,
      license: licenseOf(configDir, () => now),
      runTurn: async () => {
        turns += 1
        return fakeTurn()
      },
    })

    const before = await remoteSnapshot(mailbox.bare)
    const paused = await runnerStep(options)

    expect(paused.kind).toBe("license-paused")
    if (paused.kind === "license-paused") {
      expect(paused.state).toBe("expired")
      expect(paused.round).toBe(1)
      expect(paused.expiresAt).toBe(iso(T0 + DAY))
      // 话术三件事:为什么、停在哪(状态还在)、怎么恢复。
      expect(paused.detail).toContain("已到期")
      expect(paused.detail).toContain("第 1 轮")
      expect(paused.detail).toContain("状态已保留")
      expect(paused.detail).toContain("设置 → 授权")
    }

    // 闸门的全部意义在这三条上:模型没被调用、附件没落地、信箱没被动过。
    expect(turns).toBe(0)
    expect(existsSync(path.join(workspaceOf(workRoot), "fw.elf"))).toBe(false)
    expect(await remoteSnapshot(mailbox.bare)).toEqual(before)
    const stale = await freshClone(temp, mailbox.bare)
    expect(existsSync(path.join(stale, "rounds", "001", "result.json"))).toBe(false)

    // 桌面端那个进程导入续费授权(另一个 LicenseService,同一个 configDir),守护没有重启。
    importLicense(configDir, now, { notBefore: iso(T0 - DAY), expiresAt: iso(now + 30 * DAY) }, "ORD-2026-0002")

    const ran = await runnerStep(options)
    expect(ran.kind).toBe("ran")
    expect(turns).toBe(1)
    expect(await readFile(path.join(workspaceOf(workRoot), "fw.elf"), "utf8")).toBe("NEW-ELF")

    const verify = await freshClone(temp, mailbox.bare)
    const result = JSON.parse(await readFile(path.join(verify, "rounds", "001", "result.json"), "utf8")) as RoundResultFile
    expect(result.round).toBe(1)
    expect(result.incoming).toEqual(["fw.elf"])
  })

  test("未激活(一个授权文件都没有)也是暂停,不是失败", async () => {
    const { mailbox } = await fixture()
    const configDir = temp.dir("license-config-")
    await issue(mailbox.motherClone, 1, "上电看日志")

    const outcome = await runnerStep(
      runnerOptions(mailbox.runnerClone, temp.dir("work-"), {
        configDir,
        license: licenseOf(configDir, () => T0),
      }),
    )
    expect(outcome.kind).toBe("license-paused")
    if (outcome.kind === "license-paused") {
      expect(outcome.state).toBe("missing")
      expect(outcome.expiresAt).toBeUndefined()
    }
  })

  test("到期不打断已经接受的那一轮:轮内过期照样跑完并回填,下一轮才暂停", async () => {
    const { mailbox } = await fixture()
    const configDir = temp.dir("license-config-")
    importLicense(configDir, T0, { notBefore: iso(T0 - DAY), expiresAt: iso(T0 + HOUR) })
    let now = T0
    const options = runnerOptions(mailbox.runnerClone, temp.dir("work-"), {
      configDir,
      license: licenseOf(configDir, () => now),
      runTurn: async () => {
        // 这一轮跑着的时候授权到期了。已经接受的轮次不回头查 —— 到期不该把烧录中途杀掉。
        now = T0 + 2 * DAY
        return fakeTurn({ usage: usage(200, 100) })
      },
    })

    await issue(mailbox.motherClone, 1, "复现")
    const ran = await runnerStep(options)
    expect(ran.kind).toBe("ran")

    const verify = await freshClone(temp, mailbox.bare)
    const result = JSON.parse(await readFile(path.join(verify, "rounds", "001", "result.json"), "utf8")) as RoundResultFile
    expect(result.spentTokens).toBe(300)

    // 下一轮才是新的付费执行 —— 它停住。
    await writeDecision(mailbox.motherClone, { round: 1, by: "mother", decision: "continue", at: iso(T0) })
    await issue(mailbox.motherClone, 2, "继续")
    const paused = await runnerStep(options)
    expect(paused.kind).toBe("license-paused")
    if (paused.kind === "license-paused") expect(paused.round).toBe(2)
  })

  test("竞态兜底:守护这边放行、子进程那边被内核拒 → 同样是暂停,结果不回填", async () => {
    const { mailbox } = await fixture()
    const configDir = temp.dir("license-config-")
    importLicense(configDir, T0, { notBefore: iso(T0 - DAY), expiresAt: iso(T0 + 30 * DAY) })
    await issue(mailbox.motherClone, 1, "复现")

    const outcome = await runnerStep(
      runnerOptions(mailbox.runnerClone, temp.dir("work-"), {
        configDir,
        license: licenseOf(configDir, () => T0),
        // 子进程回来的不是失败,而是"这一轮压根没开始"。
        runTurn: async (_input: TurnInput) =>
          fakeTurn({
            text: "",
            licenseBlocked: { _tag: "LicenseRequiredError", state: "expired", execution: "session.prompt", expiresAt: iso(T0) },
          }),
      }),
    )

    expect(outcome.kind).toBe("license-paused")
    if (outcome.kind === "license-paused") expect(outcome.state).toBe("expired")
    const verify = await freshClone(temp, mailbox.bare)
    expect(existsSync(path.join(verify, "rounds", "001", "result.json"))).toBe(false)
  })
})

describe("研发端:两个开轮位置各一道闸门", () => {
  function motherOptions(
    clone: string,
    projectDir: string,
    overrides: Partial<MailboxMotherOptions> = {},
  ): MailboxMotherOptions {
    return {
      clone,
      projectDir,
      sessionsRoot: temp.dir("sessions-"),
      runTurn: async () => fakeTurn(),
      ...overrides,
    }
  }

  test("kickoff:过期 → 暂停在开局轮边界,工作分支没建、信箱没动;续费后开局照跑", async () => {
    const { mailbox } = await fixture()
    const target = await makeTargetRepo(temp)
    const configDir = temp.dir("license-config-")
    importLicense(configDir, T0, { notBefore: iso(T0 - DAY), expiresAt: iso(T0 + DAY) })
    let now = T0 + 2 * DAY
    let analyses = 0
    const options = motherOptions(mailbox.motherClone, target, {
      configDir,
      license: licenseOf(configDir, () => now),
      runTurn: async () => {
        analyses += 1
        return fakeTurn({
          text: '先取证。\n```json\n{"decision":"continue","analysis":"先复现","instruction":"上电跑起来,把日志贴回来"}\n```',
        })
      },
    })

    const before = await remoteSnapshot(mailbox.bare)
    const paused = await motherStep(options)
    expect(paused.kind).toBe("license-paused")
    if (paused.kind === "license-paused") {
      expect(paused.round).toBe(0)
      expect(paused.detail).toContain("开局轮")
    }
    expect(analyses).toBe(0)
    // prepareProjectBranch 在闸门之后 —— 工程仓一个字都没动(连 .yoma/ 都没建出来)。
    expect((await runGitReal(["rev-parse", "--abbrev-ref", "HEAD"], target)).stdout).toBe("main")
    expect((await runGitReal(["branch", "--list", "agent/m-1"], target)).stdout).toBe("")
    expect(existsSync(path.join(target, ".yoma"))).toBe(false)
    expect(await remoteSnapshot(mailbox.bare)).toEqual(before)

    importLicense(configDir, now, { notBefore: iso(T0 - DAY), expiresAt: iso(now + 30 * DAY) }, "ORD-2026-0002")
    const decided = await motherStep(options)
    expect(decided.kind).toBe("decided")
    expect(analyses).toBe(1)
    const after = await remoteSnapshot(mailbox.bare)
    expect(after.state.kind).toBe("awaiting-runner")
  })

  test("decide:工位端回填之后过期 → 暂停,decision 没写、下一轮没下发;续费后照常裁决", async () => {
    const { mailbox } = await fixture()
    const target = await makeTargetRepo(temp)
    const configDir = temp.dir("license-config-")
    await issue(mailbox.motherClone, 1, "复现")
    await writeRoundResult(mailbox.motherClone, {
      round: 1,
      sessionID: "ses-runner",
      turn: {
        text: "复现了:日志停在 RX overrun",
        toolCounts: {},
        toolErrors: [],
        usage: usage(1000, 200),
        errors: [],
        elapsedMs: 10,
      },
      spentTokens: 1200,
      at: iso(T0),
      elapsedMs: 10,
    })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "工位端回填第 1 轮")

    importLicense(configDir, T0, { notBefore: iso(T0 - DAY), expiresAt: iso(T0 + DAY) })
    let now = T0 + 2 * DAY
    let analyses = 0
    const options = motherOptions(mailbox.motherClone, target, {
      configDir,
      license: licenseOf(configDir, () => now),
      runTurn: async () => {
        analyses += 1
        return fakeTurn({
          text: '证据够了。\n```json\n{"decision":"done","analysis":"ORE 没清","reason":"工位端复现不出 overrun"}\n```',
        })
      },
    })

    const before = await remoteSnapshot(mailbox.bare)
    const paused = await motherStep(options)
    expect(paused.kind).toBe("license-paused")
    if (paused.kind === "license-paused") expect(paused.round).toBe(1)
    expect(analyses).toBe(0)
    expect(await remoteSnapshot(mailbox.bare)).toEqual(before)
    const stale = await freshClone(temp, mailbox.bare)
    expect(existsSync(path.join(stale, "rounds", "001", "decision.json"))).toBe(false)
    expect(existsSync(path.join(stale, "verdict.json"))).toBe(false)

    importLicense(configDir, now, { notBefore: iso(T0 - DAY), expiresAt: iso(now + 30 * DAY) }, "ORD-2026-0002")
    const done = await motherStep(options)
    expect(done.kind).toBe("done")
    expect(analyses).toBe(1)
    const after = await remoteSnapshot(mailbox.bare)
    expect(after.state.kind).toBe("done")
    expect(after.rounds[0]?.decision?.decision).toBe("done")
  })

  test("重试轮才被内核拒:第一轮已经花掉的用量挂在本地,续费后记进那条 decision,不凭空消失", async () => {
    const { mailbox } = await fixture()
    const target = await makeTargetRepo(temp)
    const configDir = temp.dir("license-config-")
    await issue(mailbox.motherClone, 1, "复现")
    await writeRoundResult(mailbox.motherClone, {
      round: 1,
      sessionID: "ses-runner",
      turn: { text: "复现了", toolCounts: {}, toolErrors: [], usage: usage(1000, 200), errors: [], elapsedMs: 10 },
      spentTokens: 1200,
      at: iso(T0),
      elapsedMs: 10,
    })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "工位端回填第 1 轮")

    // 守护这边的检查一直通过(有效授权);被拒的是轮次那一侧 —— 竞态:第一轮跑完、重试轮开跑前恰好到期。
    importLicense(configDir, T0, { notBefore: iso(T0 - DAY), expiresAt: iso(T0 + 30 * DAY) })
    const blocked = { _tag: "LicenseRequiredError", state: "expired", execution: "session.prompt" } as const
    const script: TurnResult[] = [
      fakeTurn({ text: "我分析完了,但忘了给 JSON", usage: usage(5000, 700) }),
      fakeTurn({ text: "", usage: usage(0, 0), licenseBlocked: blocked }),
      fakeTurn({
        text: '```json\n{"decision":"done","analysis":"ORE 没清","reason":"复现不出 overrun"}\n```',
        usage: usage(300, 40),
      }),
    ]
    let calls = 0
    const options = motherOptions(mailbox.motherClone, target, {
      configDir,
      license: licenseOf(configDir, () => T0),
      runTurn: async () => script[calls++]!,
    })

    const before = await remoteSnapshot(mailbox.bare)
    const paused = await motherStep(options)
    expect(paused.kind).toBe("license-paused")
    expect(calls).toBe(2)
    // 信箱零写入;那 5700 token 记在本地 ignored 状态里。
    expect(await remoteSnapshot(mailbox.bare)).toEqual(before)
    const local = JSON.parse(readFileSync(path.join(mailbox.motherClone, ".mother", "state.json"), "utf8")) as {
      pendingUsage?: { tokens: { input: number; output: number } }
    }
    expect(local.pendingUsage?.tokens).toMatchObject({ input: 5000, output: 700 })

    const done = await motherStep(options)
    expect(done.kind).toBe("done")
    const after = await remoteSnapshot(mailbox.bare)
    expect(after.rounds[0]?.decision?.usage?.tokens).toMatchObject({ input: 5300, output: 740 })
    const cleared = JSON.parse(readFileSync(path.join(mailbox.motherClone, ".mother", "state.json"), "utf8")) as {
      pendingUsage?: unknown
    }
    expect(cleared.pendingUsage).toBeUndefined()
  })
})

describe("守护循环:暂停是非终态,续费即自愈", () => {
  test("过期时按正常轮询间隔连着暂停(不退避)、进度行只一条;导入授权后自己走到终局", async () => {
    const { mailbox } = await fixture()
    const target = await makeTargetRepo(temp)
    const configDir = temp.dir("license-config-")
    await issue(mailbox.motherClone, 1, "复现")
    await writeRoundResult(mailbox.motherClone, {
      round: 1,
      sessionID: "ses-runner",
      turn: { text: "复现了", toolCounts: {}, toolErrors: [], usage: usage(1000, 200), errors: [], elapsedMs: 10 },
      spentTokens: 1200,
      at: iso(T0),
      elapsedMs: 10,
    })
    await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, "工位端回填第 1 轮")

    importLicense(configDir, T0, { notBefore: iso(T0 - DAY), expiresAt: iso(T0 + DAY) })
    const now = T0 + 2 * DAY
    const steps: MotherStepOutcome[] = []
    const progress: string[] = []
    let pausedSeen = 0

    const outcome = await runMailboxMother({
      clone: mailbox.motherClone,
      projectDir: target,
      sessionsRoot: temp.dir("sessions-"),
      configDir,
      license: licenseOf(configDir, () => now),
      pollSeconds: 0.05,
      onProgress: (message) => progress.push(message),
      onStep: (step) => {
        steps.push(step)
        // 连着停三步之后,桌面端那个进程导入续费授权。守护没有被重启、没有被通知。
        if (step.kind === "license-paused" && ++pausedSeen === 3) {
          importLicense(configDir, now, { notBefore: iso(T0 - DAY), expiresAt: iso(now + 30 * DAY) }, "ORD-2026-0002")
        }
      },
      runTurn: async () =>
        fakeTurn({ text: '够了。\n```json\n{"decision":"done","analysis":"ORE 没清","reason":"复现不出 overrun 了"}\n```' }),
    })

    expect(outcome.kind).toBe("done")
    expect(steps.filter((step) => step.kind === "license-paused").length).toBe(3)
    // 每一拍刷一行会把桌面端的环形进度整个挤掉:进一次、出一次,各一条。
    expect(progress.filter((line) => line.startsWith("⏸")).length).toBe(1)
    expect(progress.filter((line) => line.includes("授权暂停已解除")).length).toBe(1)
    // 暂停不是故障:一步都没被当成 blocked(那条路会指数退避,续费之后要干等几分钟)。
    expect(steps.some((step) => step.kind === "blocked")).toBe(false)
    expect(progress.some((line) => line.includes("后重试"))).toBe(false)
  }, 30_000)

  test("once:暂停这一步原样返回,不假装成终局", async () => {
    // 信箱里零轮次 = 开局轮要开跑,而这台机器没有授权 → 守护走一步就带着暂停退出。
    const { mailbox } = await fixture()
    const target = await makeTargetRepo(temp)
    const configDir = temp.dir("license-config-")

    const outcome = await runMailboxMother({
      clone: mailbox.motherClone,
      projectDir: target,
      sessionsRoot: temp.dir("sessions-"),
      configDir,
      license: licenseOf(configDir, () => T0),
      pollSeconds: 0.05,
      once: true,
      runTurn: async () => fakeTurn(),
    })
    expect(outcome.kind).toBe("license-paused")
    if (outcome.kind === "license-paused") expect(outcome.state).toBe("missing")
  })
})

describe("runMailboxHost:没有授权就拒绝启动(退出码 4)", () => {
  function collect(): { events: MailboxHostEvent[]; emit: (event: MailboxHostEvent) => void } {
    const events: MailboxHostEvent[] = []
    return { events, emit: (event) => events.push(event) }
  }

  test("runner / mother / init / sim 四个角色都退 4 且带 license.state,信箱与模拟根一个都没建出来", async () => {
    const configDir = temp.dir("license-config-")
    const license = licenseOf(configDir, () => T0) // 没有授权文件 = missing
    const root = temp.dir("host-")

    for (const role of ["runner", "mother", "init", "sim"] as const) {
      const clone = path.join(root, `${role}-clone`)
      const simRoot = path.join(root, `${role}-sim`)
      const { events, emit } = collect()
      const code = await runMailboxHost(
        {
          role,
          clone,
          jobFile: path.join(root, "job.json"), // 压根不会被读到
          root: simRoot,
          sessionsRoot: temp.dir("sessions-"),
          configDir,
          once: true,
        },
        emit,
        { license },
      )

      expect(code, role).toBe(4)
      const done = events.find((event) => event.type === "done")
      if (done?.type !== "done") throw new Error(`${role} 没有 done 事件`)
      expect(done.exitCode).toBe(4)
      expect(done.license?.state).toBe("missing")
      expect(done.license?._tag).toBe("LicenseRequiredError")
      expect(done.detail).toContain("没有启动")
      // 拒绝启动 = 什么都没碰:没克隆、没锁、没模拟根。
      expect(existsSync(clone), role).toBe(false)
      expect(existsSync(simRoot), role).toBe(false)
    }
  })

  test("status 角色照常发快照并退 0 —— 看进度、读终报永远不受授权影响", async () => {
    const { mailbox } = await fixture()
    const configDir = temp.dir("license-config-")
    const clone = path.join(temp.dir("status-"), "clone")
    const { events, emit } = collect()

    const code = await runMailboxHost({ role: "status", clone, remote: mailbox.bare }, emit, {
      license: licenseOf(configDir, () => T0),
    })

    expect(code).toBe(0)
    const snapshot = events.find((event) => event.type === "snapshot")
    if (snapshot?.type !== "snapshot") throw new Error("没有 snapshot 事件")
    expect(snapshot.snapshot.state.kind).toBe("kickoff")
    expect(events.find((event) => event.type === "done")?.type).toBe("done")
  })

  test("有效授权时照常:init 入箱成功,done 里没有 license", async () => {
    const mailbox = await makeMailbox(temp)
    const configDir = temp.dir("license-config-")
    importLicense(configDir, T0, { notBefore: iso(T0 - DAY), expiresAt: iso(T0 + 30 * DAY) })
    const jobFile = path.join(temp.dir("job-"), "job.json")
    writeFileSync(jobFile, JSON.stringify(rawMailboxJob(), null, 2))

    const { events, emit } = collect()
    const code = await runMailboxHost({ role: "init", clone: mailbox.motherClone, jobFile, configDir }, emit, {
      license: licenseOf(configDir, () => T0),
    })

    expect(code).toBe(0)
    const done = events.find((event) => event.type === "done")
    if (done?.type !== "done") throw new Error("没有 done 事件")
    expect(done.license).toBeUndefined()
    expect((await remoteSnapshot(mailbox.bare)).job?.job.id).toBe("m-1")
  })

  test("守护以暂停收场时退 0 并带上 license —— 挂起不是失败(与 awaiting-human 同理)", async () => {
    const { mailbox } = await fixture()
    const configDir = temp.dir("license-config-")
    // 启动那一刻有效,开轮那一刻已过期:启动检查放行,轮次边界停住。
    importLicense(configDir, T0, { notBefore: iso(T0 - DAY), expiresAt: iso(T0 + HOUR) })
    await issue(mailbox.motherClone, 1, "复现")
    // 时钟每读一次往前走一格。`check()` 每次只读一次时钟(status → compute 各一次 now()),
    // 于是第一次读到的是启动检查的 T0、第二次是轮次边界的两天后。末尾断言 `readings` 真的
    // 只被读了两次 —— 这条同时钉住"检查只发生两次"。
    const readings = [T0, T0 + 2 * DAY]
    let read = 0
    const license = new LicenseService({
      configDir,
      policy: COMMERCIAL,
      now: () => readings[Math.min(read++, readings.length - 1)]!,
    })
    const { events, emit } = collect()

    const code = await runMailboxHost(
      {
        role: "runner",
        clone: mailbox.runnerClone,
        sessionsRoot: temp.dir("sessions-"),
        workRoot: temp.dir("work-"),
        configDir,
        pollSeconds: 1,
        once: true,
      },
      emit,
      { license },
    )

    expect(code).toBe(0)
    expect(read).toBe(2)
    const done = events.find((event) => event.type === "done")
    if (done?.type !== "done") throw new Error("没有 done 事件")
    expect(done.exitCode).toBe(0)
    expect(done.license?.state).toBe("expired")
    expect(done.detail).toContain("暂停")
    // 步事件里也是同一个 outcome(桌面端据此把任务显示成"暂停")。
    const step = events.find((event) => event.type === "step")
    if (step?.type !== "step") throw new Error("没有 step 事件")
    expect(step.outcome.kind).toBe("license-paused")
  }, 30_000)
})
