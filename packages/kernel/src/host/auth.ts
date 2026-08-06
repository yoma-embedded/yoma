/**
 * 应用内凭据配置:读写 my-pi 的 `<configDir>/auth.json`(默认 `~/.my-pi/auth.json`)。
 *
 * ## 2026-08 的搬家:凭据不再跟 pi 共用
 *
 * my-pi 把凭据从 `~/.pi/agent/auth.json` 挪到了自己的 `<configDir>/auth.json`,并且
 * `resolveModel()` 现在**要求显式传 configDir**(这一改在我们这边是编译期硬失败,
 * 不是运行时惊喜 —— alias 接缝的设计目的正是如此)。同时格式收紧成 pi-ai 的
 * `Credential` 判别联合:条目**必须带 `type: "api_key"`**,少了这个字段
 * `resolveProviderAuth` 里 `stored.type === "api_key"` 匹配不上,key 会被**静默忽略**
 * —— 表现是"我明明配了 key 却说没配",最难查的那一类。
 *
 * 所以写入端直接用 my-pi 导出的 `FileCredentialStore`,不再自己拼 JSON:
 * 格式、0600 权限、目录 0700、写入串行化全都由它负责,我们这边就不存在格式漂移了。
 *
 * 老用户的 key 由 `migrateLegacyPiAuth()` 一次性搬过来(只在新文件不存在时,
 * 且**不删旧文件**)—— 否则升级一次 app 就是"key 不见了",而用户什么都没做。
 *
 * CONFIGURABLE_PROVIDERS 是从 my-pi 的 PROVIDERS 表**结构化复制**的(只抄 id 和 name):
 * 那张表没有导出,而首跑时(auth.json 不存在)resolveModel() 直接抛,注册表里一个
 * provider 都没有 —— 不靠这份副本,连接对话框就没有东西可以列,用户被锁在门外。
 * 复制的漂移由 auth.test.ts 兜住。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { FileCredentialStore } from "@yoma/my-pi-coding-agent/models"

/** my-pi 能用的 provider(id 必须和它 PROVIDERS 表的键一致,否则写进去也读不出来)。 */
export const CONFIGURABLE_PROVIDERS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "deepseek", name: "DeepSeek" },
  { id: "moonshotai-cn", name: "Moonshot (Kimi)" },
]

/** 和 my-pi 的 ACP 适配器同一个默认目录(acp/agent.ts 的 CONFIG_DIR)。 */
export function myPiConfigDir(): string {
  return path.join(homedir(), ".my-pi")
}

export function authFilePath(configDir: string = myPiConfigDir()): string {
  return path.join(configDir, "auth.json")
}

/** 2026-08 之前的位置。只用于一次性迁移,不再写它。 */
export function legacyPiAuthFilePath(): string {
  return path.join(homedir(), ".pi", "agent", "auth.json")
}

type AuthEntry = { type?: string; key?: string } & Record<string, unknown>
type AuthFile = Record<string, AuthEntry>

// configDir 参数是**测试接缝**,生产代码一律不传(走真实 homedir)。
// 教训(实测):Bun 的 os.homedir() 在进程启动时就定死了,运行时改 process.env.HOME
// 对它无效 —— 想靠"临时 HOME"隔离真实凭据文件行不通,会直接读写用户真的那一份。
// 现在 my-pi 的 resolveModel 也收 configDir 了,所以注入目录就够,不必再起子进程。

/** 容错读:文件不存在或损坏都当成空表 —— 和 my-pi 的 readJson() 行为一致。 */
export function readAuthFile(configDir: string = myPiConfigDir()): AuthFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(authFilePath(configDir), "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as AuthFile
  } catch {
    // ignore
  }
  return {}
}

/** 写入/覆盖一个 provider 的 key。走 my-pi 的仓库实现,格式与权限都不由我们决定。 */
export async function writeAuthKey(providerID: string, apiKey: string, configDir?: string): Promise<void> {
  const store = new FileCredentialStore(authFilePath(configDir))
  await store.modify(providerID, async (current) => ({
    // 同条目里别的字段(pi-ai 的 env 之类)保留;oauth 条目被 api_key 覆盖 ——
    // 用户正在手填 key,那就是他要的。
    ...(current && current.type === "api_key" ? current : {}),
    type: "api_key",
    key: apiKey,
  }))
}

/** 移除一个 provider 的凭据(整条删掉,与 my-pi 的 logout 语义一致)。 */
export async function removeAuthKey(providerID: string, configDir?: string): Promise<void> {
  await new FileCredentialStore(authFilePath(configDir)).delete(providerID)
}

/**
 * 一次性把老位置(`~/.pi/agent/auth.json`)的 key 搬到新位置。
 *
 * 只在新文件**不存在**时执行,而且不删旧文件 —— 迁移必须是幂等且可回退的:
 * 用户可能还在用 pi 命令行,把他的文件删掉不是我们的权限。
 * 顺带补上 `type: "api_key"`:老格式没有这个判别字段,照搬过去等于没搬。
 *
 * `legacyFile` 和 configDir 一样是**测试接缝**:不开这个口子的话,"老文件不存在"
 * 这条分支在任何装过 pi 的开发机上都测不了(写测试时就是这么发现的 —— 它会去读
 * 开发者真实的凭据,测试结果取决于跑测试的人配没配过 pi)。
 *
 * @returns 迁移过来的 provider id 列表(没迁就是空数组)
 */
export function migrateLegacyPiAuth(
  configDir: string = myPiConfigDir(),
  legacyFile: string = legacyPiAuthFilePath(),
): string[] {
  const target = authFilePath(configDir)
  if (existsSync(target)) return []
  const legacy = legacyFile
  if (!existsSync(legacy)) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(legacy, "utf8"))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []

  const migrated: AuthFile = {}
  for (const [providerID, entry] of Object.entries(parsed as AuthFile)) {
    if (!entry || typeof entry !== "object") continue
    if (typeof entry.key !== "string" || entry.key.trim() === "") continue
    migrated[providerID] = { ...entry, type: entry.type ?? "api_key" }
  }
  const ids = Object.keys(migrated)
  if (!ids.length) return []

  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  writeFileSync(target, `${JSON.stringify(migrated, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 })
  return ids
}
