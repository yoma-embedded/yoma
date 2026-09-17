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

/**
 * 这个安装能不能自己给自己升级。
 *
 * mac 的自动更新走 Squirrel.Mac,它要求新包的签名满足**当前运行那一份**的 designated requirement。
 * Developer ID 签的包,requirement 是"同一个 Team ID",版本之间成立;ad-hoc 签的包,requirement 是
 * cdhash —— 每一版都不同,于是 170 MB 下完之后必然死在安装那一步("did not pass validation"),
 * 而且下一次定时检查会原样再来一遍。所以 ad-hoc 的 mac 包走"只通知"模式(`selfUpdate: false`):
 * 照常检查(那一步只读 latest-mac.yml,不碰 Squirrel),有新版就停在 `available`,动作是打开发布页。
 * 打包时 electron-builder.config.ts 把这次是不是 Developer ID 签的写进包内 package.json 的
 * `yoma.macDeveloperId`;读不到一律按"不是"算 —— 错判成只通知只是少一点方便,错判成能自升级
 * 是一个永远失败的下载循环。
 */
export function platformCanSelfUpdate(platform: NodeJS.Platform, packageMeta: unknown): boolean {
  if (platform !== "darwin") return true
  if (!packageMeta || typeof packageMeta !== "object") return false
  const yoma = (packageMeta as { yoma?: unknown }).yoma
  if (!yoma || typeof yoma !== "object") return false
  return (yoma as { macDeveloperId?: unknown }).macDeveloperId === true
}

/**
 * 某一版的发布页。`releaseRepo` 是打包时写进包内 package.json 的发布仓库地址(`yoma.releaseRepo`,
 * 跟着 publish 配置走);读不到、或长得不像一个 GitHub 仓库地址,就用上游仓库 —— 这个值最终进
 * `shell.openExternal`,不拿来路不明的字符串开浏览器。
 * 指到 tag 页而不是 /releases/latest:页面上要有这一版的说明和"首次打开要手动放行"那段提示,
 * 而 latest 在用户点下去的那一刻可能已经是再下一版。
 */
export function releasePageUrl(releaseRepo: unknown, version: string): string {
  const fallback = "https://github.com/yoma-embedded/yoma"
  const valid = typeof releaseRepo === "string" && /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(releaseRepo)
  const base = valid ? releaseRepo : fallback
  return `${base.replace(/\/$/, "")}/releases/tag/v${encodeURIComponent(version)}`
}

export function createUpdaterController(input: {
  enabled: boolean
  /**
   * false = 只通知:查到新版停在 `available`,不下载;`install()` 打开发布页。缺省 true。
   * 见 platformCanSelfUpdate。
   */
  selfUpdate?: boolean
  /** 只通知模式下 `install()` 调它。 */
  openReleasePage?: (version: string) => void | Promise<void>
  currentVersion: string
  backend: UpdaterBackend
  persistence: UpdaterPersistence
  stop: () => Promise<void>
  prefs?: UpdaterPrefs
  log?: (message: string, data?: object) => void
}) {
  const selfUpdate = input.selfUpdate ?? true
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
      // 已经停在 available 上的再查一遍(十分钟一次的定时检查)是安静的:不过 checking,失败也不落 error。
      // 否则标题栏那颗药丸每十分钟闪一下,断一次网它就消失到下次查通为止 —— 而"有新版"这件事并没有变。
      if (state.status !== "available") transition({ status: "checking" })
      const result = await input.backend.checkForUpdates()
      const version = result?.updateInfo?.version
      if (!result?.isUpdateAvailable || !version || version === input.currentVersion) {
        await input.persistence.clear()
        return transition({ status: "up-to-date" })
      }

      // 只通知:到此为止。不下载(装不上,见 platformCanSelfUpdate)、不落 ready 记录(没有东西等着装)。
      if (selfUpdate === false) {
        return transition({ status: "available", version, notes: releaseNotesText(result.updateInfo?.releaseNotes) })
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
      .catch((error) => {
        if (state.status === "available") {
          input.log?.("updater re-check failed; keeping available", { message: String(error) })
          return state
        }
        return transition({ status: "error", message: error instanceof Error ? error.message : String(error) })
      })
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
      // 只通知模式:界面上所有"装这个更新"的入口(toast、标题栏药丸、设置页按钮、错误页)走的都是
      // 这一个 install(),所以在这里换成"打开发布页",那几处不用各自知道有两种安装。状态不动 ——
      // 用户可能只是看了一眼没下载,药丸和设置页的那一行应该还在。
      if (state.status === "available") {
        await input.openReleasePage?.(state.version)
        return
      }
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
