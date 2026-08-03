/**
 * 团队数据手册服务器的内置默认地址。
 *
 * 服务器是团队自有、地址固定,产品要求"下载即用",不让用户配任何环境变量。
 * 优先级保持三层:显式 process.env > `~/.config/opencode/.env`(只有主进程手册库的
 * envVar 会读它)> 这里的默认 —— 服务器真要搬家,不重发版也能用环境变量顶掉。
 *
 * 两个消费方,两条喂法:
 *   - 主进程手册库(manuals.ts):在它的 envVar 链末尾用本常量兜底;
 *   - my-pi 内核的 datasheet 工具:**只读 process.env**(coding-agent/core/tools/
 *     datasheet.ts:27,调用时读),看不见 .env 文件 —— 所以内核进程入口调
 *     ensureDatasheetServerEnv() 把默认值写进 process.env(不覆盖已有值)。
 *     这就是"连开发机上都报 No datasheet server configured"的病根:.env 文件里的
 *     值从来到不了内核进程。
 */
export const DEFAULT_DATASHEET_SERVER = "http://47.122.120.208"

/** 内核进程入口调用:把默认值兜进 process.env,让 my-pi 的工具读得到。 */
export function ensureDatasheetServerEnv(): void {
  if (!process.env.YOMA_DATASHEET_SERVER?.trim()) process.env.YOMA_DATASHEET_SERVER = DEFAULT_DATASHEET_SERVER
}
