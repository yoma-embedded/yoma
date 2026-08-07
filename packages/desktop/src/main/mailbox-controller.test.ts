/**
 * 任务控制器的纯逻辑测试:状态机、退避重启、锁生命周期、锁冲突人话。
 * spawn/杀树/广播全是假的 —— 真进程与杀树语义由 e2e-mailbox-ipc 在真 Electron 里钉。
 */

import { describe, expect, test } from "bun:test"

import type { MailboxHostConfig } from "@yoma-desktop/bench"
import {
  MailboxController,
  restartDelayMs,
  type MailboxControllerDeps,
  type MailboxPublicEvent,
  type MailboxSettings,
} from "./mailbox-controller.ts"

interface Harness {
  controller: MailboxController
  launches: { config: MailboxHostConfig; io: { onLine(line: string): void; onExit(code: number | null): void } }[]
  stops: { pid?: number; force: boolean }[]
  locks: boolean[]
  events: MailboxPublicEvent[]
  saved: MailboxSettings | undefined
  timers: { fn: () => void; ms: number; cancelled: boolean }[]
}

function makeHarness(initial?: MailboxSettings): Harness {
  const harness: Partial<Harness> = {
    launches: [],
    stops: [],
    locks: [],
    events: [],
    saved: initial,
    timers: [],
  }
  const deps: MailboxControllerDeps = {
    launch: (config, io) => {
      harness.launches!.push({ config, io })
      return { pid: 1000 + harness.launches!.length }
    },
    stopProcess: (handle, force) => harness.stops!.push({ pid: handle.pid, force }),
    setHardwareLock: (active) => harness.locks!.push(active),
    broadcast: (event) => harness.events!.push(event),
    persistence: {
      get: () => harness.saved,
      set: (settings) => {
        harness.saved = settings
      },
    },
    buildConfig: (settings, task) => ({
      role: task.kind === "init" ? "init" : task.kind,
      remote: settings.remote,
      clone: "/tmp/clone",
      jobFile: task.jobFile,
      sessionsRoot: "/tmp/sessions",
    }),
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false }
      harness.timers!.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  }
  harness.controller = new MailboxController(deps)
  return harness as Harness
}

const SETTINGS: MailboxSettings = { remote: "git@example.com:mail.git", role: "runner" }

function emit(harness: Harness, index: number, event: unknown): void {
  harness.launches[index]!.io.onLine(`@@event ${JSON.stringify(event)}`)
}

describe("配置", () => {
  test("校验、持久化、任务进行中拒改", () => {
    const harness = makeHarness()
    expect(harness.controller.configure({ remote: "  ", role: "runner" }).ok).toBe(false)
    expect(harness.controller.configure({ remote: "x.git", role: "bad" as never }).ok).toBe(false)

    expect(harness.controller.configure(SETTINGS)).toEqual({ ok: true })
    expect(harness.saved?.remote).toBe(SETTINGS.remote)

    harness.controller.start({ kind: "runner" })
    const refused = harness.controller.configure({ remote: "y.git", role: "mother" })
    expect(refused.ok).toBe(false)
  })
})

describe("任务生命周期", () => {
  test("runner 起停:锁跟着任务走,停止是整棵树的语义", () => {
    const harness = makeHarness(SETTINGS)
    expect(harness.controller.start({ kind: "runner" })).toEqual({ ok: true })
    expect(harness.locks).toEqual([true])
    expect(harness.launches[0]!.config.role).toBe("runner")
    expect(harness.controller.start({ kind: "runner" }).ok).toBe(false)

    harness.controller.stop()
    expect(harness.stops).toEqual([{ pid: 1001, force: false }])
    expect(harness.controller.status().phase).toBe("stopping")

    harness.launches[0]!.io.onExit(143)
    expect(harness.controller.status().phase).toBe("idle")
    expect(harness.locks).toEqual([true, false])
  })

  test("mother 不锁探针;init 一次性失败即 error 不重启", () => {
    const harness = makeHarness({ ...SETTINGS, role: "mother" })
    harness.controller.start({ kind: "mother" })
    expect(harness.locks).toEqual([])

    harness.launches[0]!.io.onExit(1)
    // mother 是常驻角色,异常退出应重启 —— 先把它停掉再试 init。
    expect(harness.controller.status().message).toContain("重启")
    harness.controller.stop()

    const fresh = makeHarness(SETTINGS)
    expect(fresh.controller.start({ kind: "init" }).ok).toBe(false)
    fresh.controller.start({ kind: "init", jobFile: "/tmp/job.json" })
    emit(fresh, 0, { type: "done", exitCode: 1, detail: "spec 校验失败" })
    fresh.launches[0]!.io.onExit(1)
    expect(fresh.controller.status().phase).toBe("error")
    expect(fresh.timers.filter((timer) => !timer.cancelled)).toHaveLength(0)
  })

  test("快照与终局进 status;verdict 终局撤锁", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "runner" })
    emit(harness, 0, { type: "snapshot", snapshot: { state: { kind: "awaiting-mother", round: 1 }, rounds: [] } })
    expect(harness.controller.status().snapshot?.state).toEqual({ kind: "awaiting-mother", round: 1 })

    emit(harness, 0, {
      type: "done",
      exitCode: 0,
      detail: "终局 passed",
      verdict: { outcome: "passed", reason: "判据全过", rounds: 2, totalRunnerTokens: 1, totalMotherTokens: 1, decidedBy: "policy", at: "t" },
    })
    harness.launches[0]!.io.onExit(0)
    expect(harness.controller.status().phase).toBe("done")
    expect(harness.controller.status().done?.verdict?.outcome).toBe("passed")
    expect(harness.locks).toEqual([true, false])
  })

  test("崩溃退避重启:锁保持;停止取消重启", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "runner" })
    harness.launches[0]!.io.onExit(1)

    expect(harness.controller.status().message).toContain("重启")
    expect(harness.timers).toHaveLength(1)
    expect(harness.timers[0]!.ms).toBe(restartDelayMs(1))
    // 崩溃间隙锁不撤 —— 孙进程可能还占着探针。
    expect(harness.locks).toEqual([true])

    harness.timers[0]!.fn()
    expect(harness.launches).toHaveLength(2)

    harness.launches[1]!.io.onExit(1)
    expect(harness.timers[1]!.ms).toBe(restartDelayMs(2))
    harness.controller.stop()
    expect(harness.timers[1]!.cancelled).toBe(true)
    expect(harness.controller.status().phase).toBe("idle")
    expect(harness.locks).toEqual([true, false])
  })

  test("锁冲突(退出码 3)给人话,不进重启循环", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "runner" })
    emit(harness, 0, { type: "done", exitCode: 3, detail: "runner 已有实例在跑(pid 42)" })
    harness.launches[0]!.io.onExit(3)

    const status = harness.controller.status()
    expect(status.phase).toBe("error")
    expect(status.message).toContain("另一个 Yoma 实例")
    expect(harness.timers).toHaveLength(0)
    expect(harness.locks).toEqual([true, false])
  })
})

describe("退避曲线", () => {
  test("5s 起步翻倍,封顶 60s", () => {
    expect(restartDelayMs(1)).toBe(5_000)
    expect(restartDelayMs(2)).toBe(10_000)
    expect(restartDelayMs(5)).toBe(60_000)
    expect(restartDelayMs(9)).toBe(60_000)
  })
})
