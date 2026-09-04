import type { UpdaterState } from "@yoma-desktop/app/updater"

export type { UpdaterState } from "@yoma-desktop/app/updater"

export type UpdaterReadyRecord = { version: string }

export type UpdaterDownloadProgress = {
  percent: number
  transferred: number
  total: number
  bytesPerSecond?: number
}

/** electron-updater 的 updateInfo.releaseNotes 有两种形状(GitHub provider 给字符串)。 */
export type UpdaterReleaseNotes = string | Array<{ version: string; note: string | null }> | null | undefined

export type UpdaterBackend = {
  checkForUpdates(): Promise<
    { isUpdateAvailable?: boolean; updateInfo?: { version?: string; releaseNotes?: UpdaterReleaseNotes } } | null | undefined
  >
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  /** 下载进度订阅;返回退订函数。不提供就没有百分比。 */
  onDownloadProgress?(listener: (progress: UpdaterDownloadProgress) => void): () => void
}

type UpdaterPersistence = {
  get(): UpdaterReadyRecord | undefined | Promise<UpdaterReadyRecord | undefined>
  set(value: UpdaterReadyRecord): void | Promise<void>
  clear(): void | Promise<void>
}

export type UpdaterPrefs = {
  /** 启动时 / 定时自动检查。手动 check() 不看它。 */
  autoCheck(): boolean | Promise<boolean>
}

/** Release 说明 → 纯文本:剥 HTML 标签、合并空白、封顶 4000 字。 */
export function releaseNotesText(notes: UpdaterReleaseNotes): string | undefined {
  if (!notes) return undefined
  const raw = typeof notes === "string" ? notes : notes.map((n) => n.note ?? "").join("\n")
  const text = raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|div|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (!text) return undefined
  // 前 4000 字原样保留,超出的用一个省略号收尾(总长 4001)—— 测试钉的是"前 4000 字不丢"。
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
}

export function createUpdaterController(input: {
  enabled: boolean
  currentVersion: string
  backend: UpdaterBackend
  persistence: UpdaterPersistence
  stop: () => Promise<void>
  prefs?: UpdaterPrefs
  log?: (message: string, data?: object) => void
}) {
  let state: UpdaterState = input.enabled ? { status: "idle" } : { status: "disabled" }
  let pending: Promise<UpdaterState> | undefined
  const listeners = new Set<(state: UpdaterState) => void>()

  const transition = (next: UpdaterState) => {
    input.log?.("updater state changed", { from: state.status, to: next.status })
    state = next
    listeners.forEach((listener) => listener(state))
    return state
  }

  const check = () => {
    if (!input.enabled) return Promise.resolve(state)
    if (state.status === "ready") return Promise.resolve(state)
    if (pending) return pending

    pending = (async () => {
      transition({ status: "checking" })
      const result = await input.backend.checkForUpdates()
      const version = result?.updateInfo?.version
      if (!result?.isUpdateAvailable || !version || version === input.currentVersion) {
        await input.persistence.clear()
        return transition({ status: "up-to-date" })
      }

      transition({ status: "downloading", version })
      const unsubscribe = input.backend.onDownloadProgress?.((progress) => {
        if (state.status !== "downloading") return
        transition({
          status: "downloading",
          version,
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
        })
      })
      try {
        await input.backend.downloadUpdate()
      } finally {
        unsubscribe?.()
      }
      await input.persistence.set({ version })
      return transition({ status: "ready", version, notes: releaseNotesText(result.updateInfo?.releaseNotes) })
    })()
      .catch((error) =>
        transition({ status: "error", message: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  const autoCheckEnabled = async () => (input.prefs ? await input.prefs.autoCheck() : true)

  return {
    getState: () => state,
    subscribe(listener: (state: UpdaterState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    /** 启动时:清掉"上次已下好"的记录(如果就是当前版本),然后按偏好决定要不要查。 */
    async start() {
      const ready = await input.persistence.get()
      if (ready?.version === input.currentVersion) await input.persistence.clear()
      if (!(await autoCheckEnabled())) return state
      return check()
    },
    /** 定时检查:偏好关了就什么都不做。手动检查走 check()。 */
    async checkPeriodic() {
      if (!(await autoCheckEnabled())) return state
      return check()
    },
    check,
    async install() {
      if (state.status !== "ready") throw new Error("Update is not ready to install")
      const version = state.version
      transition({ status: "installing", version })
      await input
        .stop()
        .then(() => {
          input.backend.quitAndInstall()
          transition({ status: "ready", version })
        })
        .catch((error) => {
          transition({ status: "ready", version })
          throw error
        })
    },
  }
}

export type UpdaterController = ReturnType<typeof createUpdaterController>
