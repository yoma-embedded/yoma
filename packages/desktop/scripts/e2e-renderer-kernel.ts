/**
 * renderer 侧的端到端验证:真窗口 + 真 preload + 真内核进程。
 *
 * 和 e2e-kernel-ipc.ts 的分工:那个验证 main → utilityProcess → MessagePort 这一段,
 * 刻意不开窗口;**这个补上最后一跳 —— contextBridge**。
 *
 * 为什么这一跳必须单独验:Electron 在 world 之间重建 Error 时只保留 message 和 stack,
 * 自定义属性和 cause 全被丢掉。也就是说 host 标好的 `data._tag = "SessionNotFoundError"`
 * 会在 contextBridge 上 **静默蒸发**,前端拿到的只是一句话,于是把"上个版本残留的标签页"
 * 当成致命错误,整个 app 崩到错误页。
 *
 * 这个失效是运行时的序列化行为:typecheck 全绿、单测全绿、e2e-kernel-ipc 全绿,只有真的
 * 起一个窗口、让值真的穿过 contextBridge 才看得见。所以有了这个脚本。
 *
 * 用法:bun --cwd packages/desktop e2e:renderer
 */

import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } from "electron"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const desktop = process.env.YOMA_DESKTOP_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(desktop, "..", "..")
const enginesDir = process.env.YOMA_ENGINES_DIR ?? join(repoRoot, "engines")

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = "") {
  results.push(`  ${ok ? "OK  " : "FAIL"} ${name}${detail ? ` -> ${detail}` : ""}`)
  if (!ok) failed += 1
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "yoma-e2e-r-sessions-"))
  const stateDir = mkdtempSync(join(tmpdir(), "yoma-e2e-r-state-"))
  const workspace = mkdtempSync(join(tmpdir(), "yoma-e2e-r-ws-"))
  const cleanup = () => {
    for (const dir of [sessionsRoot, stateDir, workspace]) rmSync(dir, { recursive: true, force: true })
  }

  const child = utilityProcess.fork(join(desktop, "out", "main", "kernel.js"), [], {
    serviceName: "yoma-kernel-e2e-renderer",
    stdio: "pipe",
    env: { ...process.env, YOMA_ENGINES_DIR: enginesDir },
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

  child.postMessage({ type: "start", sessionsRoot, stateDir, enginesDir, version: "e2e-r" })

  // webPreferences 必须和 windows.ts 里的真窗口逐字一致 —— sandbox / contextIsolation
  // 正是决定 Error 会不会被剥壳的开关,抄错一个这个测试就白做了。
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(desktop, "out", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const attach = () => {
    const channel = new MessageChannelMain()
    child.postMessage({ type: "attach" }, [channel.port1])
    win.webContents.postMessage("kernel-port", null, [channel.port2])
  }
  ipcMain.handle("kernel-attach", () => attach())

  try {
    await ready
    check("内核进程启动并回 ready", true)
    await win.loadURL("about:blank")
    check("preload 注入了 window.api.kernel", await win.webContents.executeJavaScript(`!!window.api?.kernel?.request`))

    // ---------------------------------------------------------------------
    // 1. 端口到达之前抢跑的请求 —— preload 必须排队,不能 reject。
    //    实机崩溃过一次:provider 树一挂载就拉数据,而 kernel-port 是一条 IPC 消息。
    // ---------------------------------------------------------------------
    await win.webContents.executeJavaScript(`
      window.__early = window.api.kernel.request("app.info", undefined)
        .then((r) => ({ ok: true, version: r && r.version }))
        .catch((e) => ({ ok: false, message: e && e.message }))
      true
    `)
    attach()
    const early = await win.webContents.executeJavaScript(`window.__early`)
    check("端口到达前发出的请求会排队而不是失败", early?.ok === true && early.version === "e2e-r", JSON.stringify(early))

    // ---------------------------------------------------------------------
    // 2. 结构化错误必须活着穿过 contextBridge。
    //    这是这个脚本存在的理由 —— 别的测试全都测不到这一跳。
    // ---------------------------------------------------------------------
    const failure = await win.webContents.executeJavaScript(`
      window.api.kernel.request("session.get", { sessionID: "ses_bogus_e2e" }).then(
        (result) => ({ resolved: JSON.stringify(result ?? null) }),
        (error) => ({
          message: error && error.message,
          tag: error && error.data && error.data._tag,
          sessionID: error && error.data && error.data.sessionID,
        }),
      )
    `)
    check(
      "会话不存在时 data._tag 能穿过 contextBridge",
      failure?.tag === "SessionNotFoundError",
      JSON.stringify(failure),
    )
    check("data.sessionID 也没丢", failure?.sessionID === "ses_bogus_e2e", String(failure?.sessionID))
    check("错误消息本身还在", typeof failure?.message === "string" && failure.message.length > 0, failure?.message)

    // ---------------------------------------------------------------------
    // 3. 正常请求要能在窗口里跑通,免得上面两条靠"全都失败"蒙混过关。
    // ---------------------------------------------------------------------
    const created = await win.webContents.executeJavaScript(`
      window.api.kernel.request("session.create", ${JSON.stringify({ directory: workspace })})
        .then((s) => ({ id: s && s.id }), (e) => ({ error: e && e.message }))
    `)
    check("窗口里能真的建会话", typeof created?.id === "string" && created.id.length > 0, JSON.stringify(created))

    // 事件推送也得能到 renderer world,否则流式回答在 UI 上是死的。
    const events = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const seen = []
        const off = window.api.kernel.subscribe((batch) => { seen.push(...batch) })
        setTimeout(() => { off(); resolve(seen.map((e) => e && e.type)) }, 1200)
      })
    `)
    check("内核事件能推进 renderer world", Array.isArray(events), `${(events ?? []).length} 条`)

    // ---------------------------------------------------------------------
    // 4. 信箱调试台的桥:嵌套对象要**完整**穿过 contextBridge(施工指南 P3 验收)。
    //    invoke 的返回值与 send 的事件走的是两条不同的序列化路径,各钉一条。
    // ---------------------------------------------------------------------
    check("preload 注入了 window.api.mailbox", await win.webContents.executeJavaScript(`!!window.api?.mailbox?.subscribe`))
    ipcMain.handle("mailbox-status", () => ({
      phase: "done",
      done: { exitCode: 0, detail: "e2e", verdict: { outcome: "passed", reason: "研发端判定已解决", decidedBy: "mother" } },
    }))
    const statusThrough = await win.webContents.executeJavaScript(`
      window.api.mailbox.status().then(
        (s) => ({ outcome: s && s.done && s.done.verdict && s.done.verdict.outcome, by: s && s.done && s.done.verdict && s.done.verdict.decidedBy }),
        (e) => ({ error: e && e.message }),
      )
    `)
    check("mailbox.status 的嵌套 verdict 穿桥不丢", statusThrough?.outcome === "passed" && statusThrough?.by === "mother", JSON.stringify(statusThrough))

    await win.webContents.executeJavaScript(`
      window.__mailboxEvent = new Promise((resolve) => {
        const off = window.api.mailbox.subscribe((event) => { off(); resolve(event) })
      })
      true
    `)
    win.webContents.send("mailbox-event", {
      type: "host",
      event: { type: "snapshot", snapshot: { state: { kind: "awaiting-mother", round: 2 }, rounds: [] } },
    })
    const eventThrough = await win.webContents.executeJavaScript(`
      window.__mailboxEvent.then((e) => ({ kind: e && e.event && e.event.snapshot && e.event.snapshot.state && e.event.snapshot.state.kind, round: e && e.event && e.event.snapshot && e.event.snapshot.state && e.event.snapshot.state.round }))
    `)
    check("mailbox 事件的嵌套 snapshot 穿桥不丢", eventThrough?.kind === "awaiting-mother" && eventThrough?.round === 2, JSON.stringify(eventThrough))
  } catch (error) {
    check("renderer 端到端", false, (error as Error).message)
  }

  cleanup()
  child.kill()
  finish()
})

function finish() {
  console.log("\nrenderer ↔ kernel 端到端(真窗口 + contextBridge)")
  console.log(results.join("\n"))
  console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`)
  app.exit(failed === 0 ? 0 : 1)
}
