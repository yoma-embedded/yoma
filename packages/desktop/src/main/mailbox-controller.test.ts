/**
 * 任务控制器的纯逻辑测试:状态机、退避重启、锁冲突人话。
 * spawn/杀树/广播全是假的 —— 真进程与杀树语义由 e2e-mailbox-ipc 在真 Electron 里钉。
 */

import { describe, expect, test } from "vitest"

import type { MailboxHostConfig } from "@yoma-desktop/bench"
import type { LicenseRequiredData } from "@yoma-desktop/kernel"
import {
  MailboxController,
  restartDelayMs,
  type MailboxControllerDeps,
  type MailboxLaunchHandle,
  type MailboxPublicEvent,
  type MailboxSettings,
} from "./mailbox-controller.ts"

interface Harness {
  controller: MailboxController
  launches: { config: MailboxHostConfig; io: { onLine(line: string): void; onExit(code: number | null): void } }[]
  stops: { pid?: number; force: boolean }[]
  events: MailboxPublicEvent[]
  saved: MailboxSettings | undefined
  timers: { fn: () => void; ms: number; cancelled: boolean }[]
  /** 假时钟:退避与"活过一分钟"的判定都读它。 */
  clock: number
  /** 让下一次 launch 同步抛(模拟产物缺失、路径不可写)。 */
  launchThrows?: string
  /** 接线层的兜底工程目录(真实现里是 composeJob 从模板位置推导出来的)。 */
  derivedProjectDir?: string
  /** 授权:undefined = 不检查(社区构建 / 没注入);给了就是"这台机器现在的资格"。 */
  licensed?: { ok: true } | { ok: false; message: string; data: LicenseRequiredData }
}

const EXPIRED: LicenseRequiredData = {
  _tag: "LicenseRequiredError",
  state: "expired",
  execution: "mailbox.start",
  expiresAt: "2026-09-01T00:00:00Z",
}

function makeHarness(initial?: MailboxSettings): Harness {
  const harness: Partial<Harness> = {
    launches: [],
    stops: [],
    events: [],
    saved: initial,
    timers: [],
    clock: 1_000_000,
  }
  const deps: MailboxControllerDeps = {
    now: () => harness.clock!,
    launch: (config, io) => {
      if (harness.launchThrows) throw new Error(harness.launchThrows)
      harness.launches!.push({ config, io })
      return { pid: 1000 + harness.launches!.length } satisfies MailboxLaunchHandle
    },
    stopProcess: (handle, force) => harness.stops!.push({ pid: handle.pid, force }),
    broadcast: (event) => harness.events!.push(event),
    persistence: {
      get: () => harness.saved,
      set: (settings) => {
        harness.saved = settings
      },
    },
    // 接线层的口径:已保存的配置优先,其次 composeJob 推导出的项目根。
    projectDir: (settings) => settings.projectDir?.trim() || harness.derivedProjectDir,
    buildConfig: (settings, task) => ({
      role: task.kind === "init" ? "init" : task.kind,
      remote: settings.remote,
      clone: "/tmp/clone",
      jobFile: task.jobFile,
      sessionsRoot: "/tmp/sessions",
      projectDir: settings.projectDir?.trim() || harness.derivedProjectDir,
    }),
    schedule: (fn, ms) => {
      const entry = { fn, ms, cancelled: false }
      harness.timers!.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    // 每次都问 harness 的当前值:用例要能在"暂停之后导入了授权"这一刻把答案改掉。
    checkLicense: () => harness.licensed ?? { ok: true },
  }
  harness.controller = new MailboxController(deps)
  return harness as Harness
}

const SETTINGS: MailboxSettings = { remote: "git@example.com:mail.git", role: "runner", projectDir: "/work/fw" }

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
  test("runner 起停:一次一个任务,停止是整棵树的语义", () => {
    const harness = makeHarness(SETTINGS)
    expect(harness.controller.start({ kind: "runner" })).toEqual({ ok: true })
    expect(harness.launches[0]!.config.role).toBe("runner")
    expect(harness.controller.start({ kind: "runner" }).ok).toBe(false)

    harness.controller.stop()
    expect(harness.stops).toEqual([{ pid: 1001, force: false }])
    expect(harness.controller.status().phase).toBe("stopping")

    harness.launches[0]!.io.onExit(143)
    expect(harness.controller.status().phase).toBe("idle")
  })

  test("mother 是常驻角色异常退出会重启;init 一次性失败即 error 不重启", () => {
    const harness = makeHarness({ ...SETTINGS, role: "mother" })
    harness.controller.start({ kind: "mother" })

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

  test("快照与终局进 status", () => {
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
  })

  test("崩溃退避重启;停止取消重启", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "runner" })
    harness.launches[0]!.io.onExit(1)

    expect(harness.controller.status().message).toContain("重启")
    expect(harness.timers).toHaveLength(1)
    expect(harness.timers[0]!.ms).toBe(restartDelayMs(1))

    harness.timers[0]!.fn()
    expect(harness.launches).toHaveLength(2)

    harness.launches[1]!.io.onExit(1)
    expect(harness.timers[1]!.ms).toBe(restartDelayMs(2))
    harness.controller.stop()
    expect(harness.timers[1]!.cancelled).toBe(true)
    expect(harness.controller.status().phase).toBe("idle")
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

describe("审查修复", () => {
  test("永久性故障不无限重启:连续起来就死会放弃", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "runner" })
    // 每次都是"起来就死"(时钟不前进 → 活不到 HEALTHY_MS)。
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const launch = harness.launches[harness.launches.length - 1]!
      launch.io.onExit(1)
      const timer = harness.timers[harness.timers.length - 1]
      if (harness.controller.status().phase === "error") break
      timer!.fn()
    }
    const status = harness.controller.status()
    expect(status.phase).toBe("error")
    expect(status.message).toContain("不再重试")
    // 5 次重启用完就收手:第 6 次死亡没有再排定时器(6 次 launch / 5 个定时器)。
    expect(harness.launches).toHaveLength(6)
    expect(harness.timers).toHaveLength(5)
  })

  test("跑了一阵才崩的不算连击:重启计数复位", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "runner" })
    harness.launches[0]!.io.onExit(1)
    expect(harness.timers[0]!.ms).toBe(restartDelayMs(1))
    harness.timers[0]!.fn()

    // 这一次活了两分钟才崩 —— 属于"跑起来过",计数回到 1 而不是累进到 2。
    harness.clock += 120_000
    harness.launches[1]!.io.onExit(1)
    expect(harness.timers[1]!.ms).toBe(restartDelayMs(1))
    expect(harness.controller.status().task?.restarts).toBe(1)
  })

  test("launch 同步抛不会把 phase 卡在 running", () => {
    const harness = makeHarness(SETTINGS)
    harness.launchThrows = "spawn ENOENT"
    const started = harness.controller.start({ kind: "runner" })
    expect(started.ok).toBe(true)

    const status = harness.controller.status()
    expect(status.phase).toBe("error")
    expect(status.message).toContain("spawn ENOENT")
    // 没有残留任务卡住下一次开跑。
    expect(harness.controller.start({ kind: "runner" }).ok).toBe(true)
  })

  test("init 的接力由 main 完成,角色取已保存配置(不受 UI 生死影响)", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "init", jobFile: "/tmp/job.json", thenStart: true })
    expect(harness.launches[0]!.config.role).toBe("init")

    emit(harness, 0, { type: "done", exitCode: 0, detail: "已入箱" })
    harness.launches[0]!.io.onExit(0)

    // 第二个进程是本机角色的常驻守护。
    expect(harness.launches).toHaveLength(2)
    expect(harness.launches[1]!.config.role).toBe("runner")
    expect(harness.controller.status().phase).toBe("running")
    expect(harness.controller.status().task?.kind).toBe("runner")
  })

  test("init 失败不接力", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "init", jobFile: "/tmp/job.json", thenStart: true })
    emit(harness, 0, { type: "done", exitCode: 1, detail: "spec 校验失败" })
    harness.launches[0]!.io.onExit(1)

    expect(harness.launches).toHaveLength(1)
    expect(harness.controller.status().phase).toBe("error")
  })

  test("角色与配置不符时拒绝开跑 —— 工位机上起决策守护是安静的错", () => {
    const harness = makeHarness(SETTINGS)
    const refused = harness.controller.start({ kind: "mother" })
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.message).toContain("本机角色是工位端")
    expect(harness.launches).toHaveLength(0)
  })
})

describe("本机工程目录", () => {
  test("保存设置不拦空目录,只做 trim —— 先填远端回头再填目录是常态", () => {
    const harness = makeHarness()
    expect(harness.controller.configure({ remote: "git@example.com:mail.git", role: "runner" })).toEqual({ ok: true })
    expect(harness.saved?.projectDir).toBeUndefined()

    harness.controller.configure({ ...SETTINGS, projectDir: "  /work/fw  " })
    expect(harness.saved?.projectDir).toBe("/work/fw")
  })

  test("研发端没配工程目录就拒绝开跑,而且说人话", () => {
    const harness = makeHarness({ remote: "git@example.com:mail.git", role: "mother" })
    const refused = harness.controller.start({ kind: "mother" })
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.message).toContain("工程目录")
    // 拦在开跑之前,所以进程根本没起。
    expect(harness.launches).toHaveLength(0)
  })

  test("工位端不需要工程目录 —— 它没有项目检出,东西全靠信箱附件", () => {
    const harness = makeHarness({ remote: "git@example.com:mail.git", role: "runner" })
    expect(harness.controller.start({ kind: "runner" })).toEqual({ ok: true })
    expect(harness.launches[0]!.config.role).toBe("runner")
  })

  test("演练不需要工程目录 —— 它的工作树是自己生成的一次性目标仓", () => {
    const harness = makeHarness({ remote: "git@example.com:mail.git", role: "runner" })
    expect(harness.controller.start({ kind: "sim", fresh: true })).toEqual({ ok: true })
    expect(harness.launches[0]!.config.role).toBe("sim")
  })

  test("接线层推导出的项目根顶得上:出题机不用先去配置页填一遍", () => {
    const harness = makeHarness({ remote: "git@example.com:mail.git", role: "runner" })
    harness.derivedProjectDir = "/Users/ben/fw"
    expect(harness.controller.start({ kind: "runner" })).toEqual({ ok: true })
    expect(harness.launches[0]!.config.projectDir).toBe("/Users/ben/fw")
  })

  test("已保存的配置优先于推导,并且真的进了守护配置", () => {
    const harness = makeHarness(SETTINGS)
    harness.derivedProjectDir = "/Users/ben/fw"
    harness.controller.start({ kind: "runner" })
    expect(harness.launches[0]!.config.projectDir).toBe("/work/fw")
  })
})

describe("软件授权", () => {
  test("授权不满足时四种 kind 都不 spawn,落 paused 并带上原因", () => {
    for (const kind of ["runner", "mother", "sim", "init"] as const) {
      const harness = makeHarness({ ...SETTINGS, role: kind === "mother" ? "mother" : "runner" })
      harness.licensed = { ok: false, message: "软件授权已于 2026-09-01 到期", data: EXPIRED }

      const started = harness.controller.start({ kind, jobFile: kind === "init" ? "/tmp/job.json" : undefined })
      expect(started.ok, kind).toBe(false)
      expect(started.ok === false && started.license, kind).toEqual(EXPIRED)
      // 关键断言:进程根本没起。守护一起来就会去轮询、开分支、烧板子。
      expect(harness.launches, kind).toHaveLength(0)

      const status = harness.controller.status()
      expect(status.phase, kind).toBe("paused")
      expect(status.license, kind).toEqual(EXPIRED)
      expect(status.message, kind).toContain("到期")
      // paused 不是 error:任务状态完好,界面不该把人引去查日志。
      expect(status.phase, kind).not.toBe("error")
    }
  })

  test("paused 之后导入了授权,再点开跑就正常 spawn", () => {
    const harness = makeHarness(SETTINGS)
    harness.licensed = { ok: false, message: "尚未激活", data: { ...EXPIRED, state: "missing" } }
    expect(harness.controller.start({ kind: "runner" }).ok).toBe(false)
    expect(harness.controller.status().phase).toBe("paused")

    // 用户在设置页导入了授权文件 —— 服务每次重新读盘,所以下一次问就是新答案。
    harness.licensed = { ok: true }
    expect(harness.controller.start({ kind: "runner" })).toEqual({ ok: true })
    expect(harness.launches).toHaveLength(1)
    const status = harness.controller.status()
    expect(status.phase).toBe("running")
    // 过期的解释要擦掉,否则界面一直挂着"去激活"。
    expect(status.license).toBeUndefined()
  })

  test("paused 态下可以改配置", () => {
    const harness = makeHarness(SETTINGS)
    harness.licensed = { ok: false, message: "尚未激活", data: EXPIRED }
    harness.controller.start({ kind: "runner" })
    expect(harness.controller.status().phase).toBe("paused")
    // 只有 running / stopping 才拒改配置 —— 暂停期间换个远端、填工程目录都该允许。
    expect(harness.controller.configure({ ...SETTINGS, branch: "next" })).toEqual({ ok: true })
    expect(harness.saved?.branch).toBe("next")
  })

  test("退出码 4:不重启,落 paused 并带上守护报的原因", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "runner" })
    emit(harness, 0, { type: "done", exitCode: 4, detail: "授权已于 2026-09-01 到期", license: EXPIRED })
    harness.launches[0]!.io.onExit(4)

    const status = harness.controller.status()
    expect(status.phase).toBe("paused")
    expect(status.license).toEqual(EXPIRED)
    expect(status.message).toContain("任务状态已保留")
    // 重启只会得到同一个退出码,而退避期间 phase 显示的是 running —— 看起来像在干活。
    expect(harness.timers).toHaveLength(0)
    expect(harness.launches).toHaveLength(1)
  })

  test("退出码 0 但带 license(跑着的时候到期,在轮次边界收场)也是 paused,不是 done、不重启", () => {
    // 守护那边的第二种形态(bench 的 mailbox/host.ts:finish(0, detail, undefined, license))。
    // 只认退出码 4 的话,常驻角色会掉进崩溃退避,屏幕上是"异常退出(code 0),5s 后重启"。
    for (const kind of ["runner", "sim"] as const) {
      const harness = makeHarness(SETTINGS)
      harness.controller.start({ kind })
      emit(harness, 0, { type: "done", exitCode: 0, detail: "授权到期,已在第 3 轮边界停下", license: EXPIRED })
      harness.launches[0]!.io.onExit(0)

      const status = harness.controller.status()
      expect(status.phase, kind).toBe("paused")
      expect(status.license, kind).toEqual(EXPIRED)
      expect(status.message, kind).toContain("轮次边界")
      expect(harness.timers, kind).toHaveLength(0)
      expect(harness.launches, kind).toHaveLength(1)
    }
  })

  test("退出码 4 但事件没带 license 也要落 paused(不能掉回崩溃重启)", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "runner" })
    emit(harness, 0, { type: "done", exitCode: 4, detail: "没有有效授权" })
    harness.launches[0]!.io.onExit(4)

    expect(harness.controller.status().phase).toBe("paused")
    expect(harness.controller.status().license?._tag).toBe("LicenseRequiredError")
    expect(harness.timers).toHaveLength(0)
  })

  test("init 的接力被授权拦住 → paused 而不是 error(入箱是成功的)", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "init", jobFile: "/tmp/job.json", thenStart: true })
    // init 自己跑完了(那一刻还有授权),接力常驻角色时才撞上到期。
    harness.licensed = { ok: false, message: "软件授权已到期", data: EXPIRED }
    emit(harness, 0, { type: "done", exitCode: 0, detail: "已入箱" })
    harness.launches[0]!.io.onExit(0)

    expect(harness.launches).toHaveLength(1)
    const status = harness.controller.status()
    expect(status.phase).toBe("paused")
    expect(status.license).toEqual(EXPIRED)
    expect(status.message).toContain("任务已入箱")
  })

  test("崩溃重启之前再问一次:期间到期就暂停,不反复拉起注定退出的守护", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "runner" })
    harness.launches[0]!.io.onExit(1)
    expect(harness.timers).toHaveLength(1)

    // 退避窗口跨过了到期时刻。
    harness.licensed = { ok: false, message: "软件授权已到期", data: EXPIRED }
    harness.timers[0]!.fn()

    expect(harness.launches).toHaveLength(1)
    const status = harness.controller.status()
    expect(status.phase).toBe("paused")
    expect(status.license).toEqual(EXPIRED)
  })

  test("停止在任何授权状态下照常 —— 在飞的任务永远停得掉", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "runner" })
    // 跑起来之后授权到期(守护还没查到):用户按停止,必须照常杀树。
    harness.licensed = { ok: false, message: "软件授权已到期", data: EXPIRED }
    expect(harness.controller.stop()).toEqual({ ok: true })
    expect(harness.stops).toEqual([{ pid: 1001, force: false }])
    harness.launches[0]!.io.onExit(143)
    expect(harness.controller.status().phase).toBe("idle")
  })

  test("退出码 3(锁冲突)等老路径不受影响", () => {
    const harness = makeHarness(SETTINGS)
    harness.controller.start({ kind: "runner" })
    emit(harness, 0, { type: "done", exitCode: 3, detail: "runner 已有实例在跑(pid 42)" })
    harness.launches[0]!.io.onExit(3)

    const status = harness.controller.status()
    expect(status.phase).toBe("error")
    expect(status.message).toContain("另一个 Yoma 实例")
    expect(status.license).toBeUndefined()
  })

  test("不注入 checkLicense 时行为与从前一字不差", () => {
    const harness = makeHarness(SETTINGS)
    harness.licensed = undefined
    expect(harness.controller.start({ kind: "runner" })).toEqual({ ok: true })
    expect(harness.launches).toHaveLength(1)
    expect(harness.controller.status().license).toBeUndefined()
  })
})
