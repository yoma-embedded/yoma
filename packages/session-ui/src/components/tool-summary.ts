import { toolContract } from "@yoma-desktop/kernel/tools/contracts"

/** 外来的工具(没有契约、也不是发动机自带的四件)按这张表挑摘要:谁先有字就用谁。 */
const FALLBACK_KEYS = ["description", "command", "query", "pattern", "url", "filePath", "path", "name"]

const text = (input: Record<string, unknown>, key: string) => {
  const value = input[key]
  return typeof value === "string" ? value.trim() : ""
}

/**
 * 工具卡片那一行的摘要:命令、路径、pattern……
 *
 * 有契约的问契约 —— `summary()` 本来就是为卡片副标题写的(find 的契约原话:"卡片副标题就是 pattern")。从前通用卡
 * 自己按一张键名表挑:`ls` 不带 path 时副标题是空的,整行只剩一个「ls」;grep / find 带了 path 时显示的是 path,
 * pattern 被整个丢掉。没有契约的是发动机自带的四件:bash 取命令,read / write / edit 取路径。
 */
export function toolSummary(tool: string, input: Record<string, unknown> | undefined): string {
  const args = input ?? {}
  const contract = toolContract(tool)
  if (contract) {
    try {
      const value = contract.summary(args as never)
      return typeof value === "string" ? value.trim() : ""
    } catch {
      // 参数还没拼完或者形状不对:摘要只是一行标签,不许为它把卡片弄崩。
      return ""
    }
  }
  if (tool === "bash") return text(args, "command")
  if (tool === "read" || tool === "write" || tool === "edit") return text(args, "path")
  for (const key of FALLBACK_KEYS) {
    const value = text(args, key)
    if (value) return value
  }
  return ""
}

/** 展开后整段显示的那一个参数(命令类工具):别的工具展开后逐条列顶层参数。 */
export function toolCommand(tool: string, input: Record<string, unknown> | undefined): string | undefined {
  if (tool !== "bash" && tool !== "powershell") return
  const value = input?.command
  return typeof value === "string" ? value : undefined
}

/**
 * 展开后逐条列的顶层参数:字符串、数字、布尔。嵌套的(edit 的 edits[])不列 —— 改了什么在「本轮改动」那一行里看。
 * 口径与会话内查找「调用参数里只取顶层标量」一致:查得到的字,展开后就画得出来。
 */
export function toolArguments(input: Record<string, unknown> | undefined): { key: string; value: string }[] {
  return Object.entries(input ?? {}).flatMap(([key, value]) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [{ key, value: String(value) }]
      : [],
  )
}
