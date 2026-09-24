/**
 * 一个会话的时间线,以及"卡在哪"的判断(docs/调试留痕-规划-20260924.md §3.6)。
 *
 *   npm run trace -- [会话文件 | 会话 id 前缀] [--slow 秒] [--trace 轨迹文件]... [--root userData 目录]
 *
 * 不给会话就取最近改过的那个。会话在桌面端的 userData 里找(三个渠道都找),轨迹在同一 userData 的
 * `logs/<启动时间>/trace.jsonl` 里按会话 id 筛;`--trace` 可以直接指定(bench / 无头跑用 YOMA_TRACE_FILE 写的那份)。
 * 全部只读。
 */
import { readFileSync } from "node:fs"
import { parseSession, parseTrace, renderReport, type TraceLine } from "@yoma-desktop/kernel/host/trace-report"
import { childSessions, findSession, traceFiles, userDataRoots } from "./trace-lookup.ts"

const args = process.argv.slice(2)
let target: string | undefined
let slowSeconds = 20
const explicitTraces: string[] = []
const roots: string[] = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!
  if (arg === "--slow") slowSeconds = Number(args[++i])
  else if (arg === "--trace") explicitTraces.push(args[++i]!)
  else if (arg === "--root") roots.push(args[++i]!)
  else if (arg === "-h" || arg === "--help") {
    console.log("用法: npm run trace -- [会话文件 | 会话 id 前缀] [--slow 秒] [--trace 轨迹文件]... [--root userData 目录]")
    process.exit(0)
  } else target = arg
}
if (!Number.isFinite(slowSeconds) || slowSeconds <= 0) {
  console.error("--slow 要一个正数(秒)")
  process.exit(2)
}

const searched = roots.length ? roots : userDataRoots()
const found = findSession(target, searched)
if (!found) {
  console.error(
    target
      ? `没找到会话 ${target}(找过:${searched.join("、") || "没有 userData 目录"})`
      : `没找到任何会话(找过:${searched.join("、") || "没有 userData 目录"})`,
  )
  process.exit(1)
}

const parsed = parseSession(readFileSync(found.file, "utf8"))
if (!parsed.ok) {
  console.error(`${found.file}:${parsed.reason}`)
  process.exit(1)
}

const files = explicitTraces.length ? explicitTraces : traceFiles(found.root)
const lines: TraceLine[] = []
for (const file of files) {
  try {
    lines.push(...parseTrace(readFileSync(file, "utf8")))
  } catch (error) {
    console.error(`读不了轨迹 ${file}:${(error as Error).message}`)
  }
}

console.log(`文件 ${found.file}`)
console.log(renderReport(parsed.session, lines, { slowMs: slowSeconds * 1000 }))
const children = childSessions(found.file, parsed.session.id)
if (children.length) {
  console.log("")
  console.log(`子 agent 会话 ${children.length} 个(各自再跑一次 npm run trace -- <id> 看):`)
  for (const child of children) console.log(`  ${child.id}`)
}
