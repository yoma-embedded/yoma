/**
 * 让 write 工具交代它覆盖掉了什么。
 *
 * 上游的 write 只回一句 "Successfully wrote to …",details 是 undefined:时间线想说"这一轮改了哪些文件、
 * 改了什么",edit 有现成的 details.patch,write 什么都没有 —— 新内容在调用参数里,旧内容写完就没了。
 * 这里在写之前把旧内容读出来放进 details.before,前端拿它和参数里的 content 算 diff。
 *
 * 为什么记旧内容而不是 patch:write 多半是整份重写,patch ≈ 旧 + 新,而新内容参数里已经落过一次盘;
 * 内核也不必为此多背一个 diff 依赖。details 只给 UI,不进模型上下文。
 *
 *   before: string  —— 覆盖了一个已有的文本文件
 *   before: null    —— 文件原来不存在(新建)
 *   没有 details    —— 不知道(太大 / 二进制 / 读不了),前端就只列文件名、不画 diff
 */

import type { Context, ExecutionEnv } from "@earendil-works/pi-agent-core"

import type { RegisteredTool } from "./tools/index.ts"

/** 超过就不记:details 跟着工具结果落进会话文件,每覆盖一次大文件就多存一份旧的,涨得很快。 */
export const WRITE_BEFORE_LIMIT = 256 * 1024

export type WriteDetails = { before: string | null }

// 与上游 tools/path-utils.ts 的 normalizeToolPath 同解(它没有从包里导出):不同解的话,"@main.c" 这种
// 写法在这里会被当成另一个不存在的文件,一次覆盖就被说成了新建。
const UNICODE_SPACES = /[  -   　]/g
const normalizeToolPath = (path: string) => {
  const normalized = path.replace(UNICODE_SPACES, " ")
  return normalized.startsWith("@") ? normalized.slice(1) : normalized
}

export async function readOverwritten(
  env: ExecutionEnv,
  path: string,
  context: Context,
): Promise<WriteDetails | undefined> {
  const absolute = await env.absolutePath(normalizeToolPath(path), context)
  if (!absolute.ok) return
  const exists = await env.exists(absolute.value, context)
  if (!exists.ok) return
  if (!exists.value) return { before: null }
  const info = await env.fileInfo(absolute.value, context)
  if (!info.ok || info.value.kind !== "file" || info.value.size > WRITE_BEFORE_LIMIT) return
  const text = await env.readTextFile(absolute.value, context)
  if (!text.ok || text.value.includes("\u0000")) return
  return { before: text.value }
}

/**
 * 读旧内容在上游的文件互斥队列之外:同一批里并行写同一个文件时,这里读到的可能已经不是"这一次"覆盖掉的
 * 那份。后果只是那一条 diff 画得不准,不影响写入本身,而这种调用极少,不为它去复制上游的队列。
 */
export function withOverwrittenContent(tool: RegisteredTool): RegisteredTool {
  return {
    ...tool,
    async execute(id, params, onUpdate, context, invocation, ctx) {
      const path = (params as { path?: unknown }).path
      const details = typeof path === "string" ? await readOverwritten(context.env, path, ctx) : undefined
      const result = await tool.execute(id, params, onUpdate, context, invocation, ctx)
      return details ? { ...result, details } : result
    },
  }
}
