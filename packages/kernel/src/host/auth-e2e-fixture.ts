/**
 * 凭据全链路的子进程侧(被 auth.test.ts 用 `HOME=<临时目录>` 拉起,不是测试文件)。
 *
 * 为什么必须是子进程:全链路要走 my-pi 的 resolveModel(),它读 os.homedir() 下的
 * ~/.pi/agent/auth.json,而 Bun 的 homedir() 在进程启动时定死、运行时改
 * process.env.HOME 无效(实测,踩过:测试当时直接洗掉了开发机上真实的 auth.json)。
 * 只有子进程能在出生时就换 HOME。
 *
 * 开头的自检是**写之前的闸**:homedir() 不指向调用方给的临时目录就拒绝跑。
 * 隔离失效时这里退出码 2,一个字节都不会写。
 */

import { homedir } from "node:os"
import path from "node:path"

import { SessionManager } from "./session-manager.ts"
import { CONFIGURABLE_PROVIDERS, readAuthFile } from "./auth.ts"

const expected = process.env.YOMA_EXPECT_HOME
if (!expected || homedir() !== expected) {
  console.error(`HOME 隔离失效:homedir()=${homedir()},期望 ${expected} —— 拒绝执行任何写入`)
  process.exit(2)
}

const manager = new SessionManager({ sessionsRoot: path.join(expected, "sessions"), emit: () => {} })
const summary = (list: Awaited<ReturnType<SessionManager["providers"]>>) =>
  list.map((p) => [p.id, p.authenticated, p.models.length] as const)

const empty = await manager.providers()

const afterSet = await manager.setAuth("deepseek", "  sk-e2e  ")
const deepseek = afterSet.find((p) => p.id === "deepseek")
const moonshot = afterSet.find((p) => p.id === "moonshotai-cn")
// 必须在 removeAuth 之前读,这是"setAuth 落盘了什么"的证据。
const fileAfterSet = readAuthFile()

const afterRemove = await manager.removeAuth("deepseek")

console.log(
  JSON.stringify({
    catalog: CONFIGURABLE_PROVIDERS.map((spec) => spec.id),
    empty: summary(empty),
    afterSet: {
      deepseekAuthenticated: deepseek?.authenticated ?? false,
      deepseekHasModels: (deepseek?.models.length ?? 0) > 0,
      moonshot,
      file: fileAfterSet,
    },
    afterRemove: summary(afterRemove),
  }),
)
