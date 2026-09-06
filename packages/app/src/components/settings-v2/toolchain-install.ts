import type { ToolchainInstallPhaseView, ToolchainResolvedTool } from "@yoma-desktop/kernel"

/** 设置页里一个工具的安装进度(来自 `toolchain.install` 事件,按工具 id 存一份)。 */
export type InstallProgressView = {
  packageId: string
  version: string
  phase: ToolchainInstallPhaseView
  bytes?: number
  total?: number
  message?: string
}

/** download 阶段的百分比;没有总数(或总数为 0)时 undefined。 */
export function installProgressPercent(p: { bytes?: number; total?: number }): number | undefined {
  if (p.bytes === undefined || !p.total || p.total <= 0) return undefined
  return Math.max(0, Math.min(100, Math.round((100 * p.bytes) / p.total)))
}

/** 字节 → 整数 MB 文案(小于 1 MB 显示 1)。 */
export function formatMB(bytes: number): string {
  return String(Math.max(1, Math.round(bytes / 1e6)))
}

/** 还在跑的阶段(终态 done/error/cancelled 之外)。 */
export function isInstallInFlight(p: InstallProgressView | undefined): boolean {
  return p !== undefined && p.phase !== "done" && p.phase !== "error" && p.phase !== "cancelled"
}

/** 一份核账里能让 Yoma 自动装的、还没就绪的工具 id(顺序照核账)。 */
export function installableMissing(tools: ToolchainResolvedTool[]): string[] {
  return tools.filter((tool) => tool.status !== "ok" && tool.installable).map((tool) => tool.id)
}
