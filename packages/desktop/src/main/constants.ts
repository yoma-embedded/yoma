import { app } from "electron"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { platformCanSelfUpdate } from "./updater-controller"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.YOMA_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// 包内 package.json(asar 里,带着打包时 extraMetadata 写进去的字段)。构建期 import 的那份没有这些字段。
function packagedMeta(): unknown {
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"))
  } catch {
    return undefined
  }
}

const meta = packagedMeta()

export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
/** false = 只通知(查得到新版,但装不上:没有 Developer ID 的 mac 包)。见 platformCanSelfUpdate。 */
export const UPDATER_SELF_UPDATE = platformCanSelfUpdate(process.platform, meta)
/** 打包时写进包内 package.json 的发布仓库地址(`yoma.releaseRepo`),只通知模式拿它拼发布页。 */
export const RELEASE_REPO: unknown =
  meta && typeof meta === "object" ? (meta as { yoma?: { releaseRepo?: unknown } }).yoma?.releaseRepo : undefined
