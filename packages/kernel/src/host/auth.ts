/**
 * 应用内凭据配置:读写 my-pi 的 `~/.pi/agent/auth.json`。
 *
 * 文件格式是 my-pi 的 resolveModel() 定的(coding-agent/src/acp/models.ts:
 * `auth[id]?.key`):`{ "<providerID>": { "key": "<apiKey>" } }`。我们只做写入端,
 * 内核一个字节不改 —— 写进去的 key 和用户在命令行配 `pi` / 配 Zed 时写的是同一份,
 * 两边互相可见。
 *
 * CONFIGURABLE_PROVIDERS 是从 my-pi 的 PROVIDERS 表**结构化复制**的(只抄 id 和 name):
 * 那张表没有导出,而首跑时(auth.json 不存在)resolveModel() 直接抛,注册表里一个
 * provider 都没有 —— 不靠这份副本,连接对话框就没有东西可以列,用户被锁在门外。
 * 复制的漂移由 auth.test.ts 兜住:它用空 HOME 调 resolveModel(),从报错信息的
 * "Known providers: ..." 里反解出 my-pi 认识的 id 集合,和这份副本比对。
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/** my-pi 能用的 provider(id 必须和它 PROVIDERS 表的键一致,否则写进去也读不出来)。 */
export const CONFIGURABLE_PROVIDERS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "deepseek", name: "DeepSeek" },
  { id: "moonshotai-cn", name: "Moonshot (Kimi)" },
]

/** 和 my-pi 的 resolveModel() 用同一条路径:join(homedir(), ".pi", "agent")。 */
export function piAgentDir(): string {
  return path.join(homedir(), ".pi", "agent")
}

type AuthFile = Record<string, { key?: string } & Record<string, unknown>>

// 各函数的 dir 参数是**测试接缝**,生产代码一律不传(走真实 homedir)。
// 教训(实测):Bun 的 os.homedir() 在进程启动时就定死了,运行时改 process.env.HOME
// 对它无效 —— 想靠"临时 HOME"在本进程里隔离真实凭据文件是行不通的,会直接读写
// 用户真的 ~/.pi/agent/auth.json。要么注入目录,要么起一个带干净 HOME 的子进程。

/** 容错读:文件不存在或损坏都当成空表 —— 和 my-pi 的 readJson() 行为一致。 */
export function readAuthFile(dir: string = piAgentDir()): AuthFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dir, "auth.json"), "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as AuthFile
  } catch {
    // ignore
  }
  return {}
}

function writeAuthFile(auth: AuthFile, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, "auth.json")
  writeFileSync(file, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 })
  // writeFileSync 的 mode 只在新建时生效,已有文件要显式收紧。
  chmodSync(file, 0o600)
}

/** 写入/覆盖一个 provider 的 key。条目上的其他字段(比如 pi 命令行写的 type)原样保留。 */
export function writeAuthKey(providerID: string, apiKey: string, dir: string = piAgentDir()): void {
  const auth = readAuthFile(dir)
  auth[providerID] = { ...auth[providerID], key: apiKey }
  writeAuthFile(auth, dir)
}

/** 移除一个 provider 的 key。条目只剩 key 时整条删掉,有别的字段就只删 key。 */
export function removeAuthKey(providerID: string, dir: string = piAgentDir()): void {
  const auth = readAuthFile(dir)
  const entry = auth[providerID]
  if (!entry) return
  delete entry.key
  if (Object.keys(entry).length === 0) delete auth[providerID]
  writeAuthFile(auth, dir)
}
