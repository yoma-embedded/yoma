/**
 * 数据手册服务器地址:解析规则只有一份 —— coding-agent 的 `core/datasheet-server.ts`
 * (显式 > 环境变量 YOMA_DATASHEET_SERVER > ~/.yoma/.env > 内置默认;off 关闭)。
 *
 * 这里只剩内核进程入口用的一个薄壳:内核工具按 configDir 自己解析,但历史上 datasheet
 * 工具只读 process.env,而且 ACP 等旁路仍可能这么读 —— 把解析结果喂进 process.env 让所有
 * 读法都得到同一个答案。**显式设了 off 的不覆盖**:off 也是一种明确配置。
 *
 * 2026-09-05 起有内置默认(见 coding-agent 那份文件头的产品决定),从前"没有内置主机"
 * 的说法作废。
 */
import { DATASHEET_SERVER_ENV, resolveDatasheetServer } from "@yoma/coding-agent/datasheet-server"

/** 内核进程入口调用:把解析出的地址喂进 process.env(已有值 / 显式 off 不动)。 */
export function ensureDatasheetServerEnv(): void {
  if (process.env[DATASHEET_SERVER_ENV]?.trim()) return
  const resolved = resolveDatasheetServer()
  if (resolved.url) process.env[DATASHEET_SERVER_ENV] = resolved.url
}
