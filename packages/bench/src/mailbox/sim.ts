/**
 * 单机模拟 —— 在一台电脑上把跨机器闭环真实地跑一遍。
 *
 * "真实"是指:runner 和 mother 是**两个真的子进程**,各自持有**各自的信箱克隆**,
 * 相互只通过 git 远端说话 —— 没有共享内存、没有共享文件、没有旁路。把远端从本地
 * 裸仓换成一个私有 GitHub 仓(--remote),再把其中一个进程搬去另一台机器,
 * 就是生产形态,一行代码不用改。
 *
 * 默认远端是 `<模拟根>/origin.git` 本地裸仓:零网络、零凭据,协议语义与真远端相同
 * (push/fetch/非快进拒绝全在)。
 */

import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { fileExists } from "../fsx.ts"
import { lineDecoder } from "../lines.ts"
import { resolveWorkspace } from "../job.ts"
import { ensureYomaDir } from "../runner.ts"
import { initMailbox } from "./init.ts"
import { loadMailboxJob } from "./spec.ts"
import { readVerdict, scanMailbox, REPORT_FILE, type MailboxVerdict } from "./store.ts"
import { ensureClone, initBareMailbox, pullReset } from "./sync.ts"

/** 单机模拟的看门狗上限(分钟)。见 SimOptions.timeoutMin。 */
const DEFAULT_SIM_TIMEOUT_MIN = 60

export interface SimOptions {
  jobFile: string
  /**
   * **这台机器上**的工程目录。演练也走机器无关那条路 —— job 文件里可以没有
   * directory(它本来就该没有),由这里提供。只有 mother 子进程收得到它:
   * 工位端在生产形态下根本没有项目检出,演练必须复现这一点,否则演练是假的。
   */
  projectDir?: string
  /** 模拟根目录,默认 `<目标仓>/.my-pi/bench/mailbox-sim/<jobId>`。 */
  root?: string
  /** 已有远端(私有 GitHub 仓等)。不给就在模拟根下建本地裸仓。 */
  remote?: string
  branch?: string
  /** 两个子进程的轮询间隔(秒),默认 3 —— 单机模拟不需要客气。 */
  pollSeconds?: number
  /**
   * 模拟的墙钟上限(分钟),默认 60。
   *
   * 这是**演练台的看门狗**,不是产品预算 —— 生产闭环没有时间上限(跑到 agent
   * 自己收工为止),但单机模拟得能在 CI 里保证收敛,否则一个不肯认输的剧本会把
   * 流水线挂住。
   */
  timeoutMin?: number
  /** 清掉上次模拟从头来(本地裸仓会一起消失)。缺省是续跑。 */
  fresh?: boolean
  onOutput?: (line: string) => void
  /**
   * 起角色守护进程的方式。缺省 bun 直跑 cli.ts(开发态);打包态由宿主注入
   * (mailbox-host 以自身为入口自我 spawn)。返回的子进程必须把 stdout/stderr
   * 开成 pipe —— sim 靠它转发两侧输出。
   */
  spawnRole?: (role: "runner" | "mother", clone: string, context: SimSpawnContext) => ChildProcess
}

export interface SimSpawnContext {
  root: string
  branch: string
  pollSeconds: number
  /** 定下来的本机工程目录 —— 只给 mother(工位端没有项目检出)。 */
  projectDir: string
}

export interface SimResult {
  verdict?: MailboxVerdict
  mailboxDir: string
  reportFile?: string
  /** 0 = 终局 passed;2 = 终局 failed(闭环走完了,结论是没修好);1 = 没有 verdict 的异常;124 = 墙钟超时。 */
  exitCode: number
  detail: string
}

async function exists(dir: string): Promise<boolean> {
  return stat(dir).then(
    () => true,
    () => false,
  )
}

export async function runSim(options: SimOptions): Promise<SimResult> {
  const say = options.onOutput ?? (() => {})
  const mailboxJob = await loadMailboxJob(options.jobFile)
  const job = mailboxJob.job
  const workspace = resolveWorkspace(job, options.projectDir)
  // root 必须先归一成绝对路径:它还会被当作两个子进程的 cwd,相对路径在子进程里
  // 会再按 cwd 解析一次,拼出双重路径(实测:blocked 无限重试直到墙钟耗尽)。
  const root = path.resolve(options.root ?? path.join(workspace, ".my-pi", "bench", "mailbox-sim", job.id))
  const branch = options.branch ?? "main"
  const pollSeconds = options.pollSeconds ?? 3

  await ensureYomaDir(workspace)

  // 模拟根只认自己人:有 sim.json 的目录才敢续用或清理,别的目录一律拒绝 ——
  // rm -rf 不该指向一个我们没写过的地方。
  const runnerClone = path.join(root, "runner-clone")
  const motherClone = path.join(root, "mother-clone")
  const localBare = path.join(root, "origin.git")
  const marker = path.join(root, "sim.json")
  const rootExists = (await fileExists(marker)) || (await exists(localBare)) || (await exists(runnerClone))
  if (rootExists && !(await fileExists(marker))) {
    return { mailboxDir: motherClone, exitCode: 1, detail: `${root} 已存在但不像上次的模拟产物,不敢动 —— 换个 --root 或自己清理` }
  }
  if (options.fresh && rootExists) {
    await rm(root, { recursive: true, force: true })
    say(`--fresh:已清掉上次模拟(${root})`)
  }
  await mkdir(root, { recursive: true })
  await writeFile(marker, JSON.stringify({ jobFile: path.resolve(options.jobFile), at: new Date().toISOString() }, null, 2) + "\n")

  const remote = options.remote ?? localBare
  if (!options.remote) {
    if (!(await exists(localBare))) {
      await initBareMailbox(localBare, { branch })
      say(`本地裸仓已建:${localBare}`)
    }
  } else {
    say(`使用外部远端:${remote}`)
  }

  await ensureClone(remote, runnerClone, { branch })
  await ensureClone(remote, motherClone, { branch })

  // 空信箱才 init;非空说明是续跑(上次模拟中断,或远端预先放好了任务)。
  const snapshot = await scanMailbox(motherClone)
  if (snapshot.state.kind === "empty") {
    const initialized = await initMailbox({ clone: motherClone, branch, mailboxJob })
    if (!initialized.initialized) return { mailboxDir: motherClone, exitCode: 1, detail: initialized.detail }
    say(initialized.detail)
  } else {
    say(`信箱已有任务(状态 ${snapshot.state.kind}),继续上次的闭环`)
  }

  const spawnDefault = (role: "runner" | "mother", clone: string): ChildProcess => {
    // 缺省路径依赖 bun(直跑 TS 源码 + import.meta.dir)。打包态没有这两样,
    // 必须由宿主注入 spawnRole —— 静默走缺省会 spawn 出一个必死的进程。
    if (!process.versions.bun) throw new Error("非 bun 运行时跑 sim 必须注入 spawnRole(打包态由 mailbox-host 自我 spawn)")
    const cliEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts")
    const argv = [cliEntry, "mailbox", role, clone, "--interval", String(pollSeconds), "--branch", branch]
    // 工程目录只给研发端 —— 工位端没有检出,这是生产形态的事实,演练要一致。
    if (role === "mother") argv.push("--project", workspace)
    return spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"], cwd: root })
  }
  const spawnRole = (role: "runner" | "mother", clone: string): ChildProcess => {
    const child = options.spawnRole
      ? options.spawnRole(role, clone, { root, branch, pollSeconds, projectDir: workspace })
      : spawnDefault(role, clone)
    // 每条流各一个解码器:共用一个的话两边的半行会互相串。见 lines.ts 的两个坑。
    const emit = (line: string) => say(`[${role}] ${line}`)
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue
      const decoder = lineDecoder(emit)
      stream.on("data", (chunk: Buffer) => decoder.push(chunk))
      stream.on("end", () => decoder.flush())
    }
    return child
  }

  say(`起两个子进程(轮询 ${pollSeconds}s)—— 它们只通过 ${options.remote ? "远端仓库" : "本地裸仓"} 通信`)
  const runner = spawnRole("runner", runnerClone)
  const mother = spawnRole("mother", motherClone)
  const children = [runner, mother]

  const killAll = (signal: NodeJS.Signals = "SIGTERM") => {
    for (const child of children) if (child.exitCode === null) child.kill(signal)
  }
  const onSignal = () => {
    // runner 收到 SIGTERM 会转杀 turn-entry 再退;留 3 秒宽限,顽固者补 SIGKILL。
    killAll()
    setTimeout(() => {
      killAll("SIGKILL")
      process.exit(130)
    }, 3000)
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  const timeoutMin = options.timeoutMin ?? DEFAULT_SIM_TIMEOUT_MIN
  const exits = children.map(
    (child) =>
      new Promise<number | null>((resolve) => {
        child.on("close", (code) => resolve(code))
        child.on("error", () => resolve(null))
      }),
  )
  const timeout = new Promise<"timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMin * 60 * 1000)
    ;(timer as { unref?: () => void }).unref?.()
  })

  let timedOut = false
  let childCodes: (number | null)[] = []
  const raced = await Promise.race([Promise.all(exits), timeout])
  if (raced === "timeout") {
    timedOut = true
    killAll()
    // 宽限等孩子自己收尾(转杀孙进程、关管道);超过宽限的补 SIGKILL,
    // 绝不在这里无限等 —— 超时收尾自己挂死是实测踩过的坑。
    const grace = new Promise<"grace">((resolve) => {
      const timer = setTimeout(() => resolve("grace"), 15_000)
      ;(timer as { unref?: () => void }).unref?.()
    })
    if ((await Promise.race([Promise.all(exits), grace])) === "grace") killAll("SIGKILL")
    childCodes = await Promise.all(exits)
  } else {
    childCodes = raced
  }
  process.off("SIGINT", onSignal)
  process.off("SIGTERM", onSignal)

  // 从远端读终局 —— 不信任何一个克隆的本地状态。
  await pullReset({ clone: motherClone, branch, author: { name: "yoma-mailbox-sim", email: "bench@yoma.local" } }).catch(() => ({}))
  const verdict = await readVerdict(motherClone)
  const reportFile = path.join(motherClone, REPORT_FILE)
  const hasReport = await fileExists(reportFile)

  // 先读终局再定性:failed 是设计内的终局,子进程按约定以非零码退出,
  // 不能报成"子进程异常"(那会盖掉真正的终局理由,契约里 0 就该是"拿到 verdict")。
  let exitCode = 0
  let detail = ""
  if (verdict) {
    exitCode = verdict.outcome === "passed" ? 0 : 2
    detail = `终局 ${verdict.outcome}:${verdict.reason}`
  } else if (timedOut) {
    exitCode = 124
    detail = `墙钟 ${timeoutMin} 分钟耗尽,已停止两个子进程(信箱里留着当前进度,重跑 sim 会续)`
  } else {
    exitCode = 1
    detail = `没有 verdict,子进程退出:runner=${childCodes[0]} mother=${childCodes[1]} —— 看上面的输出找原因`
  }
  return { verdict, mailboxDir: motherClone, reportFile: hasReport ? reportFile : undefined, exitCode, detail }
}
