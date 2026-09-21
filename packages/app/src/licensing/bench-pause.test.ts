import { describe, expect, test } from "vitest"
import type { LicenseRequiredData, MailboxStatusView } from "@yoma-desktop/kernel"
import { selectBenchLicensePause } from "./bench-pause"

const required = (over: Partial<LicenseRequiredData> = {}): LicenseRequiredData => ({
  _tag: "LicenseRequiredError",
  state: "expired",
  execution: "mailbox.start",
  expiresAt: "2026-10-21T00:00:00.000Z",
  ...over,
})

const status = (over: Partial<MailboxStatusView>): MailboxStatusView => ({ phase: "idle", ...over })

describe("调试台的授权暂停横幅", () => {
  test("什么都没有 → 没有横幅", () => {
    expect(selectBenchLicensePause({})).toBeUndefined()
    expect(selectBenchLicensePause({ status: status({ phase: "running" }) })).toBeUndefined()
    expect(selectBenchLicensePause({ status: status({ phase: "done" }) })).toBeUndefined()
  })

  test("phase paused → 要人重新点开始", () => {
    const pause = selectBenchLicensePause({
      status: status({ phase: "paused", license: required() }),
      licenseState: "expired",
    })
    expect(pause?.note).toBe("bench.license.note.restart")
    expect(pause?.state).toBe("expired")
    expect(pause?.instant).toBe("2026-10-21T00:00:00.000Z")
    expect(pause?.resolved).toBe(false)
  })

  test("退出码 4(done 带 license)→ 也是要人点开始,并带上守护给的原文", () => {
    const pause = selectBenchLicensePause({
      status: status({ phase: "done", done: { exitCode: 4, detail: "no valid license", license: required() } }),
    })
    expect(pause?.note).toBe("bench.license.note.restart")
    expect(pause?.detail).toBe("no valid license")
  })

  test("start() 被拒(status 还没到)→ 横幅也要出", () => {
    const pause = selectBenchLicensePause({ startPause: required({ state: "missing" }) })
    expect(pause?.note).toBe("bench.license.note.restart")
    expect(pause?.state).toBe("missing")
    // missing 没有日期可说 —— 不许编一个出来。
    expect(pause?.instant).toBeUndefined()
  })

  test("守护已经不在了(被停掉 / 退出)→ 不再承诺「它自己会接着跑」", () => {
    const stale = { state: "expired", detail: "paused at round 3", expiresAt: "2026-10-21T00:00:00.000Z" }
    for (const phase of ["idle", "done", "error"] as const) {
      expect(
        selectBenchLicensePause({ status: status({ phase, message: "已停止" }), stepPause: stale, licenseState: "expired" }),
        phase,
      ).toBeUndefined()
    }
  })

  test("start() 被拦时,上一单留下的 done.detail 不会被当成这次暂停的原因", () => {
    const pause = selectBenchLicensePause({
      status: status({
        phase: "paused",
        license: required(),
        message: "软件授权已到期",
        // 上一单的收场白:没有 license,与这次暂停无关。
        done: { exitCode: 0, detail: "终局 passed" },
      }),
      licenseState: "expired",
    })
    expect(pause?.detail).toBe("软件授权已到期")
  })

  test("守护还活着、停在轮次边界 → 它自己会接着跑", () => {
    const pause = selectBenchLicensePause({
      status: status({ phase: "running" }),
      stepPause: { state: "expired", detail: "paused at round 3", expiresAt: "2026-10-21T00:00:00.000Z" },
      licenseState: "expired",
    })
    expect(pause?.note).toBe("bench.license.note.autoResume")
    expect(pause?.detail).toBe("paused at round 3")
    expect(pause?.instant).toBe("2026-10-21T00:00:00.000Z")
  })

  /**
   * 跑着的时候 `status.done` 里可能还躺着**上一单**的记录。拿它说话会在任务跑得好好的
   * 时候挂出一条"已暂停"——这条用例就是为它写的。
   */
  test("跑着的时候不看上一单留在 done 里的 license", () => {
    expect(
      selectBenchLicensePause({
        status: status({ phase: "running", done: { exitCode: 4, detail: "old", license: required() } }),
      }),
    ).toBeUndefined()
    expect(
      selectBenchLicensePause({
        status: status({ phase: "stopping", done: { exitCode: 4, detail: "old", license: required() } }),
      }),
    ).toBeUndefined()
  })

  test("授权补好之后:自己会接着跑的那一种收掉,要人点开始的那一种换成「已就绪」", () => {
    // 轮次边界那一种:守护下一次轮询自己就跑了,横幅不该再吓人。
    expect(
      selectBenchLicensePause({
        status: status({ phase: "running" }),
        stepPause: { state: "expired" },
        licenseState: "active",
      }),
    ).toBeUndefined()
    // 要人点开始的那一种:横幅留着,但话换成"授权已就绪"。
    const pause = selectBenchLicensePause({
      status: status({ phase: "paused", license: required() }),
      licenseState: "active",
    })
    expect(pause?.resolved).toBe(true)
    expect(pause?.note).toBe("bench.license.note.restart")
  })

  test("开发态(not-required)也算就绪", () => {
    expect(
      selectBenchLicensePause({ stepPause: { state: "missing" }, licenseState: "not-required" }),
    ).toBeUndefined()
  })

  test("授权状态还没读到时按「没就绪」算 —— 不许乐观地说已就绪", () => {
    const pause = selectBenchLicensePause({ status: status({ phase: "paused" }) })
    expect(pause?.resolved).toBe(false)
    // 没有任何状态可说时 state 是 undefined,界面据此一句都不说(而不是回落成"已就绪")。
    expect(pause?.state).toBeUndefined()
  })

  test("phase paused 但状态只在共享 store 里 → 用它说话", () => {
    const pause = selectBenchLicensePause({ status: status({ phase: "paused" }), licenseState: "missing" })
    expect(pause?.state).toBe("missing")
    expect(pause?.resolved).toBe(false)
  })
})
