/**
 * 轮次子进程 + 研发端工作区的杂务。
 *
 * ## 为什么 agent 轮跑在子进程里
 *
 * my-pi 的探针租约、gdb 会话表、log 采集器都是模块级全局并挂着退出钩子。
 * 进程边界 = 免费且可靠的清理:agent 轮一结束,探针/串口/gdbserver 一定被收干净,
 * 下一轮不会撞上"探针被占着"。会话是落盘 JSONL,换进程不丢历史。
 */

import { spawn } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { FauxScript } from "./faux.ts"
import { fileExists, readJsonFile } from "./fsx.ts"
import type { Job } from "./job.ts"
import type { TurnResult } from "./turn.ts"

/** 子进程入口收到的全部输入。序列化成 JSON 走 argv 指向的文件。 */
export interface TurnInput {
  job: Job
  workspace: string
  sessionsRoot: string
  stateDir: string
  enginesDir?: string
  sessionID?: string
  prompt: string
  /**
   * 打包态的子进程入口(esbuild 产物 mailbox-turn-entry.mjs 的绝对路径),由宿主
   * 显式传入,**不猜**。缺省只在 bun 运行时合法(直跑 turn-entry.ts 源码);
   * exe 里 process.execPath 是 Electron,不给入口就是配置错误,如实抛。
   */
  turnEntry?: string
  /** 技能/上下文/凭据的全局目录。生产不传(默认 ~/.my-pi);演练与测试传临时目录隔离。 */
  configDir?: string
  /** 假模型脚本(本机演练/打包冒烟)。有它则子进程不联网、不要 key,其余全真。 */
  faux?: FauxScript
}

/**
 * 建 .bench/ 并让 git 忽略它的**运行产物**。
 *
 * 不忽略的话,轮次输入输出会被 `git add -A` 卷进提交 —— 研发打开 diff 看到的是
 * 几个 bench 内部文件加一处真改动,审阅体验直接毁掉(实测第一次真跑就中了)。
 * 忽略文件放在目录内部而不是改仓库的 .gitignore:那是用户的文件,调试台不该动它。
 *
 * `.gitignore` 自身也在忽略之列:它是调试台生成的,露出来就是一个"未跟踪又不被忽略"
 * 的条目,工作树因此永远不干净,而研发端每轮开局都要求树干净(实测:漏了这条,
 * 每一轮开局都被自己挡死)。被忽略不影响它生效 —— git 读 .gitignore 与它是否被跟踪无关。
 */
const BENCH_IGNORE = `# 调试台的运行产物,不进版本库(含自身);任务模板是项目配置,要跟着仓库走。
*
!mailbox.template.json
`

export async function ensureBenchDir(benchDir: string): Promise<void> {
  await mkdir(benchDir, { recursive: true })
  const ignore = path.join(benchDir, ".gitignore")
  if (!(await fileExists(ignore))) await writeFile(ignore, BENCH_IGNORE)
}

/**
 * 让 my-pi 工具的运行产物(gdb 会话日志、烧录状态、采集日志)不进版本库。
 *
 * 与 `.bench` 同一个教训的第二次上演:第一次真跑信箱闭环,agent 分支的 diff 里
 * 17 个文件有 16 个是 `.my-pi/gdb/*.mi` 这类工具日志,真正的代码改动只有 1 个文件。
 * 只忽略**运行产物**而不是整个目录 —— `.my-pi/` 里还可能住着用户自己提交的
 * 项目技能与上下文;已有 .gitignore 时不动它(那是用户的文件)。
 */
const MY_PI_IGNORE = `# yoma 调试工具的运行产物,不进版本库(技能等用户文件不受影响)
.gitignore
gdb/
logs/
flash-state.json
`

export async function ensureMyPiIgnore(workspace: string): Promise<void> {
  const dir = path.join(workspace, ".my-pi")
  await mkdir(dir, { recursive: true })
  const ignore = path.join(dir, ".gitignore")
  if (!(await fileExists(ignore))) await writeFile(ignore, MY_PI_IGNORE)
}

/**
 * 在飞的 turn-entry 子进程登记表 + 信号转杀。
 *
 * 没有它,SIGTERM/SIGINT 只杀得死本体,正在跑的 agent 轮变成孤儿继续烧录/gdb/采日志
 * (实测复现过:sim 超时杀掉 runner 后,孙进程把整轮跑完才放手)。
 * 收到信号先把孩子带走,再按约定退出。
 */
const activeTurnChildren = new Set<ReturnType<typeof spawn>>()
let signalHandlersInstalled = false

function installTurnSignalHandlers(): void {
  if (signalHandlersInstalled) return
  signalHandlersInstalled = true
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      for (const child of activeTurnChildren) child.kill("SIGTERM")
      // 立即退出而不是等孩子:孩子的默认信号处置就是死,拖着只会让上层收尸超时。
      process.exit(signal === "SIGINT" ? 130 : 143)
    })
  }
}

/**
 * 起一个子进程跑一轮。
 *
 * 协议刻意做得又小又蠢:输入是一个 JSON 文件,输出是另一个 JSON 文件,
 * stdout 是给人看的进度。这样出了事可以直接拿输入文件重放一轮。
 */
export async function runTurnInChildProcess(
  input: TurnInput,
  handlers: { onProgress?: (message: string) => void },
): Promise<TurnResult> {
  const dir = path.join(input.workspace, ".bench", "turns")
  await mkdir(dir, { recursive: true })
  const stamp = `${input.job.id}-${input.prompt.length}`
  const inputFile = path.join(dir, `turn-${stamp}.json`)
  const outputFile = path.join(dir, `turn-${stamp}.result.json`)
  await writeFile(inputFile, JSON.stringify(input, null, 2))
  // stamp 可能与上次运行撞名(同任务重新入箱时首轮必撞)。旧结果文件不清掉的话,
  // 本次子进程崩溃没写输出时,父进程会把**上次的结果**当本轮结果回填 —— 静默错账。
  await rm(outputFile, { force: true })

  // 双态入口:显式传入的打包产物优先;bun 运行时可退到直跑源码。两者都不满足是
  // 配置错误(exe 里 execPath 是 Electron 本体,盲目 spawn 会把整个 app 再起一遍)。
  const entry =
    input.turnEntry ??
    (process.versions.bun ? path.join(path.dirname(fileURLToPath(import.meta.url)), "turn-entry.ts") : undefined)
  if (!entry) throw new Error("非 bun 运行时必须显式传 TurnInput.turnEntry(esbuild 打包的子进程入口)")
  installTurnSignalHandlers()
  const child = spawn(process.execPath, [entry, inputFile, outputFile], {
    cwd: input.workspace,
    stdio: ["ignore", "pipe", "inherit"],
    // Electron 看到它就以纯 node 面目运行;bun 与真 node 无视它,统一设不分叉。
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  })
  activeTurnChildren.add(child)
  child.on("close", () => activeTurnChildren.delete(child))

  // 逐 chunk toString() 会劈断多字节 UTF-8(进度行里有中文),必须走流式解码。
  const decoder = new TextDecoder()
  let pending = ""
  child.stdout.on("data", (chunk: Buffer) => {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) if (line.trim()) handlers.onProgress?.(line.trimEnd())
  })

  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null))
    child.on("close", resolve)
  })

  const result = await readJsonFile<TurnResult>(outputFile).catch(() => undefined)
  if (!result) throw new Error(`子进程没有产出结果(退出码 ${code});输入留在 ${inputFile}`)
  return result
}
