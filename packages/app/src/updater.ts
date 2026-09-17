import type { Accessor } from "solid-js"

/**
 * 更新状态机的形状,main / preload / renderer 三个世界共用这一份(结构化复制的契约)。
 * `downloading` 的进度来自 electron-updater 的 download-progress;`ready.notes` / `available.notes`
 * 是 Release 说明(纯文本,已剥标签),给设置页展示"这次更新了什么"。
 */
export type UpdaterState =
  | { status: "disabled" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent?: number; transferred?: number; total?: number }
  | { status: "ready"; version: string; notes?: string }
  // 有新版,但这份安装没法自己给自己升级(今天是没有 Developer ID 的 mac 包):不下载,
  // `install()` 的含义变成"打开这一版的发布页"。
  | { status: "available"; version: string; notes?: string }
  | { status: "up-to-date" }
  | { status: "installing"; version: string }
  | { status: "error"; message: string }

export type UpdaterPlatform = {
  state: Accessor<UpdaterState>
  check(): Promise<UpdaterState>
  /** `ready` 时安装并重启;`available` 时打开发布页(这份安装不能自己升级)。 */
  install(): Promise<void>
  /** 启动时 / 定时自动检查的开关(持久化在 main 的 store)。桌面端才有。 */
  autoCheck?: {
    get(): Promise<boolean>
    set(value: boolean): Promise<void>
  }
}
