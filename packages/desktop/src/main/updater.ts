import { app, dialog } from "electron"
import pkg from "electron-updater"
import { UPDATER_ENABLED } from "./constants"
import {
  createUpdaterController,
  type UpdaterDownloadProgress,
  type UpdaterReadyRecord,
  type UpdaterReleaseNotes,
} from "./updater-controller"
import { getLogger } from "./logging"
import { getStore } from "./store"

const { autoUpdater } = pkg
const key = "ready"
const AUTO_CHECK_KEY = "autoCheck"

/**
 * "启动时 / 定时自动检查"的开关,持久化在 yoma.updater 这份 store 里。默认开:热升级的
 * 意义就是用户什么都不用做;关掉的用户仍能在设置页手动检查。
 */
export function updaterAutoCheckPrefs() {
  const store = getStore("yoma.updater")
  return {
    get(): boolean {
      const value = store.get(AUTO_CHECK_KEY)
      return typeof value === "boolean" ? value : true
    },
    set(value: boolean): void {
      store.set(AUTO_CHECK_KEY, value)
    },
  }
}

/**
 * relaunch(自动更新以外的重启:换显示后端等)前调:electron-updater 的"退出时安装"挂在
 * `quit` 事件上,而 relaunch 是 app.relaunch() + app.exit(0) —— 两者叠加会一边跑 NSIS 换文件
 * 一边把旧 exe 拉起来。关掉之后这次更新留到下一次正常退出再装。
 */
export function disableInstallOnQuit() {
  autoUpdater.autoInstallOnAppQuit = false
}

export function setupAutoUpdater(stop: () => Promise<void>) {
  const logger = getLogger()
  autoUpdater.logger = logger
  // 不设 channel:prod 的 publish 配置本来就是 latest,而 electron-updater 的 channel
  // setter 会顺手把 allowDowngrade 置成 true —— 从前这里显式设 channel 又显式开
  // allowDowngrade,结果是 GitHub 上哪个 Release 被标成 latest 用户就会被换到哪个版本
  // (engines-v* 这类同仓 Release 一旦被标 latest 就是降级)。现在只升不降。
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = false
  // 下好的更新在正常退出时自动装上(before-quit 已经先 stopSidecars):用户没点"重启"
  // 也不会一直停在旧版本 —— 这是"热升级"里最省心的那一半。
  autoUpdater.autoInstallOnAppQuit = true
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit,
    currentVersion: app.getVersion(),
  })

  const store = getStore("yoma.updater")
  const prefs = updaterAutoCheckPrefs()
  return createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion: app.getVersion(),
    backend: {
      checkForUpdates: async () => {
        const result = await autoUpdater.checkForUpdates()
        if (!result) return result
        const info = result.updateInfo as { version?: string; releaseNotes?: UpdaterReleaseNotes } | undefined
        return {
          isUpdateAvailable: result.isUpdateAvailable,
          updateInfo: info ? { version: info.version, releaseNotes: info.releaseNotes } : undefined,
        }
      },
      downloadUpdate: () => autoUpdater.downloadUpdate(),
      quitAndInstall: () => autoUpdater.quitAndInstall(),
      onDownloadProgress: (listener) => {
        const handler = (progress: { percent: number; transferred: number; total: number; bytesPerSecond: number }) =>
          listener({
            percent: progress.percent,
            transferred: progress.transferred,
            total: progress.total,
            bytesPerSecond: progress.bytesPerSecond,
          } satisfies UpdaterDownloadProgress)
        autoUpdater.on("download-progress", handler)
        return () => {
          autoUpdater.off("download-progress", handler)
        }
      },
    },
    persistence: {
      get() {
        const value = store.get(key)
        if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") return
        return { version: value.version } satisfies UpdaterReadyRecord
      },
      set: (value) => store.set(key, value),
      clear: () => store.delete(key),
    },
    prefs: { autoCheck: () => prefs.get() },
    stop,
    log: (message, data) => logger.log(message, data),
  })
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "error", message: "Update check failed.", title: "Update Error" })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "info", message: "You're up to date.", title: "No Updates" })
    return
  }
  if (state.status !== "ready") return

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${state.version} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response === 0) await controller.install()
}
