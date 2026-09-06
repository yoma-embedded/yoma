import type { Accessor } from "solid-js"

/**
 * 更新状态机的形状,main / preload / renderer 三个世界共用这一份(结构化复制的契约)。
 * `downloading` 的进度来自 electron-updater 的 download-progress;`ready.notes` 是 Release
 * 说明(纯文本,已剥标签),给设置页展示"这次更新了什么"。
 */
export type UpdaterState =
  | { status: "disabled" }
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent?: number; transferred?: number; total?: number }
  | { status: "ready"; version: string; notes?: string }
  | { status: "up-to-date" }
  | { status: "installing"; version: string }
  | { status: "error"; message: string }

export type UpdaterPlatform = {
  state: Accessor<UpdaterState>
  check(): Promise<UpdaterState>
  install(): Promise<void>
  /** 启动时 / 定时自动检查的开关(持久化在 main 的 store)。桌面端才有。 */
  autoCheck?: {
    get(): Promise<boolean>
    set(value: boolean): Promise<void>
  }
}
