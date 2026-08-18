/**
 * Electron 二进制按平台落在不同路径。打包冒烟和 e2e 必须用产品运行时,
 * 找不到就失败,绝不能静默退回 bun/node(绿灯只代表解释器能跑脚本)。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

export function resolveElectron(desktopDir: string): string {
  const dists = [
    join(desktopDir, "node_modules", "electron", "dist"),
    join(desktopDir, "..", "..", "node_modules", "electron", "dist"),
  ]
  const names =
    process.platform === "darwin"
      ? ["Electron.app/Contents/MacOS/Electron"]
      : process.platform === "win32"
        ? ["electron.exe"]
        : ["electron"]
  const candidates = dists.flatMap((dist) => names.map((name) => join(dist, name)))
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error(`找不到 Electron 二进制(找过 ${candidates.join("、")})—— 先 bun install;这条闸门必须跑在产品运行时上`)
}
