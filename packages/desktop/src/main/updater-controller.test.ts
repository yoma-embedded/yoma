import { describe, expect, test } from "bun:test"
import {
  createUpdaterController,
  releaseNotesText,
  type UpdaterBackend,
  type UpdaterDownloadProgress,
  type UpdaterReadyRecord,
  type UpdaterReleaseNotes,
  type UpdaterState,
} from "./updater-controller"

function setup(input?: { currentVersion?: string; ready?: UpdaterReadyRecord }) {
  const calls: string[] = []
  const backend: UpdaterBackend = {
    async checkForUpdates() {
      calls.push("check")
      return { isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }
    },
    async downloadUpdate() {
      calls.push("download")
    },
    quitAndInstall() {
      calls.push("install")
    },
  }
  let ready = input?.ready
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: input?.currentVersion ?? "1.0.0",
    backend,
    persistence: {
      get: () => ready,
      set: (value) => {
        ready = value
      },
      clear: () => {
        ready = undefined
      },
    },
    stop: async () => {
      calls.push("stop")
    },
  })
  return { controller, calls, getReady: () => ready }
}

describe("updater controller", () => {
  test("checks, downloads, persists, and publishes one authoritative ready state", async () => {
    const app = setup()
    const states: ReturnType<typeof app.controller.getState>[] = []
    app.controller.subscribe((state) => states.push(state))

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.getReady()).toEqual({ version: "2.0.0" })
    expect(states.map((state) => state.status)).toEqual(["idle", "checking", "downloading", "ready"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("revalidates a persisted target through the updater cache on launch", async () => {
    const app = setup({ ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("clears a target already installed before checking", async () => {
    const app = setup({ currentVersion: "2.0.0", ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.getReady()).toBeUndefined()
    expect(app.calls).toEqual(["check"])
  })

  test("coalesces concurrent checks", async () => {
    const app = setup()

    await Promise.all([app.controller.check(), app.controller.check(), app.controller.check()])

    expect(app.calls).toEqual(["check", "download"])
  })

  test("returns to ready when quitAndInstall returns without exiting", async () => {
    const app = setup()
    await app.controller.start()

    await app.controller.install()

    expect(app.calls).toEqual(["check", "download", "stop", "install"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("returns to ready when installation cannot start", async () => {
    const app = setup()
    await app.controller.start()

    const failed = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }),
        downloadUpdate: async () => {},
        quitAndInstall() {},
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      stop: async () => {
        throw new Error("stop failed")
      },
    })
    await failed.start()

    await expect(failed.install()).rejects.toThrow("stop failed")
    expect(failed.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })
})

/**
 * 下载进度 / Release 说明 / 自动检查偏好 —— 三样都是用户看得见的东西,
 * 而它们的失效方式都是静默的(进度条不动、说明为空、关了自动检查照样联网)。
 */

type ProgressListener = (progress: UpdaterDownloadProgress) => void

function expectDownloading(state: UpdaterState) {
  if (state.status !== "downloading") throw new Error(`expected downloading, got ${state.status}`)
  return state
}

function expectReady(state: UpdaterState) {
  if (state.status !== "ready") throw new Error(`expected ready, got ${state.status}`)
  return state
}

function progressSetup(input?: {
  releaseNotes?: UpdaterReleaseNotes
  /** downloadUpdate 期间依次喂给订阅者的进度事件。 */
  progress?: UpdaterDownloadProgress[]
  /** false = 后端不提供 onDownloadProgress(老 electron-updater / 无进度)。 */
  withProgressApi?: boolean
  downloadFails?: string
  autoCheck?: () => boolean | Promise<boolean>
}) {
  const calls: string[] = []
  const states: UpdaterState[] = []
  let listener: ProgressListener | undefined
  let unsubscribed = 0

  const backend: UpdaterBackend = {
    async checkForUpdates() {
      calls.push("check")
      return { isUpdateAvailable: true, updateInfo: { version: "2.0.0", releaseNotes: input?.releaseNotes } }
    },
    async downloadUpdate() {
      calls.push("download")
      for (const progress of input?.progress ?? []) listener?.(progress)
      if (input?.downloadFails) throw new Error(input.downloadFails)
    },
    quitAndInstall() {
      calls.push("install")
    },
  }
  if (input?.withProgressApi !== false) {
    backend.onDownloadProgress = (next) => {
      listener = next
      return () => {
        unsubscribed += 1
      }
    }
  }

  const controller = createUpdaterController({
    enabled: true,
    currentVersion: "1.0.0",
    backend,
    persistence: { get: () => undefined, set() {}, clear() {} },
    stop: async () => {
      calls.push("stop")
    },
    prefs: input?.autoCheck ? { autoCheck: input.autoCheck } : undefined,
  })
  controller.subscribe((state) => states.push(state))

  return {
    controller,
    calls,
    states,
    unsubscribed: () => unsubscribed,
    /** 直接喂一条进度(模拟"退订之后仍然到达"的迟到事件)。 */
    emit: (progress: UpdaterDownloadProgress) => listener?.(progress),
  }
}

describe("updater download progress", () => {
  test("publishes percent / transferred / total while downloading", async () => {
    const app = progressSetup({
      progress: [
        { percent: 12.5, transferred: 1250, total: 10000 },
        { percent: 60, transferred: 6000, total: 10000 },
      ],
    })

    await app.controller.check()

    const downloading = app.states.filter((state) => state.status === "downloading").map(expectDownloading)
    expect(downloading.map((state) => state.percent)).toEqual([undefined, 12.5, 60])
    expect(downloading.at(-1)).toEqual({
      status: "downloading",
      version: "2.0.0",
      percent: 60,
      transferred: 6000,
      total: 10000,
    })
  })

  test("unsubscribes the progress listener exactly once when the download finishes", async () => {
    const app = progressSetup({ progress: [{ percent: 50, transferred: 5000, total: 10000 }] })

    await app.controller.check()

    expect(app.controller.getState().status).toBe("ready")
    expect(app.unsubscribed()).toBe(1)
  })

  test("unsubscribes the progress listener when the download fails", async () => {
    const app = progressSetup({ downloadFails: "disk full" })

    const state = await app.controller.check()

    expect(state.status).toBe("error")
    expect(app.unsubscribed()).toBe(1)
  })

  test("ignores progress that arrives after the update is ready", async () => {
    const app = progressSetup({ progress: [{ percent: 50, transferred: 5000, total: 10000 }] })
    await app.controller.check()
    expect(app.controller.getState().status).toBe("ready")

    app.emit({ percent: 99, transferred: 9900, total: 10000 })

    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("still reaches ready when the backend has no progress API", async () => {
    const app = progressSetup({ withProgressApi: false })

    await app.controller.check()

    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })
})

describe("updater release notes", () => {
  test("turns HTML release notes into plain text on the ready state", async () => {
    const app = progressSetup({
      releaseNotes: "<p>Fixed <b>flash</b> timeouts</p><ul><li>gdb reconnects</li></ul>",
    })

    await app.controller.check()

    const notes = expectReady(app.controller.getState()).notes ?? ""
    expect(notes).toContain("Fixed flash timeouts")
    expect(notes).toContain("gdb reconnects")
    expect(notes).not.toContain("<")
    expect(notes).not.toContain(">")
  })

  test("joins the array form of release notes", async () => {
    const app = progressSetup({
      releaseNotes: [
        { version: "2.0.0", note: "<p>scope tool</p>" },
        { version: "1.9.0", note: "logic analyzer" },
      ],
    })

    await app.controller.check()

    const notes = expectReady(app.controller.getState()).notes ?? ""
    expect(notes).toContain("scope tool")
    expect(notes).toContain("logic analyzer")
    expect(notes).not.toContain("<p>")
  })

  test("leaves notes undefined when the release has none", async () => {
    const app = progressSetup()

    await app.controller.check()

    expect(expectReady(app.controller.getState()).notes).toBeUndefined()
  })

  test("releaseNotesText drops empty markup and missing notes", () => {
    expect(releaseNotesText(undefined)).toBeUndefined()
    expect(releaseNotesText(null)).toBeUndefined()
    expect(releaseNotesText("<p></p>")).toBeUndefined()
    expect(releaseNotesText([{ version: "2.0.0", note: null }])).toBeUndefined()
  })

  test("releaseNotesText caps release notes at 4000 characters", () => {
    const long = "a".repeat(5000)

    const text = releaseNotesText(long) ?? ""

    expect(text.length).toBeLessThanOrEqual(4001)
    expect(text.slice(0, 4000)).toBe("a".repeat(4000))
  })
})

describe("updater auto-check preference", () => {
  test("start() and checkPeriodic() do not touch the backend when auto-check is off", async () => {
    const app = progressSetup({ autoCheck: async () => false })

    const started = await app.controller.start()
    const periodic = await app.controller.checkPeriodic()

    expect(started).toEqual({ status: "idle" })
    expect(periodic).toEqual({ status: "idle" })
    expect(app.calls).toEqual([])
  })

  test("a manual check still runs with auto-check off", async () => {
    const app = progressSetup({ autoCheck: () => false })

    await app.controller.start()
    await app.controller.check()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("start() and checkPeriodic() check when auto-check is on", async () => {
    const app = progressSetup({ autoCheck: () => true })

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])

    const periodic = await app.controller.checkPeriodic()
    expect(periodic.status).toBe("ready")
  })

  test("checkPeriodic() checks when no preference is wired at all", async () => {
    const app = progressSetup()

    await app.controller.checkPeriodic()

    expect(app.calls).toEqual(["check", "download"])
  })
})

describe("updater error recovery", () => {
  test("replaces an error state with the next successful check", async () => {
    let attempt = 0
    const controller = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        async checkForUpdates() {
          attempt += 1
          if (attempt === 1) throw new Error("network is down")
          return { isUpdateAvailable: false }
        },
        async downloadUpdate() {},
        quitAndInstall() {},
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      stop: async () => {},
    })

    const failed = await controller.check()
    expect(failed.status).toBe("error")
    expect(failed.status === "error" ? failed.message : "").toContain("network is down")

    const recovered = await controller.check()
    expect(recovered).toEqual({ status: "up-to-date" })
  })
})
