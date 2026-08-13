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
type KernelFrameOut = { kind: "request"; id: number; method: string; params: unknown }

/**
 * 内核请求失败时抛给 renderer 的形状。
 *
 * **必须是普通对象,不能是 Error** —— 这是本文件最反直觉、也最贵的一条规矩。
 *
 * Electron 在 world 之间重建 Error 时只保留 `message` 和 `stack`,自定义属性和 `cause`
 * **全部丢掉**(实测 `Object.getOwnPropertyNames(err)` 只剩 `["stack","message"]`)。
 * 于是 host 侧标好的 `data._tag === "SessionNotFoundError"` 在 contextBridge 这一层
 * 静默蒸发,前端只能把"上个版本残留的标签页"当成致命错误,整个 app 崩到错误页。
 *
 * 普通对象是照原样克隆过去的,`data` 能活下来。client.ts 的 `call()` 本来就是按
 * `{ message, stack, data }` 读的,所以这边换形状,那边一个字都不用改。
 *
 * 回归由 `scripts/e2e-renderer-kernel.ts` 兜住 —— 真窗口、真 preload、真内核进程。
 * 这个失效是运行时序列化行为,类型系统永远抓不到,只能用真跑的测试钉住。
 */
type KernelFailure = { message: string; stack?: string; data?: unknown }

const kernelPending = new Map<number, { resolve(value: unknown): void; reject(error: KernelFailure): void }>()
const kernelListeners = new Set<(events: unknown[]) => void>()
let kernelPort: MessagePort | undefined
let kernelNextId = 1

/**
 * 端口到达之前发出的请求。
 *
 * 这是一个 **真实存在的竞态**:renderer 的 provider 树一挂载就开始拉数据,而
 * `kernel-port` 是一条 IPC 消息,到达时机不受 renderer 控制。第一版这里直接
 * reject("内核通道尚未建立"),结果 app 启动即崩 —— 而且是随机的,取决于哪个先到。
 *
 * 正确做法是 **排队**:请求先攒着,端口一到全部冲出去。调用方完全感知不到这件事。
 */
const kernelQueue: KernelFrameOut[] = []
/** 攒太久说明内核压根没起来,给个上限把"永远转圈"变成一条能看懂的错误。 */
const KERNEL_ATTACH_TIMEOUT_MS = 30_000
let kernelAttached = false

function flushKernelQueue() {
  if (!kernelPort) return
  const queued = kernelQueue.splice(0)
  for (const frame of queued) kernelPort.postMessage(frame)
}

setTimeout(() => {
  if (kernelAttached) return
  const failure: KernelFailure = { message: "内核通道 30 秒内没有建立 —— 内核进程可能启动失败,看主进程日志" }
  for (const [id, entry] of [...kernelPending]) {
    kernelPending.delete(id)
    entry.reject(failure)
  }
  kernelQueue.length = 0
}, KERNEL_ATTACH_TIMEOUT_MS)

ipcRenderer.on("kernel-port", (event) => {
  const port = event.ports[0]
  if (!port) return
  kernelPort?.close()
  kernelPort = port
  kernelAttached = true
  port.onmessage = (message: MessageEvent) => {
    const frame = message.data as
      | { kind: "response"; id: number; result?: unknown; error?: { message: string; stack?: string; data?: unknown } }
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
    // 原封不动往下传,**不要包成 Error** —— 见 KernelFailure 的说明,包了就等于把
    // data 丢进黑洞。
    if (frame.error) entry.reject({ message: frame.error.message, stack: frame.error.stack, data: frame.error.data })
    else entry.resolve(frame.result)
  }
  port.start()
  // 端口来了,把攒着的请求一次性冲出去。窗口 reload 之后重新 attach 也走这条路。
  flushKernelQueue()
})

const kernel = {
  request(method: string, params: unknown) {
    return new Promise((resolve, reject) => {
      const id = kernelNextId++
      const frame: KernelFrameOut = { kind: "request", id, method, params }
      kernelPending.set(id, { resolve, reject })
      // 没端口不是错误,是"还没到" —— 排队,别 reject。
      if (kernelPort) kernelPort.postMessage(frame)
      else kernelQueue.push(frame)
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
  mailbox: {
    configure: (settings) => ipcRenderer.invoke("mailbox-configure", settings),
    start: (task) => ipcRenderer.invoke("mailbox-start", task),
    stop: () => ipcRenderer.invoke("mailbox-stop"),
    status: () => ipcRenderer.invoke("mailbox-status"),
    probe: (remote) => ipcRenderer.invoke("mailbox-probe", remote),
    ackHuman: (input) => ipcRenderer.invoke("mailbox-ack-human", input),
    composeJob: (input) => ipcRenderer.invoke("mailbox-compose", input),
    subscribe: (cb) => {
      const handler = (_: unknown, event: unknown) => cb(event)
      ipcRenderer.on("mailbox-event", handler)
      return () => {
        ipcRenderer.removeListener("mailbox-event", handler)
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
