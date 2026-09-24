/**
 * 轨迹里一次工具调用的一行摘要(docs/调试留痕-规划-20260924.md §3.2)。
 *
 * host/tools 下的工具用契约的 `summary(input)` —— 卡片副标题与确认条用的同一个函数,轨迹上写的和界面上看到的是
 * 同一串字;发动机自带的四件套(read / bash / edit / write)没有契约,取命令或路径。一行、封顶 200 字:轨迹只记
 * "跑的是什么",不记参数全文(write 的 content 可以是一整个文件)。
 */

import { toolContract } from "../tools/contracts.ts"

const MAX = 200

/** 发动机四件套与兜底:按这个顺序找第一个像样的字符串参数。 */
const FALLBACK_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "description", "action"]

export function toolSummary(name: string, args: unknown): string | undefined {
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {}
  let text: string | undefined
  const contract = toolContract(name)
  if (contract) {
    try {
      text = contract.summary(input as never)
    } catch {
      // 契约的摘要函数对着半截参数抛了 —— 退回兜底,轨迹不能因此少一行
    }
  }
  if (!text) {
    for (const key of FALLBACK_KEYS) {
      const value = input[key]
      if (typeof value === "string" && value.trim()) {
        text = value
        break
      }
    }
  }
  if (!text) return undefined
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > MAX ? `${line.slice(0, MAX)}…` : line
}
