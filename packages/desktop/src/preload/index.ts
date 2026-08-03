import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { ElectronAPI } from "./types"
import type { UpdaterState } from "@yoma-desktop/app/updater"
import type { ManualsEvent } from "@yoma-desktop/app/manuals/types"

const updaterCallbacks = new Set<(state: UpdaterState) => void>()
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

/**
 * 内核通道。
 *
 * MessagePort **不能** 过 contextBridge,所以端口留在 preload world 里,只把
 * request/subscribe 两个函数暴露给 renderer。数据全是可结构化克隆的纯对象。
 *
 * 窗口 reload 之后端口会失效 —— 这里主动 invoke("kernel-attach") 让 main 重新牵一次线,
 * 内核那边会回一个 kernel.connected,前端据此重新 bootstrap。
 */
const kernelPending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>()
const kernelListeners = new Set<(events: unknown[]) => void>()
let kernelPort: MessagePort | undefined
let kernelNextId = 1

ipcRenderer.on("kernel-port", (event) => {
  const port = event.ports[0]
  if (!port) return
  kernelPort?.close()
  kernelPort = port
  port.onmessage = (message: MessageEvent) => {
    const frame = message.data as
      | { kind: "response"; id: number; result?: unknown; error?: { message: string; data?: unknown } }
      | { kind: "push"; events: unknown[] }
      | undefined
    if (!frame) return
    if (frame.kind === "push") {
      kernelListeners.forEach((listener) => listener(frame.events))
      return
    }
    const entry = kernelPending.get(frame.id)
    if (!entry) return
    kernelPending.delete(frame.id)
    if (frame.error) {
      // 必须把 data 一起带上 —— 只重建 message 的话,结构化信息(比如"会话不存在")
      // 就在这一层丢了,前端只能把它当成致命错误。这是整条链上最容易漏掉的一环。
      const error = new Error(frame.error.message) as Error & { data?: unknown }
      if (frame.error.data) error.data = frame.error.data
      entry.reject(error)
    }
    else entry.resolve(frame.result)
  }
  port.start()
})

const kernel = {
  request(method: string, params: unknown) {
    return new Promise((resolve, reject) => {
      if (!kernelPort) {
        reject(new Error("内核通道尚未建立"))
        return
      }
      const id = kernelNextId++
      kernelPending.set(id, { resolve, reject })
      kernelPort.postMessage({ kind: "request", id, method, params })
    })
  },
  subscribe(handler: (events: unknown[]) => void) {
    kernelListeners.add(handler)
    return () => {
      kernelListeners.delete(handler)
    }
  },
  reattach: () => ipcRenderer.invoke("kernel-attach"),
}

const api: ElectronAPI = {
  kernel,
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  manuals: {
    config: () => ipcRenderer.invoke("manuals-config"),
    list: () => ipcRenderer.invoke("manuals-list"),
    download: (chip, rev) => ipcRenderer.invoke("manuals-download", chip, rev),
    updateIndex: () => ipcRenderer.invoke("manuals-index-update"),
    ingest: (req) => ipcRenderer.invoke("manuals-ingest", req),
    cancelIngest: () => ipcRenderer.invoke("manuals-cancel-ingest"),
    subscribe: (cb) => {
      const handler = (_: unknown, event: ManualsEvent) => cb(event)
      ipcRenderer.on("manuals-event", handler)
      void ipcRenderer.invoke("manuals-subscribe")
      return () => {
        ipcRenderer.removeListener("manuals-event", handler)
        void ipcRenderer.invoke("manuals-unsubscribe")
      }
    },
  },
  updater: {
    subscribe: async (cb) => {
      updaterCallbacks.add(cb)
      if (updaterState) cb(updaterState)
      if (!updaterSubscription) {
        ipcRenderer.on("updater-state", updaterHandler)
        updaterSubscription = ipcRenderer.invoke("updater-subscribe")
      }
      await updaterSubscription
      return () => {
        updaterCallbacks.delete(cb)
        if (updaterCallbacks.size > 0) return
        ipcRenderer.removeListener("updater-state", updaterHandler)
        updaterSubscription = undefined
        void ipcRenderer.invoke("updater-unsubscribe")
      }
    },
    check: () => ipcRenderer.invoke("updater-check"),
    install: () => ipcRenderer.invoke("updater-install"),
  },
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke("parse-markdown", markdown),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readPickedFile: (token, path) => ipcRenderer.invoke("read-picked-file", token, path),
  releasePickedFiles: (token) => ipcRenderer.invoke("release-picked-files", token),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  createDirectory: (parent, name) => ipcRenderer.invoke("create-directory", parent, name),
  writeTextFile: (input) => ipcRenderer.invoke("write-file", input),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  showNotification: (title, body) => ipcRenderer.send("show-notification", title, body),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  getPinchZoomEnabled: () => ipcRenderer.invoke("get-pinch-zoom-enabled"),
  setPinchZoomEnabled: (enabled) => ipcRenderer.invoke("set-pinch-zoom-enabled", enabled),
  onPinchZoomEnabledChanged: (cb) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled)
    ipcRenderer.on("pinch-zoom-enabled-changed", handler)
    return () => ipcRenderer.removeListener("pinch-zoom-enabled-changed", handler)
  },
  onZoomFactorChanged: (cb) => {
    const handler = (_: unknown, factor: number) => cb(factor)
    ipcRenderer.on("zoom-factor-changed", handler)
    return () => ipcRenderer.removeListener("zoom-factor-changed", handler)
  },
  setTitlebar: (theme) => ipcRenderer.invoke("set-titlebar", theme),
  runDesktopMenuAction: (action) => ipcRenderer.invoke("run-desktop-menu-action", action),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  exportDebugLogs: () => ipcRenderer.invoke("export-debug-logs"),
  recordFatalRendererError: (error) => ipcRenderer.invoke("record-fatal-renderer-error", error),
}

contextBridge.exposeInMainWorld("api", api)
