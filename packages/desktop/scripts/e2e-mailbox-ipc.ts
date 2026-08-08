/**
 * 信箱调试台 main 托管的端到端(e2e:ipc 同款,不开窗口):
 *
 * 1. 真 out/main/kernel.js:`mailbox.setActive` 协议往返 —— 探针互斥的下发通道
 *    必须在打包产物上活着(内核 inline 的漂移只有这种真跑抓得住)。
 * 2. 真 createMailboxMain 接线 + **假守护脚本**喂 @@event:开跑 → 事件到达 →
 *    快照进 status → 硬件锁拨动 → 停止时孙进程一并死掉(SIGTERM 链)。
 * 3. 锁冲突(退出码 3)必须translated成人话,不进重启循环。
 *
 * 用法:bun run e2e:mailbox(先 bun run build 产出 kernel.js)。
 */

import { app, MessageChannelMain, utilityProcess } from "electron"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createMailboxMain } from "../src/main/mailbox.ts"
import type { MailboxPublicEvent, MailboxSettings } from "../src/main/mailbox-controller.ts"

const desktop = process.env.YOMA_DESKTOP_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(desktop, "..", "..")

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = "") {
  results.push(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? ` -> ${detail}` : ""}`)
  if (!ok) failed += 1
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const started = Date.now()
  while (!cond()) {
    if (Date.now() - started > timeoutMs) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 假守护:发 hello+snapshot,起一个孙进程记下 pid,SIGTERM 时转杀再退(真守护的信号链语义)。 */
const FAKE_DAEMON_LONG = `
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
const emit = (e) => process.stdout.write("@@event " + JSON.stringify(e) + "\\n")
emit({ type: "hello", role: "runner", pid: process.pid })
emit({ type: "snapshot", snapshot: { state: { kind: "awaiting-runner", round: 1 }, rounds: [] } })
const grand = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })
writeFileSync("grandchild.pid", String(grand.pid))
process.on("SIGTERM", () => { grand.kill("SIGKILL"); process.exit(143) })
setInterval(() => {}, 1000)
`

/** 假守护:单实例锁冲突的样子 —— done 事件带退出码 3,然后退出。 */
const FAKE_DAEMON_CONFLICT = `
const emit = (e) => process.stdout.write("@@event " + JSON.stringify(e) + "\\n")
emit({ type: "hello", role: "runner", pid: process.pid })
emit({ type: "done", exitCode: 3, detail: "runner 已有实例在跑(pid 42)—— 一个信箱克隆一个角色只能有一个实例" })
process.exit(3)
`

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const cleanups: string[] = []
  const temp = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    cleanups.push(dir)
    return dir
  }

  // ── 1. 真内核 bundle 的 mailbox.setActive 往返 ──────────────────────────────
  const child = utilityProcess.fork(join(desktop, "out", "main", "kernel.js"), [], {
    serviceName: "yoma-kernel-e2e-mailbox",
    stdio: "pipe",
    env: { ...process.env, YOMA_ENGINES_DIR: join(repoRoot, "engines") },
  })
  child.stderr?.on("data", (chunk: Buffer) => console.error("[kernel]", chunk.toString().trimEnd()))
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("内核进程 30 秒内没有 ready")), 30_000)
    child.on("message", (message: { type?: string }) => {
      if (message?.type === "ready") {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  child.postMessage({ type: "start", sessionsRoot: temp("mb-e2e-sessions-"), stateDir: temp("mb-e2e-state-"), version: "e2e" })

  try {
    await ready
    const channel = new MessageChannelMain()
    child.postMessage({ type: "attach" }, [channel.port1])
    const port = channel.port2
    port.start()
    let nextId = 1
    const pending = new Map<number, (frame: { result?: unknown; error?: { message: string } }) => void>()
    port.on("message", (event) => {
      const frame = event.data as { kind: string; id: number; result?: unknown; error?: { message: string } }
      if (frame?.kind === "response") pending.get(frame.id)?.(frame)
    })
    const request = (method: string, params: unknown): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 20_000)
        pending.set(id, (frame) => {
          clearTimeout(timer)
          pending.delete(id)
          if (frame.error) reject(new Error(frame.error.message))
          else resolve(frame.result)
        })
        port.postMessage({ kind: "request", id, method, params })
      })

    const on = (await request("mailbox.setActive", { active: true, reason: "e2e" })) as { active?: boolean }
    check("mailbox.setActive(true) 在真内核 bundle 上走通", on?.active === true, JSON.stringify(on))
    const off = (await request("mailbox.setActive", { active: false })) as { active?: boolean }
    check("mailbox.setActive(false) 撤锁", off?.active === false, JSON.stringify(off))
  } catch (error) {
    check("mailbox.setActive 协议往返", false, (error as Error).message)
  }
  child.kill()

  // ── 2. 真 main 接线 + 假守护:开跑/事件/锁/停止杀树 ─────────────────────────
  {
    const userData = temp("mb-e2e-userdata-")
    const bundleDir = temp("mb-e2e-bundle-")
    const project = temp("mb-e2e-project-")
    writeFileSync(join(bundleDir, "mailbox-host.mjs"), FAKE_DAEMON_LONG)

    const locks: boolean[] = []
    const events: MailboxPublicEvent[] = []
    let saved: MailboxSettings | undefined
    const mailbox = createMailboxMain({
      userDataDir: userData,
      sessionsRoot: join(userData, "sessions"),
      bundleDir,
      broadcast: (event) => events.push(event),
      setHardwareLock: (active) => locks.push(active),
      persistence: {
        get: () => saved,
        set: (settings) => {
          saved = settings
        },
      },
    })

    // 工程目录是**本机配置**(任务书里不带绝对路径),常驻角色缺了它开不了跑。
    const configured = mailbox.controller.configure({ remote: join(userData, "origin.git"), role: "runner", projectDir: project })
    check("configure 接受本地远端", configured.ok === true, JSON.stringify(configured))

    const started = mailbox.controller.start({ kind: "runner" })
    check("start 接受 runner 任务", started.ok === true, JSON.stringify(started))
    check("runner 任务活跃即上探针锁", locks[0] === true, JSON.stringify(locks))

    // 守护配置是真写到盘上的那一份:本机工程目录必须穿到守护那头,否则第一轮才
    // 在守护日志里报"没配工程目录",而 UI 上看着一切正常。
    const hostConfigFile = join(userData, "mailbox", "host-runner.json")
    const sawHostConfig = await waitFor(() => existsSync(hostConfigFile), 5_000)
    const hostConfig = sawHostConfig ? (JSON.parse(readFileSync(hostConfigFile, "utf8")) as { projectDir?: string }) : {}
    check("守护配置带上了本机工程目录", hostConfig.projectDir === project, JSON.stringify(hostConfig.projectDir))

    const sawSnapshot = await waitFor(() =>
      events.some((event) => event.type === "host" && event.event.type === "snapshot"),
    )
    check("假守护的 @@event 到达并广播", sawSnapshot, `共 ${events.length} 条`)
    check(
      "快照缓存进 status(renderer 随时拉得到)",
      mailbox.controller.status().snapshot?.state.kind === "awaiting-runner",
      JSON.stringify(mailbox.controller.status().snapshot?.state),
    )

    const pidFile = join(userData, "mailbox", "grandchild.pid")
    const sawGrandchild = await waitFor(() => existsSync(pidFile))
    check("假守护起出了孙进程", sawGrandchild)
    const grandPid = sawGrandchild ? Number.parseInt(readFileSync(pidFile, "utf8"), 10) : 0

    mailbox.controller.stop()
    const stopped = await waitFor(() => mailbox.controller.status().phase === "idle")
    check("停止后回到 idle", stopped, mailbox.controller.status().phase)
    check("停止即撤锁", locks[locks.length - 1] === false, JSON.stringify(locks))
    const grandDead = await waitFor(() => grandPid > 0 && !alive(grandPid), 5_000)
    check("孙进程随 SIGTERM 链一并死掉(停止 = 整棵树)", grandDead, `pid ${grandPid}`)
  }

  // ── 3. 退出 app 的那条路:stopAll 必须带走整棵守护树 ─────────────────────────
  {
    const userData = temp("mb-e2e-userdata-quit-")
    const bundleDir = temp("mb-e2e-bundle-quit-")
    writeFileSync(join(bundleDir, "mailbox-host.mjs"), FAKE_DAEMON_LONG)

    let saved: MailboxSettings | undefined
    const mailbox = createMailboxMain({
      userDataDir: userData,
      sessionsRoot: join(userData, "sessions"),
      bundleDir,
      broadcast: () => {},
      setHardwareLock: () => {},
      persistence: {
        get: () => saved,
        set: (settings) => {
          saved = settings
        },
      },
    })
    mailbox.controller.configure({ remote: join(userData, "origin.git"), role: "runner", projectDir: userData })
    mailbox.controller.start({ kind: "runner" })

    const pidFile = join(userData, "mailbox", "grandchild.pid")
    const ready = await waitFor(() => existsSync(pidFile))
    const daemonPid = mailbox.controller.status().task?.pid ?? 0
    const grandPid = ready ? Number.parseInt(readFileSync(pidFile, "utf8"), 10) : 0
    check("退出前守护与孙进程都活着", ready && alive(daemonPid) && alive(grandPid), `daemon ${daemonPid} / grand ${grandPid}`)

    // 这就是 before-quit / relaunch 走的那条路。任务在飞时用户 Cmd+Q,
    // 守护与 turn 孙进程绝不能变成还在动板子的孤儿。
    await mailbox.stopAll(5_000)
    const daemonDead = await waitFor(() => !alive(daemonPid), 5_000)
    const grandDead = await waitFor(() => !alive(grandPid), 5_000)
    check("stopAll 之后守护死了", daemonDead, `pid ${daemonPid}`)
    check("stopAll 之后孙进程也死了(退出不留驱动硬件的孤儿)", grandDead, `pid ${grandPid}`)
  }

  // ── 4. 锁冲突:人话,不进重启循环 ───────────────────────────────────────────
  {
    const userData = temp("mb-e2e-userdata2-")
    const bundleDir = temp("mb-e2e-bundle2-")
    writeFileSync(join(bundleDir, "mailbox-host.mjs"), FAKE_DAEMON_CONFLICT)

    let saved: MailboxSettings | undefined
    const mailbox = createMailboxMain({
      userDataDir: userData,
      sessionsRoot: join(userData, "sessions"),
      bundleDir,
      broadcast: () => {},
      setHardwareLock: () => {},
      persistence: {
        get: () => saved,
        set: (settings) => {
          saved = settings
        },
      },
    })
    mailbox.controller.configure({ remote: join(userData, "origin.git"), role: "runner", projectDir: userData })
    mailbox.controller.start({ kind: "runner" })
    const errored = await waitFor(() => mailbox.controller.status().phase === "error")
    const status = mailbox.controller.status()
    check("锁冲突进 error 而不是重启循环", errored, status.phase)
    check("锁冲突的报错是人话", Boolean(status.message?.includes("另一个 Yoma 实例")), status.message ?? "")
  }

  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
  finish()
})

function finish() {
  console.log("\n信箱调试台 main 托管端到端:")
  console.log(results.join("\n"))
  console.log(failed === 0 ? "\n通过。\n" : `\n失败 ${failed} 项。\n`)
  app.exit(failed === 0 ? 0 : 1)
}
