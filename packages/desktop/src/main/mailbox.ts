/**
 * 信箱调试台的 main 侧接线:把控制器接上真进程、真路径、真广播。
 *
 * 守护是 `child_process.spawn(process.execPath, [mailbox-host.mjs, config])` +
 * ELECTRON_RUN_AS_NODE —— 不用 utilityProcess.fork,理由是**停止语义**:
 * utilityProcess.kill() 没有信号可选,而 POSIX 上优雅停机依赖 SIGTERM 链
 * (守护转杀 turn 孙进程再退,bench/runner.ts 的 activeTurnChildren);
 * Windows 上两者都没有优雅可言,统一走 taskkill /T /F 杀整棵树。
 *
 * 守护配置文件、信箱克隆、演练布景全落在 userData/mailbox/ 下,跟着 app 数据走。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { MailboxHostConfig } from "@yoma-desktop/bench"
import {
  MailboxController,
  type MailboxLaunchHandle,
  type MailboxPublicEvent,
  type MailboxSettings,
  type MailboxTaskRequest,
} from "./mailbox-controller.ts"

export interface MailboxMainOptions {
  /** userData 根(electron 的 app.getPath("userData"),测试传临时目录)。 */
  userDataDir: string
  /** 会话根 —— 与交互内核同一个目录,跑完直接在桌面端回放观战。 */
  sessionsRoot: string
  enginesDir?: string
  /** 打包产物目录(out/main),mailbox-host.mjs / mailbox-turn-entry.mjs 住这里。 */
  bundleDir: string
  broadcast(event: MailboxPublicEvent): void
  /** 探针互斥:驱动交互内核的 mailbox.setActive。内核没起来时可为空操作。 */
  setHardwareLock(active: boolean): void
  persistence: { get(): MailboxSettings | undefined; set(settings: MailboxSettings): void }
  log?(line: string): void
}

export interface MailboxMain {
  controller: MailboxController
  /**
   * 退出/重启 app 时把守护树带走。**必须调** —— 任务在飞时用户 Cmd+Q,
   * 守护与 turn 孙进程会变成无人监督地继续烧录/gdb 的孤儿(自动更新的 relaunch
   * 同理)。先 SIGTERM 让守护自己转杀孙进程,宽限内没走干净再硬杀。
   */
  stopAll(graceMs?: number): Promise<void>
  /** 配置页的连通自检:git ls-remote,报错原样给人看。凭据走系统 git,这里不代管。 */
  probe(remote: string): Promise<{ ok: boolean; message: string }>
  /** 任务页:项目模板 + 描述 + 预算档 → 生成任务书文件。判据永远来自模板。 */
  composeJob(input: MailboxComposeInput): Promise<{ ok: boolean; jobFile?: string; message?: string }>
  /** 内核进程(重)启动后重申探针锁 —— 锁状态在 main,内核只是执行者。 */
  reassertHardwareLock(): void
}

export interface MailboxComposeInput {
  /** 项目模板(<项目>/.bench/mailbox.template.json)—— 本身就是一份少了 task 的任务书。 */
  templatePath: string
  description: string
  tier: keyof typeof BUDGET_TIERS
  title?: string
}

/** 预算三档。数值是决策:轮数管闭环长度,token 双侧合计,墙钟由 mother 在裁决点强制。 */
export const BUDGET_TIERS = {
  quick: { maxRounds: 4, maxTokens: 300_000, wallClockMin: 45 },
  standard: { maxRounds: 8, maxTokens: 1_000_000, wallClockMin: 120 },
  thorough: { maxRounds: 12, maxTokens: 2_500_000, wallClockMin: 360 },
} as const

/** 停机宽限:SIGTERM 之后守护要转杀孙进程,给它这么久,超时补硬杀。 */
const STOP_GRACE_MS = 10_000

export function createMailboxMain(options: MailboxMainOptions): MailboxMain {
  const mailboxDir = join(options.userDataDir, "mailbox")
  const children = new Map<MailboxLaunchHandle, ChildProcess>()

  const controller = new MailboxController({
    persistence: options.persistence,
    broadcast: options.broadcast,
    setHardwareLock: options.setHardwareLock,

    launch(config, io) {
      mkdirSync(mailboxDir, { recursive: true })
      const configFile = join(mailboxDir, `host-${config.role}.json`)
      writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n")

      const child = spawn(process.execPath, [join(options.bundleDir, "mailbox-host.mjs"), configFile], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        cwd: mailboxDir,
      })
      const handle: MailboxLaunchHandle = { pid: child.pid }
      children.set(handle, child)

      // 增量解码,**不能**逐 chunk `Buffer.toString()`:一条 @@event 行可以远超一个
      // pipe chunk(≤64KiB)—— 终局快照带着几万字的终报,中文 3 字节/字,一行轻松
      // 十几万字节。chunk 边界大概率落在多字节字符中间,各自解码就是两个 U+FFFD,
      // 而 JSON 的结构字符全是 ASCII,parse 照样成功 —— 乱码静默进终报。
      const stdoutDecoder = new TextDecoder()
      const stderrDecoder = new TextDecoder()
      let pending = ""
      child.stdout!.on("data", (chunk: Buffer) => {
        pending += stdoutDecoder.decode(chunk, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines) if (line.trim()) io.onLine(line)
      })
      child.stderr!.on("data", (chunk: Buffer) => {
        for (const line of stderrDecoder.decode(chunk, { stream: true }).split("\n")) {
          if (line.trim()) options.log?.(`[mailbox:${config.role}] ${line.trimEnd()}`)
        }
      })
      // spawn 失败(产物缺失)时 error 与 close **都会**来;不去重的话 onExit 跑两次,
      // 控制器就攒出两个重启定时器,恢复时起出两个守护,其中一个失控没人管。
      let exited = false
      const settle = (code: number | null) => {
        if (exited) return
        exited = true
        children.delete(handle)
        io.onExit(code)
      }
      child.on("close", settle)
      child.on("error", () => settle(null))
      return handle
    },

    stopProcess(handle, force) {
      const child = children.get(handle)
      if (!child || child.pid === undefined) return
      if (process.platform === "win32") {
        // Windows 没有优雅信号:child.kill() 只杀得死守护本体,正在跑的 agent 轮
        // 会变成孤儿继续驱动硬件(施工指南硬约束 5)。taskkill /T 杀整棵树。
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore" })
        return
      }
      child.kill(force ? "SIGKILL" : "SIGTERM")
      if (!force) {
        // 宽限后补硬杀。守护的 SIGTERM 处置会先转杀孙进程 —— 通常远用不到这一刀。
        const timer = setTimeout(() => {
          if (children.get(handle) === child && child.exitCode === null) child.kill("SIGKILL")
        }, STOP_GRACE_MS)
        timer.unref?.()
      }
    },

    buildConfig(settings, task) {
      return buildHostConfig(settings, task, options, mailboxDir)
    },
  })

  return {
    controller,
    probe: probeRemote,
    composeJob: (input) => composeJob(input, mailboxDir),
    reassertHardwareLock() {
      if (controller.hardwareLockActive()) options.setHardwareLock(true)
    },
    async stopAll(graceMs = 5_000) {
      // 先无条件 stop:任务可能正处在重启退避的间隙(没有子进程,但有一个定时器
      // 等着再起一个)。先返回就等于退出路径上又生一个守护出来。
      controller.stop()
      if (!children.size) return
      const deadline = Date.now() + graceMs
      while (children.size && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      // 宽限用完还在的:直接硬杀整棵树。退出路径上宁可粗暴,也不能留下还在
      // 动板子的孤儿 —— 那是这个产品最不该有的失败模式。
      for (const [handle] of [...children]) killHandle(children, handle)
    },
  }
}

/** 硬杀:POSIX 上 SIGKILL 守护本体,Windows 上 taskkill /T 整棵树。 */
function killHandle(children: Map<MailboxLaunchHandle, ChildProcess>, handle: MailboxLaunchHandle): void {
  const child = children.get(handle)
  if (!child || child.pid === undefined) return
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore" })
  else child.kill("SIGKILL")
  children.delete(handle)
}

/**
 * 连通自检。GIT_TERMINAL_PROMPT=0:凭据缺失要**立刻报错**,不能让 git 在后台
 * 等一个永远不会出现的终端输入 —— 那在 UI 上就是一个永远转圈的按钮。
 */
async function probeRemote(remote: string): Promise<{ ok: boolean; message: string }> {
  if (!remote.trim()) return { ok: false, message: "远端地址是空的" }
  return new Promise((resolve) => {
    const child = spawn("git", ["ls-remote", remote.trim(), "HEAD"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
    })
    let stdout = ""
    let stderr = ""
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ ok: false, message: "15 秒没有响应 —— 远端不可达,或 SSH 在等一个不存在的交互确认" })
    }, 15_000)
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ ok: false, message: `git 起不来:${error.message}` })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true, message: stdout.trim() ? "已连通" : "已连通(远端还是空仓,init 时会建出分支)" })
      else resolve({ ok: false, message: stderr.trim() || `git ls-remote 退出码 ${code}` })
    })
  })
}

/**
 * 模板 + 描述 + 预算档 → 任务书。深校验不在这里做 —— init 时 parseMailboxJob 会
 * 完整校验并把问题原样回给 UI(同一套报错,两处不重复实现)。
 */
async function composeJob(input: MailboxComposeInput, mailboxDir: string): Promise<{ ok: boolean; jobFile?: string; message?: string }> {
  const tier = BUDGET_TIERS[input.tier]
  if (!tier) return { ok: false, message: `预算档不认识:${String(input.tier)}` }
  if (!input.description.trim()) return { ok: false, message: "任务描述是空的 —— agent 不该猜要修什么" }

  let template: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(await readFile(input.templatePath, "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("模板必须是一个 JSON 对象")
    template = parsed as Record<string, unknown>
  } catch (error) {
    return { ok: false, message: `模板读不出来:${(error as Error).message}` }
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
  // id 会变成文件名:模板里写成 "foc/v2" 就会指进一个不存在的子目录,写入抛 ENOENT。
  // 那个异常原路 reject 到 renderer,而 UI 的 busy 标志没人复位 —— 整页按钮死掉。
  const rawId = typeof template.id === "string" && template.id.trim() ? template.id.trim() : "job"
  const baseId = rawId.replace(/[^A-Za-z0-9._-]/g, "-")
  const id = `${baseId}-${stamp}`
  const templateBudget = typeof template.budget === "object" && template.budget !== null ? (template.budget as Record<string, unknown>) : {}
  const templateMailbox = typeof template.mailbox === "object" && template.mailbox !== null ? (template.mailbox as Record<string, unknown>) : {}
  const templateRepo = typeof template.repo === "object" && template.repo !== null ? (template.repo as Record<string, unknown>) : {}
  // 模板的 task 字段是**项目级前置约束**(安全红线、目录禁区、已知现象),每个任务
  // 都带上 —— 不能指望每次描述都记得重写"电机绝不能转"这种事。
  const preamble = typeof template.task === "string" && template.task.trim() ? template.task.trim() : undefined
  const description = input.description.trim()
  const job = {
    ...template,
    id,
    title: input.title?.trim() || (typeof template.title === "string" ? template.title : "调试任务"),
    task: preamble ? `${preamble}\n\n## 本次要修的问题\n\n${description}` : description,
    // 模板约定住在 <项目>/.bench/ 里:repo.directory 不写就取模板所在的项目根 ——
    // 同一份模板在任何工位机上检出即用,不用每台机器手改一条绝对路径。
    repo: { directory: dirname(dirname(input.templatePath)), ...templateRepo },
    budget: { ...templateBudget, maxTokens: tier.maxTokens, wallClockMin: tier.wallClockMin },
    mailbox: { ...templateMailbox, maxRounds: tier.maxRounds },
  }

  const jobsDir = join(mailboxDir, "jobs")
  const jobFile = join(jobsDir, `${id}.json`)
  try {
    mkdirSync(jobsDir, { recursive: true })
    await writeFile(jobFile, JSON.stringify(job, null, 2) + "\n")
  } catch (error) {
    // 本函数的契约是"永远返回普通对象,不抛" —— 调用方(IPC → renderer)按这个
    // 契约写的,抛出去就是一个没人接的 rejection。
    return { ok: false, message: `任务书写不下去:${(error as Error).message}` }
  }
  return { ok: true, jobFile }
}

function cloneDirFor(mailboxDir: string, remote: string, role: string): string {
  const hash = createHash("sha1").update(remote).digest("hex").slice(0, 10)
  return join(mailboxDir, "clones", hash, role)
}

function buildHostConfig(
  settings: MailboxSettings,
  task: MailboxTaskRequest,
  options: MailboxMainOptions,
  mailboxDir: string,
): MailboxHostConfig {
  const shared = {
    branch: settings.branch,
    sessionsRoot: options.sessionsRoot,
    enginesDir: options.enginesDir,
    turnEntry: join(options.bundleDir, "mailbox-turn-entry.mjs"),
    hostEntry: join(options.bundleDir, "mailbox-host.mjs"),
  }
  if (task.kind === "sim") {
    const jobFile = task.jobFile ?? makeRehearsalJob(mailboxDir)
    return {
      role: "sim",
      jobFile,
      root: join(mailboxDir, "rehearsal", "sim"),
      fresh: task.fresh,
      pollSeconds: 2,
      // 内置演练是假模型:脚本与任务书一起生成(见 makeRehearsalJob)。
      faux: task.jobFile ? undefined : REHEARSAL_FAUX,
      ...shared,
    }
  }
  const role = task.kind === "init" ? "init" : task.kind
  return {
    role,
    remote: settings.remote,
    // 克隆按远端×角色分目录:同机双角色(演练/联调)绝不共享工作树 ——
    // 两个守护对同一克隆 reset/clean 会互相清掉写了一半的回填。
    clone: cloneDirFor(mailboxDir, settings.remote, task.kind === "init" ? settings.role : task.kind),
    jobFile: task.jobFile,
    pollSeconds: settings.pollSeconds ?? 15,
    ...shared,
  }
}

/** 内置演练的假模型脚本:两轮 —— 侦察(判据失败)→ mother 裁 continue → write 修复。 */
const REHEARSAL_FAUX: MailboxHostConfig["faux"] = {
  turns: [
    [[{ text: "我先看了一圈,还没有改动" }]],
    [[{ tool: "write", input: { path: "proof.txt", content: "bench-ok\n" } }], [{ text: "已创建 proof.txt" }]],
  ],
  mother: [
    [
      {
        text: '第 1 轮没有改动,判据自然不过。\n```json\n{"decision":"continue","analysis":"首轮只是侦察","instruction":"用 write 工具创建 proof.txt,内容 bench-ok"}\n```',
      },
    ],
  ],
}

/**
 * 生成内置演练的布景:一个一次性 git 目标仓 + 任务书。判据是"proof.txt 存在",
 * 与打包冒烟同一个剧本 —— 用户第一次点"本机演练"跑的就是 CI 验过的那条路。
 */
function makeRehearsalJob(mailboxDir: string): string {
  const root = join(mailboxDir, "rehearsal")
  const target = join(root, "target")
  mkdirSync(target, { recursive: true })
  const git = (...args: string[]) => spawnSync("git", ["-C", target, ...args], { stdio: "ignore" })
  if (git("rev-parse", "--verify", "-q", "HEAD").status !== 0) {
    git("init", "-q", "-b", "main")
    git("config", "user.email", "rehearsal@yoma.local")
    git("config", "user.name", "yoma-rehearsal")
    writeFileSync(join(target, "main.c"), "int main(void){return 0;}\n")
    git("add", "-A")
    git("commit", "-q", "-m", "init")
  }
  const checkCommand = process.platform === "win32" ? "cmd /c if exist proof.txt (exit 0) else (exit 1)" : "test -f proof.txt"
  const jobFile = join(root, "job.json")
  writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "rehearsal",
        title: "本机演练:假模型闭环",
        task: "演练:创建 proof.txt(假模型,不联网不碰硬件)",
        repo: { directory: target },
        success: { checks: [{ type: "bash", command: checkCommand }] },
        policy: "unattended",
        budget: { maxIterations: 3, maxTokens: 100_000, wallClockMin: 5 },
        mailbox: { maxRounds: 3, mother: { maxTokensPerAnalysis: 50_000 } },
      },
      null,
      2,
    ) + "\n",
  )
  return jobFile
}
