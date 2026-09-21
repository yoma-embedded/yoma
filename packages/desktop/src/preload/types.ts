import type { DesktopMenuAction } from "@yoma-desktop/app/desktop-menu"
import type { UpdaterState } from "@yoma-desktop/app/updater"
import type { ManualsPlatform } from "@yoma-desktop/app/manuals/types"

/**
 * 内核通道。形状必须和 @yoma-desktop/kernel 的 KernelTransport 一致 ——
 * renderer 直接 `createKernelClient(window.api.kernel)`。
 * 这里不 import 那个类型,是为了让 preload 保持零依赖(它是 CJS,而且沙箱化)。
 */
export type KernelAPI = {
  request(method: string, params: unknown): Promise<unknown>
  subscribe(handler: (events: unknown[]) => void): () => void
  /** 窗口 reload 之后端口会失效,主动让 main 重新牵线。 */
  reattach(): Promise<void>
}

export type ManualsAPI = ManualsPlatform

/**
 * 信箱调试台。与 KernelAPI 同一条纪律:preload 零依赖,类型在这里**结构化复制**
 * (真源是 main/mailbox-controller.ts);事件与错误全是普通对象 —— contextBridge
 * 会把 Error 剥得只剩 message。status/subscribe 的载荷 app 侧再收窄。
 */
export type MailboxSettingsWire = {
  remote: string
  role: "runner" | "mother"
  branch?: string
  pollSeconds?: number
  /** 本机的工程检出目录 —— 任务书不带绝对路径,两侧各配各的。 */
  projectDir?: string
}
export type MailboxTaskWire = { kind: "runner" | "mother" | "sim" | "init"; jobFile?: string; fresh?: boolean; thenStart?: boolean }
export type MailboxComposeWire = {
  templatePath: string
  description: string
  tier: "quick" | "standard" | "thorough"
  title?: string
}
/** 人对一次挂起的回执。板子边上那台机器也点得了 —— 信箱是共享的,谁写谁推。 */
export type MailboxAckWire = {
  round: number
  answer: "done" | "cannot"
  note?: string
}
export type MailboxAPI = {
  configure(settings: MailboxSettingsWire): Promise<{ ok: boolean; message?: string }>
  start(task: MailboxTaskWire): Promise<{ ok: boolean; message?: string }>
  stop(): Promise<{ ok: boolean; message?: string }>
  status(): Promise<unknown>
  probe(remote: string): Promise<{ ok: boolean; message: string }>
  ackHuman(input: MailboxAckWire): Promise<{ ok: boolean; message: string }>
  composeJob(input: MailboxComposeWire): Promise<{ ok: boolean; jobFile?: string; projectDir?: string; message?: string }>
  subscribe(cb: (event: unknown) => void): () => void
}

export type UpdaterAPI = {
  subscribe: (cb: (state: UpdaterState) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
  /** 启动时 / 定时自动检查的开关。 */
  getAutoCheck: () => Promise<boolean>
  setAutoCheck: (value: boolean) => Promise<void>
}

export type TitlebarTheme = {
  mode: "light" | "dark"
}
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type ElectronAPI = {
  kernel: KernelAPI
  manuals: ManualsAPI
  mailbox: MailboxAPI
  updater: UpdaterAPI
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  /** 整个名字空间一次读出来(值的口径同 storeGet)。 */
  storeItems: (name: string) => Promise<Record<string, string>>
  /** 一批改动一次写盘。 */
  storeUpdate: (name: string, insert: Record<string, string>, remove: string[]) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  onMenuCommand: (cb: (id: string) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
    /** 内容要读进渲染器的扩展名;其余文件只交路径(inline: false),readPickedFile 读不到它们。 */
    inlineExtensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number; inline: boolean }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<ArrayBuffer>
  releasePickedFiles: (token: string) => Promise<void>
  getPathForFile: (file: File) => string
  createDirectory: (parent: string, name: string) => Promise<string>
  writeTextFile: (input: { root: string; path: string; content: string; exclusive?: boolean }) => Promise<string>
  openLink: (url: string) => void
  openPath: (path: string) => Promise<void>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
}
