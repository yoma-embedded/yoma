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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { lineDecoder } from "./lines.ts"

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
  /** 工具链清单按哪一侧筛。信箱工位端传 "runner"。 */
  toolchainSide?: "mother" | "runner"
  /** 工具链清单原文。工位端没有项目检出,清单经信箱送到,从这里灌进子进程。 */
  toolchainManifestText?: string
  /** 假模型脚本(本机演练/打包冒烟)。有它则子进程不联网、不要 key,其余全真。 */
  faux?: FauxScript
}

/**
 * `<工程>/.my-pi/` —— yoma 在这个项目里的**唯一**落脚点。
 *
 * ```
 * <工程>/.my-pi/
 *   .gitignore                     本文件写的这一份
 *   toolchain.json                 项目配置,**要跟着仓库走**(工具链声明,零绝对路径)
 *   toolchain.local.json           本机覆盖,不提交(可能带绝对路径)
 *   gdb/  logs/  flash-state.json  工具的运行产物
 *   bench/
 *     mailbox.template.json        项目配置,**要跟着仓库走**
 *     turns/  mailbox-sim/         调试台的运行产物
 * ```
 *
 * 2026-08-11 之前是两个目录(`.bench/` 与 `.my-pi/`),各带一份 .gitignore、
 * 两套相反的策略(前者白名单、后者黑名单)。合成一个的理由很直白:它们结构同构
 * (项目配置 + 运行产物),而用户的项目根不该为同一个产品长出两个隐藏目录。
 *
 * ## 为什么必须忽略,以及为什么连 .gitignore 自己也忽略
 *
 * 不忽略运行产物,它们会被 `git add -A` 卷进提交 —— 实测第一次真跑,agent 分支的
 * diff 里 17 个文件有 16 个是 `.my-pi/gdb/*.mi` 这类工具日志,真改动只有 1 个。
 *
 * `.gitignore` 自身也在忽略之列:它是调试台生成的,露出来就是一个"未跟踪又不被忽略"
 * 的条目,工作树因此永远不干净,而研发端每轮开局都要求树干净(实测:漏了这条,
 * 每一轮开局都被自己挡死)。被忽略不影响它生效 —— git 读 .gitignore 与它是否被跟踪无关。
 *
 * ## 为什么是黑名单
 *
 * 白名单(`*` + `!放行项`)对"新长出来的运行产物"更安全,但它的失效方向是**静默吞掉
 * 用户想提交的文件**;黑名单漏一条只会让一个产物露出来,一眼就能看见。这个目录里
 * 要提交的是项目配置(bench 的 mailbox 模板、toolchain 的工具链声明),列两条运行
 * 产物比列白名单更好读。`toolchain.local.json` 是例外中的例外:它长得像项目配置
 * (跟 toolchain.json 挨着放),内容却是本机路径 —— 必须显式拉黑,不能靠"没在黑名单里
 * 就放行"的默认值蒙混过去。`back/` 是工位端回传件在研发机上的落点(采集、日志、图)——
 * 它已经在信箱仓里留了底,再进项目仓一次只会让工程仓跟着一起胖。
 */
const YOMA_IGNORE = `# yoma 在这个项目里的运行产物,不进版本库(含本文件);bench 与 toolchain 的项目配置要跟着仓库走。
.gitignore
gdb/
logs/
back/
flash-state.json
bench/turns/
bench/mailbox-sim/
toolchain.local.json
`

/** 认领标志:第一行是它的,就是我们写的,可以升级;别的一律当用户手写,不动。 */
const YOMA_IGNORE_MARK = "# yoma"

/**
 * 建 `<工程>/.my-pi/` 并放好忽略文件。
 *
 * **已有的会升级**(只要第一行带认领标志)—— 两个 ensure 函数从前都是"文件不存在
 * 才写",于是老仓库永远停在旧规则上:合并之后 `bench/turns/` 会照着旧的 `.my-pi`
 * 规则漏进版本库,而这正是当初加忽略要防的事。用户手写的 .gitignore 仍然不动。
 */
export async function ensureYomaDir(workspace: string): Promise<void> {
  const dir = path.join(workspace, ".my-pi")
  await mkdir(dir, { recursive: true })
  const ignore = path.join(dir, ".gitignore")
  if (await fileExists(ignore)) {
    const current = await readFile(ignore, "utf8").catch(() => "")
    if (!current.trimStart().startsWith(YOMA_IGNORE_MARK)) return
    if (current === YOMA_IGNORE) return
  }
  await writeFile(ignore, YOMA_IGNORE)
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
  const dir = path.join(input.workspace, ".my-pi", "bench", "turns")
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

  // 流式分行(为什么不能逐 chunk toString 见 lines.ts)。这里不 flush:
  // 子进程的最后一句协议输出总是带换行,残行只会是杂散输出。
  const decoder = lineDecoder((line) => handlers.onProgress?.(line))
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk))

  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null))
    child.on("close", resolve)
  })

  const result = await readJsonFile<TurnResult>(outputFile).catch(() => undefined)
  if (!result) throw new Error(`子进程没有产出结果(退出码 ${code});输入留在 ${inputFile}`)
  return result
}
