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
import { join } from "node:path"

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
  /** 内核进程(重)启动后重申探针锁 —— 锁状态在 main,内核只是执行者。 */
  reassertHardwareLock(): void
}

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

      let pending = ""
      child.stdout!.on("data", (chunk: Buffer) => {
        pending += chunk.toString()
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines) if (line.trim()) io.onLine(line)
      })
      child.stderr!.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) if (line.trim()) options.log?.(`[mailbox:${config.role}] ${line.trimEnd()}`)
      })
      child.on("close", (code) => {
        children.delete(handle)
        io.onExit(code)
      })
      child.on("error", () => {
        children.delete(handle)
        io.onExit(null)
      })
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
    reassertHardwareLock() {
      if (controller.hardwareLockActive()) options.setHardwareLock(true)
    },
  }
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
