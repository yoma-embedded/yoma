/**
 * 生产路径的端到端验证:Electron main → utilityProcess → MessagePort → 内核 host。
 *
 * 和 kernel-smoke.ts 的区别:那个只验证"内核加载得起来";这个走的是 app 真正用的那条
 * 通道 —— 真的 fork out/main/kernel.js、真的开 MessageChannelMain、真的发协议帧。
 * 只有这条通了,才谈得上"renderer 能跟内核说话"。
 *
 * 刻意不开窗口:验证接线不需要 GUI,也就不会去动任何正在跑的 dev 会话。
 *
 * 用法:electron packages/desktop/scripts/e2e-kernel-ipc.ts(见同目录的 run-e2e-ipc.sh)
 */

import { app, MessageChannelMain, utilityProcess } from "electron"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// 打包后本文件的位置会变,别靠 import.meta.url 推目录 —— 显式传进来。
const desktop = process.env.YOMA_DESKTOP_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(desktop, "..", "..")

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = "") {
  results.push(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? ` -> ${detail}` : ""}`)
  if (!ok) failed += 1
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "yoma-e2e-sessions-"))
  const stateDir = mkdtempSync(join(tmpdir(), "yoma-e2e-state-"))
  const workspace = mkdtempSync(join(tmpdir(), "yoma-e2e-ws-"))

  const child = utilityProcess.fork(join(desktop, "out", "main", "kernel.js"), [], {
    serviceName: "yoma-kernel-e2e",
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

  // **刻意在 start 之前就 attach 并发请求** —— 这是实机崩溃的那个顺序:
  // attach 和 start 是两条独立的 postMessage,到达顺序不由我们决定。
  // 早期版本 host 还不存在时 `host?.handle()` 会静默 resolve 成 undefined,
  // renderer 拿到空结果却以为成功了。
  const earlyChannel = new MessageChannelMain()
  child.postMessage({ type: "attach" }, [earlyChannel.port1])
  earlyChannel.port2.start()
  const earlyAnswer = new Promise<any>((resolve) => {
    earlyChannel.port2.on("message", (event) => {
      const frame = event.data as { kind: string; id: number; result?: unknown; error?: { message: string } }
      if (frame?.kind === "response" && frame.id === 999) resolve(frame)
    })
  })
  earlyChannel.port2.postMessage({ kind: "request", id: 999, method: "app.info", params: undefined })

  child.postMessage({
    type: "start",
    sessionsRoot,
    stateDir,
    enginesDir: join(repoRoot, "engines"),
    version: "e2e",
  })

  try {
    await ready
    check("内核进程启动并回 ready", true)
  } catch (error) {
    check("内核进程启动并回 ready", false, (error as Error).message)
    finish()
    return
  }

  // 和 main/kernel.ts 的 attach() 完全一样:一条 MessageChannel,一端给内核,一端本来给 renderer。
  const channel = new MessageChannelMain()
  child.postMessage({ type: "attach" }, [channel.port1])
  const port = channel.port2
  port.start()

  let nextId = 1
  const pending = new Map<number, (value: { result?: unknown; error?: { message: string } }) => void>()
  const pushes: unknown[][] = []

  port.on("message", (event) => {
    const frame = event.data as
      | { kind: "response"; id: number; result?: unknown; error?: { message: string } }
      | { kind: "push"; events: unknown[] }
    if (frame?.kind === "push") {
      pushes.push(frame.events)
      return
    }
    if (frame?.kind === "response") pending.get(frame.id)?.(frame)
  })

  function request(method: string, params: unknown): Promise<any> {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 20_000)
      pending.set(id, (frame) => {
        clearTimeout(timer)
        pending.delete(id)
        if (frame.error) reject(new Error(frame.error.message))
        else resolve(frame.result)
      })
      port.postMessage({ kind: "request", id, method, params })
    })
  }

  try {
    // 先验竞态:那条抢跑的请求必须拿到真实结果,不能是 undefined 也不能报错。
    const early = await Promise.race([
      earlyAnswer,
      new Promise((resolve) => setTimeout(() => resolve({ error: { message: "抢跑请求 5 秒无响应" } }), 5_000)),
    ])
    check(
      "start 之前抢跑的请求也能拿到真实结果",
      Boolean((early as any)?.result?.version === "e2e"),
      (early as any)?.error?.message ?? JSON.stringify((early as any)?.result ?? null),
    )
    earlyChannel.port2.close()

    const info = await request("app.info", undefined)
    check("app.info 走通 MessagePort", info?.version === "e2e", `node ${info?.node}`)

    const session = await request("session.create", { directory: workspace })
    check("session.create 建出会话", Boolean(session?.id), session?.id)

    const listed = await request("session.list", { directory: workspace })
    check(
      "session.list 能读回刚建的会话",
      Array.isArray(listed) && listed.some((s: { id: string }) => s.id === session.id),
    )

    const files = await request("file.list", { directory: workspace })
    check("file.list 可用", Array.isArray(files))

    const vcs = await request("vcs.info", { directory: workspace })
    check("vcs.info 对非 git 目录不报错", vcs && vcs.dirty === false)

    // 内核进程主动推事件(session.created)是"流式能到 renderer"的最小证据。
    await new Promise((resolve) => setTimeout(resolve, 300))
    const created = pushes.flat().some((e: any) => e?.type === "session.created")
    check("事件能主动推到端口", created, `共 ${pushes.flat().length} 条`)

    // 模型目录没有凭据时应该是空列表而不是抛错 —— 前端要能显示引导而不是白屏。
    const providers = await request("model.list", undefined)
    check("model.list 无凭据时优雅降级", Array.isArray(providers), `${providers.length} 个 provider`)
  } catch (error) {
    check("协议往返", false, (error as Error).message)
  }

  rmSync(sessionsRoot, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
  child.kill()
  finish()
})

function finish() {
  console.log("\n生产路径端到端(Electron utilityProcess + MessagePort):")
  console.log(results.join("\n"))
  console.log(failed === 0 ? "\n通过。\n" : `\n失败 ${failed} 项。\n`)
  app.exit(failed === 0 ? 0 : 1)
}
