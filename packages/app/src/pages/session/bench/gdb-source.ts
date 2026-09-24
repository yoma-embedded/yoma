/** 源码行与断点、寄存器变化的对照。纯函数,界面和测试共用。 */

export function normalizeSource(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "")
}

/**
 * 同一份源码。大小写不敏感,允许一边是另一边带目录前缀的后缀
 * (`Core/Src/main.c` 对得上 `D:/proj/Core/Src/main.c`)。
 * 只有文件名时不对:工程里到处都有 `main.c`。
 */
export function sameSource(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const left = normalizeSource(a).toLowerCase()
  const right = normalizeSource(b).toLowerCase()
  if (left === right) return true
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  if (!shorter.includes("/")) return false
  return longer.endsWith(`/${shorter}`)
}

export interface LineBreakpoint {
  number: number
  kind: string
  file?: string
  line?: number
}

export function breakpointOnLine(breakpoints: readonly LineBreakpoint[] | undefined, file: string, line: number) {
  return breakpoints?.find((bp) => bp.kind === "break" && bp.line === line && sameSource(bp.file, file))
}

export function pendingOnLine(pending: readonly { file: string; line: number }[], file: string, line: number) {
  return pending.findIndex((item) => item.line === line && sameSource(item.file, file))
}

/** 只标上一停就有、这一停变了的寄存器。新出现的名字不算变化。 */
export function changedNames(
  prev: readonly { name: string; value: string }[],
  next: readonly { name: string; value: string }[],
): Set<string> {
  const before = new Map(prev.map((row) => [row.name, row.value]))
  const changed = new Set<string>()
  for (const row of next) {
    const old = before.get(row.name)
    if (old !== undefined && old !== row.value) changed.add(row.name)
  }
  return changed
}

export function breakAt(file: string, line: number): string {
  return `${normalizeSource(file)}:${line}`
}
