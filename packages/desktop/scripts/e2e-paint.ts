/**
 * 首屏闸门:真窗口 + 真内核 + 把界面点一遍。
 *
 * 和 e2e-renderer-kernel.ts 的分工:那个只验最后一跳 contextBridge,窗口里 load 的是
 * `about:blank` —— **真正的 renderer 包(SolidJS 路由 + 首页 + 会话页 + 右栏仪器)一行都没跑过**。
 * 首页挂载时抛异常、某个 provider 在 Electron 下拿不到 window.api、换成 MemoryRouter 之后
 * 点会话行进不去会话页、逻辑分析仪面板一挂载就崩 —— 这些 typecheck 全绿、单测全绿、
 * `e2e:ipc` / `e2e:renderer` 全绿,只有真开一个窗口、真点下去才看得见。
 *
 * 做法:用 Electron 二进制跑**构建产物** `out/main/index.js`(解析方式与 run-e2e.ts 一致),
 * `YOMA_TEST_ONBOARDING=1`(userData / XDG 全落在临时目录,每次都是全新的用户、空的
 * localStorage、:memory: 的库)+ `YOMA_CHANNEL=dev`;然后接上 dev 构建**自己**开的
 * Chrome DevTools 端点,用 CDP 评估与点击。调试端口不在这里写第二遍:从 main 的
 * `remote-debugging-port` 那一行读出来(只在未打包时开,正好是这条闸门跑的形态)。
 *
 * 注意:**窗口是看得见的** —— 真会在开发者屏幕上弹出来,然后自己关掉。本机实测全程 ~5 秒,
 * 冷启动 / 慢机器上到 ~30 秒都算正常(脚本最后会打印实际秒数)。期间不要去点它:
 * 手点进去的状态会把断言的因果关系搅乱。
 *
 * 用法:npm run e2e:paint -w packages/desktop(前置:npm run build -w packages/desktop)
 */

import { spawn, spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveElectron } from "./electron-bin.ts"
import {
  BACKGROUND_ANSWER,
  BACKGROUND_DESCRIPTION,
  moveSeededSessions,
  seedSubagentSession,
  SUBAGENT_ANSWER,
  SUBAGENT_DESCRIPTION,
  SUBAGENT_PARENT_TITLE,
} from "./e2e-seed-subagent.ts"

const PAGE_TIMEOUT_MS = 60_000
const MOUNT_TIMEOUT_MS = 30_000
const APPEAR_TIMEOUT_MS = 15_000
const CDP_TIMEOUT_MS = 15_000
const SESSION_TITLE = "首屏闸门会话"
const TYPED_TEXT = "首屏闸门打字"
/**
 * 工程目录的名字要独一份:侧栏那条断言是"innerText 里含这个名字",叫 `workspace` 的话
 * 界面上任何别的 "workspace" 字样(空态文案、某个按钮)都能把它蒙过去。带 pid 还顺带让
 * 两条同时跑的闸门不会互认对方的工程。
 */
const WORKSPACE_NAME = `paint-gate-工程-${process.pid}`

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, "..")
const mainEntry = join(desktop, "out", "main", "index.js")

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const startedAt = Date.now()
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`

// --------------------------------------------------------------------------- 结果

const results: string[] = []
let failed = 0

function check(name: string, ok: boolean, detail = "") {
  const line = `  ${ok ? "OK  " : "FAIL"} ${name}${detail ? ` -> ${detail}` : ""}`
  results.push(line)
  console.log(line)
  if (!ok) failed += 1
}

// --------------------------------------------------------------------------- 调试端口

/**
 * main 里那一行 `app.commandLine.appendSwitch("remote-debugging-port", "9222")` 是端口的
 * **唯一**出处。这里读它(先读真正被跑的构建产物,再退回源码),免得仓里出现两个 9222
 * —— 那种重复改一处就是静默连错进程。
 */
function resolveDebugPort(): number {
  const candidates = [mainEntry, join(desktop, "src", "main", "index.ts")]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const hit = readFileSync(file, "utf8").match(/remote-debugging-port"\s*,\s*"(\d+)"/)
    if (hit?.[1]) return Number(hit[1])
  }
  throw new Error(
    `没在 ${candidates.join("、")} 里找到 remote-debugging-port —— main 改了开关写法的话,这条闸门要跟着改`,
  )
}

/**
 * 端口上有没有人在听。**不能**拿 `fetch /json/version` 的 200 来判断:随便一个别的服务
 * (实测过一个 python http.server)会回 404,于是这里放行、Chromium 那边 bind 失败、
 * 窗口起来了但没有调试端点,白等 60 秒。所以直接连 TCP。
 */
function portInUse(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port })
    const done = (answer: boolean) => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(1_000)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

type Target = { type?: string; url?: string; webSocketDebuggerUrl?: string }

async function pageTarget(port: number): Promise<Target | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return
    const targets = (await response.json()) as Target[]
    return targets.find(
      (target) => target.type === "page" && !!target.webSocketDebuggerUrl && !target.url?.startsWith("devtools://"),
    )
  } catch {
    return
  }
}

// --------------------------------------------------------------------------- 前置

if (!existsSync(mainEntry)) {
  console.error(`没有构建产物 ${mainEntry} —— 先跑 npm run build -w packages/desktop`)
  process.exit(1)
}

const port = resolveDebugPort()
if (await portInUse(port)) {
  console.error(
    `127.0.0.1:${port} 上已经有人在听(多半是 npm run dev:desktop,或上一次没退干净的 Electron)。\n` +
      `这条闸门要连的是它自己起的那个窗口 —— 端口被占着的话,要么断言的是别人的界面,` +
      `要么这个窗口根本开不出调试端点。先把那个进程关掉。`,
  )
  process.exit(1)
}

const electron = resolveElectron(desktop)
const tmpRoot = mkdtempSync(join(tmpdir(), "yoma-e2e-paint-"))
// 工程目录要用 realpath:macOS 的 /var/folders 是 /private/var 的软链,内核回的
// session.directory 与我们种进名单的 worktree 必须逐字相同,否则首页那条会话认不出工程。
const workspace = (() => {
  const dir = join(tmpRoot, WORKSPACE_NAME)
  mkdirSync(dir, { recursive: true })
  return realpathSync(dir)
})()

// 硬件日志:log 面板读的是磁盘上的 `.yoma/logs/hw-*.log`(经真 file.list + file.read),
// 不是 transcript。种一份带级别标记的语料,这一跳就能挡住"面板挑错文件 / 认错级别"。
const logsDir = join(workspace, ".yoma", "logs")
mkdirSync(logsDir, { recursive: true })
// 两份:面板必须挑名字最新的那一份(file.list 没有 mtime,只能按时间戳文件名排)。
writeFileSync(join(logsDir, "hw-20260101-000000000.log"), "I (1) old: 这是旧的一份,不该被选中\n")
writeFileSync(
  join(logsDir, "hw-20260918-101112345.log"),
  [
    "I (12) boot: paint-gate 固件 v1.2.3 起来了",
    "D (18) sched: tick",
    "W (24) adc: 通道 1 接近满量程",
    "E (31) i2c: NACK @ 0x48",
    "*** HardFault *** pc=0x080003c6",
    "",
  ].join("\n"),
)

// Known offline evidence: tests exercise the real RPC and renderer without touching a USB instrument.
const scopeDir = join(workspace, ".yoma", "scope", "paint-scope")
mkdirSync(scopeDir, { recursive: true })
const scopeValues = Buffer.alloc(8192)
for (let i = 0; i < 4096; i++)
  scopeValues.writeInt16LE(i === 2049 ? 24000 : Math.round(12000 * Math.sin((i * Math.PI) / 128)), i * 2)
writeFileSync(join(scopeDir, "c1.i16"), scopeValues)
copyFileSync(join(desktop, "..", "kernel", "test", "fixtures", "scope", "screen.png"), join(scopeDir, "screen.png"))
writeFileSync(
  join(scopeDir, "capture.json"),
  JSON.stringify({
    schema: "yoma/scope@1",
    id: "paint-scope",
    createdAt: 1789000000000,
    address: "usb:offline-fixture",
    model: "SDS824X HD (test fixture)",
    serial: "offline-fixture",
    mode: "single",
    quality: "exact",
    timebase: { scale: 0.0004, delay: 0 },
    sampleRate: 1000000,
    interval: 0.000001,
    stride: 1,
    recordPoints: 4096,
    trigger: { mode: "SINGLE", source: "C1", level: 0, status: "Stop" },
    channels: [
      {
        ch: 1,
        label: "校准夹具",
        file: "c1.i16",
        points: 4096,
        vdiv: 1,
        offset: 0,
        coupling: "DC",
        probe: 10,
        unit: "V",
        gain: 0.1,
        rawOffset: 0,
        codePerDiv: 7680,
      },
    ],
    screenshot: { file: "screen.png", createdAt: 1789000000001 },
  }),
)

// 子 agent:Electron 起来之前,用 faux 模型 + 真内核宿主在暂存根里种一对主 / 子会话;窗口起来之后再原子地
// 挪进 app 的会话根(理由见 e2e-seed-subagent.ts 文件头)。种不出来就别开窗口了。
const seedStaging = join(tmpRoot, "seed-sessions")
const seededSubagent = await seedSubagentSession({
  stagingRoot: seedStaging,
  workspace,
  scratch: join(tmpRoot, "seed-scratch"),
}).catch((error: unknown) => {
  console.error(`FAIL 子 agent 种子:${(error as Error).message}`)
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  process.exit(1)
})

const logTail: string[] = []
// 端口在我们探完之后才被占(另一个 Electron 刚好起来)的兜底:Chromium 会把 bind 失败
// 打在 stderr 上,抓到就立刻失败,不然要白等 60 秒才说"没出现 page 目标"。
let devtoolsBindFailed = false
function recordLog(stream: string) {
  return (chunk: Buffer) => {
    for (const raw of chunk.toString().split("\n")) {
      const line = raw.trimEnd()
      if (!line) continue
      if (/Cannot start http server for devtools|bind\(\) failed/.test(line)) devtoolsBindFailed = true
      logTail.push(`  [${stream}] ${line}`)
      if (logTail.length > 40) logTail.shift()
    }
  }
}

// TMPDIR 指到我们自己的临时根:main 的 YOMA_TEST_ONBOARDING 分支把 userData 放在
// `tmpdir()/yoma-onboarding-<uuid>`,这样它连带几十 MB 的 Chromium 存储一起被我们收走。
const child = spawn(electron, [mainEntry], {
  cwd: desktop,
  env: {
    ...process.env,
    YOMA_TEST_ONBOARDING: "1",
    YOMA_CHANNEL: "dev",
    TMPDIR: tmpRoot,
    TMP: tmpRoot,
    TEMP: tmpRoot,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
})
child.stdout?.on("data", recordLog("out"))
child.stderr?.on("data", recordLog("err"))

let childExit: string | undefined
child.on("exit", (code, signal) => {
  childExit = signal ? `信号 ${signal}` : `退出码 ${code}`
})
child.on("error", (error) => {
  childExit = error.message
})

/**
 * 强杀。Windows 上没有信号,`child.kill` 只杀 Electron 主进程,留下的 GPU / utility 子进程
 * 会把 userData 的文件句柄按着不放 —— 临时目录就 EBUSY 删不掉。整棵树交给 taskkill。
 */
function killChild(signal: "SIGTERM" | "SIGKILL") {
  if (childExit !== undefined) return
  try {
    if (process.platform === "win32") {
      if (child.pid !== undefined) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" })
      return
    }
    child.kill(signal)
  } catch (error) {
    console.warn(`  [warn] ${signal} 没送到 Electron:${(error as Error).message}`)
  }
}

/** 删临时目录。**不许抛**:删不干净是脏盘,不是闸门失败(Windows 上句柄释放有延迟)。 */
function removeTmpRoot() {
  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (error) {
    console.warn(`  [warn] 临时目录没删干净(留在盘上,不影响这次结论):${tmpRoot} -> ${(error as Error).message}`)
  }
}

let cleaned = false
/** 兜底收尾,也挂在 process exit 上。从头到尾不抛异常。 */
function cleanup() {
  if (cleaned) return
  cleaned = true
  killChild("SIGKILL")
  removeTmpRoot()
}
process.on("exit", cleanup)
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cleanup()
    process.exit(1)
  })
}

function fatal(message: string): never {
  console.error(`\nFAIL ${message}`)
  if (logTail.length) console.error(`\nElectron 最后几行输出:\n${logTail.join("\n")}`)
  cleanup()
  process.exit(1)
}

// --------------------------------------------------------------------------- 附着

const pageDeadline = Date.now() + PAGE_TIMEOUT_MS
let target: Target | undefined
while (Date.now() < pageDeadline) {
  if (childExit !== undefined) fatal(`Electron 还没开出窗口就退了(${childExit})`)
  if (devtoolsBindFailed) fatal(`Electron 没能在 127.0.0.1:${port} 上开调试端点 —— 端口被别的进程占了`)
  target = await pageTarget(port)
  if (target) break
  await sleep(500)
}
if (!target?.webSocketDebuggerUrl) {
  fatal(
    `${PAGE_TIMEOUT_MS / 1000} 秒内 127.0.0.1:${port} 上没出现 page 目标 —— ` +
      `窗口没开起来,或者这个构建没开调试端口(main 里 remote-debugging-port 只在未打包时 appendSwitch)`,
  )
}

type LogEntry = { source?: string; level?: string; text?: string; url?: string }
type Pending = { resolve: (message: CdpMessage) => void; reject: (error: Error) => void }
type CdpMessage = {
  id?: number
  method?: string
  params?: unknown
  result?: {
    data?: string
    result?: { value?: unknown; description?: string }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
  error?: { message?: string }
}

/**
 * Electron 自己往控制台打的、不是页面出的错。既可能走 console,也可能以 Log 条目到达,所以按文字滤,两条路都滤。
 *
 * 1. dev 构建里的 CSP 提醒 —— 给开发者看的提示。
 * 2. `sandboxed_renderer.bundle.js script failed to run` + `binding.startupData … is null`:Electron 的沙箱渲染器
 *    引导脚本在某个转瞬即逝的脚本上下文里(窗口刚建、还没导航到真页面的那一下)拿不到启动数据。偶发:
 *    v0.2.8 发版时 macOS runner 上撞了一次,把 desktop-mac 挡红,于是 Release 上缺了 Mac 的文件;同一步在
 *    一小时前的运行与本机多次演练里都是过的。**滤掉它不会放过真问题**:真页面的 preload 要是没注入,
 *    `window.api` 就不存在,后面「window.api.kernel.request('session.create') 回了 id」「storeSet 写入」
 *    那几项会直接挂 —— 有害的那种情形由它们兜着,而不是由这条文字匹配。
 */
const IGNORED_ERROR =
  /Electron Security Warning|Insecure Content-Security-Policy|sandboxed_renderer\.bundle\.js script failed to run|Cannot destructure property 'preloadScripts' of 'binding\.startupData'/i

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map<number, Pending>()
const exceptions: string[] = []
const consoleErrors: string[] = []
let socketClosed = false
let socketOpened = false
let failHandshake: ((error: Error) => void) | undefined
let nextId = 0

socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data)) as CdpMessage
  if (typeof message.id === "number") {
    pending.get(message.id)?.resolve(message)
    pending.delete(message.id)
    return
  }
  if (message.method === "Runtime.exceptionThrown") {
    const params = message.params as
      | { exceptionDetails?: { text?: string; exception?: { description?: string } } }
      | undefined
    const details = params?.exceptionDetails
    exceptions.push((details?.exception?.description ?? details?.text ?? "未知异常").slice(0, 300))
    return
  }
  if (message.method === "Runtime.consoleAPICalled") {
    const params = message.params as { type?: string; args?: Array<{ value?: unknown; description?: string }> }
    if (params.type !== "error") return
    const text = (params.args ?? []).map((arg) => String(arg.description ?? arg.value ?? "")).join(" ")
    if (IGNORED_ERROR.test(text)) return
    consoleErrors.push(text.slice(0, 300))
    return
  }
  // Log 域补的是 console 抓不到的那一半:附着之前就发生的错误(Log.enable 会把攒下的条目
  // 重放一遍),以及浏览器自己报的资源错 —— 比如 sprite 里少一个 symbol,href 取不到就是
  // 一条 network 级的 404,页面照样画得出来,只是那个图标是空的。
  if (message.method === "Log.entryAdded") {
    const entry = (message.params as { entry?: LogEntry } | undefined)?.entry
    if (entry?.level !== "error") return
    const text = `[${entry.source ?? "log"}] ${entry.text ?? ""}${entry.url ? ` <- ${entry.url}` : ""}`
    if (IGNORED_ERROR.test(text)) return
    consoleErrors.push(text.slice(0, 300))
  }
}
socket.onclose = () => {
  socketClosed = true
  // 还没握上手就断(窗口开出来又立刻没了)的话 onopen/onerror 都不会来,得从这里认输。
  if (!socketOpened) failHandshake?.(new Error(`DevTools 连接还没握上手就断了:${target?.webSocketDebuggerUrl}`))
  for (const [, waiter] of pending) waiter.reject(new Error("DevTools 连接断了(窗口关了?)"))
  pending.clear()
}

// 握手也要有上限:没有这个 timeout,socket 卡在 CONNECTING(端点列出来了但没人应答)时
// 这里就是无限等,整条闸门挂在 CI 的 45 分钟 job 超时上才死。
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`${CDP_TIMEOUT_MS / 1000} 秒内没连上 ${target?.webSocketDebuggerUrl}`)),
    CDP_TIMEOUT_MS,
  )
  const settle = (finish: () => void) => {
    clearTimeout(timer)
    finish()
  }
  failHandshake = (error) => settle(() => reject(error))
  socket.onopen = () =>
    settle(() => {
      socketOpened = true
      resolve()
    })
  socket.onerror = () => settle(() => reject(new Error(`连不上 ${target?.webSocketDebuggerUrl}`)))
}).catch((error: Error) => fatal(error.message))

function send(method: string, params: Record<string, unknown> = {}, timeoutMs = CDP_TIMEOUT_MS): Promise<CdpMessage> {
  if (socketClosed) return Promise.reject(new Error("DevTools 连接已经断了"))
  const id = ++nextId
  return new Promise<CdpMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} ${timeoutMs / 1000} 秒没回`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timer)
        resolve(message)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate<T>(expression: string, timeoutMs = CDP_TIMEOUT_MS): Promise<T> {
  const message = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    timeoutMs,
  )
  if (message.error) throw new Error(`CDP 拒了这次求值:${message.error.message}`)
  const details = message.result?.exceptionDetails
  if (details) throw new Error(`页面里抛了:${details.exception?.description ?? details.text ?? "未知异常"}`)
  return message.result?.result?.value as T
}

/** 轮询等一个条件为真。求值本身可能因为 reload 把上下文拆了而报错,那不算失败,等下一轮。 */
async function waitFor(expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await evaluate<unknown>(expression).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(250)
  }
}

function drain(label: string) {
  const ex = exceptions.splice(0, exceptions.length)
  const ce = consoleErrors.splice(0, consoleErrors.length)
  check(`${label}零 Runtime.exceptionThrown`, ex.length === 0, ex.slice(0, 2).join(" | "))
  check(`${label}零 console.error / Log 错误`, ce.length === 0, ce.slice(0, 2).join(" | "))
}

const json = (value: unknown) => JSON.stringify(value)

/** 按可见文字点按钮。语言可能是中文也可能是英文,所以给一串候选。 */
function clickText(labels: string[]): Promise<string | false> {
  return evaluate<string | false>(`(() => {
    const labels = ${json(labels)}
    const nodes = [...document.querySelectorAll('button, a, [role="button"]')]
    for (const label of labels) {
      const hit = nodes.find((el) => (el.textContent ?? "").trim() === label)
      if (hit) { hit.click(); return label }
    }
    return false
  })()`)
}

const HOME_MOUNTED = `!!document.querySelector('[data-component="codex-sidebar"]') && !!document.querySelector('[data-component="home-session-search"]')`
const CRASHED = `["出了点问题", "Something went wrong"].some((text) => document.body.innerText.includes(text))`

console.log(`\n首屏闸门(真窗口 + 真内核 + 点一遍;窗口会在屏幕上真弹出来几秒,别去点它)`)
console.log(`  工程目录 ${workspace}`)

try {
  await send("Runtime.enable")
  await send("Log.enable")
  await send("Page.enable")

  // ------------------------------------------------------------------ 1. 首屏
  check("首页挂载(侧栏 + 会话搜索)", await waitFor(HOME_MOUNTED, MOUNT_TIMEOUT_MS))
  await sleep(1_500) // 让晚到的 provider / 查询把它们要抛的异常抛出来
  check("首屏没崩到错误页", (await evaluate<boolean>(CRASHED)) === false)
  drain("首屏")

  // ------------------------------------------------------------------ 2. 工程名单
  const stored = json({
    projects: { local: [{ worktree: workspace, expanded: true }] },
    lastProject: { local: workspace },
  })
  const seeded = await evaluate<string>(`window.api.storeSet("yoma.global.dat", "server", ${json(stored)})
    .then(() => "ok").catch((error) => "ERR " + error.message)`)
  check("storeSet 写入 yoma.global.dat:server", seeded === "ok", seeded)

  await send("Page.reload", { ignoreCache: false })
  check("reload 后首页重新挂载", await waitFor(HOME_MOUNTED, MOUNT_TIMEOUT_MS))
  const projectName = WORKSPACE_NAME
  check(
    `侧栏列出工程 ${projectName}`,
    await waitFor(
      `!!document.querySelector('[data-component="codex-sidebar"]')?.innerText.includes(${json(projectName)})`,
      APPEAR_TIMEOUT_MS,
    ),
  )

  // ------------------------------------------------------------------ 3. 建会话
  const created = await evaluate<string>(
    `window.api.kernel.request("session.create", ${json({ directory: workspace, title: SESSION_TITLE })})
      .then((session) => session.id).catch((error) => "ERR " + error.message)`,
    30_000,
  )
  check("window.api.kernel.request('session.create') 回了 id", !!created && !created.startsWith("ERR "), created)
  const rowWithTitle = `[...document.querySelectorAll('[data-component="home-session-row"]')].some((row) => (row.textContent ?? "").includes(${json(SESSION_TITLE)}))`
  check("新建的会话出现在首页列表", await waitFor(rowWithTitle, APPEAR_TIMEOUT_MS))
  drain("首页(种名单 + 建会话后)")

  // ------------------------------------------------------------------ 4. 会话页
  const clickedRow = await evaluate<boolean>(`(() => {
    const row = [...document.querySelectorAll('[data-component="home-session-row"]')]
      .find((el) => (el.textContent ?? "").includes(${json(SESSION_TITLE)}))
    if (!row) return false
    row.click()
    return true
  })()`)
  check("点得到首页那条会话行", clickedRow)
  check(
    "会话页打开(composer + prompt 编辑器)",
    await waitFor(
      `!!document.querySelector('[data-component="session-composer"]') && !!document.querySelector('[data-component="prompt-input"]')`,
      MOUNT_TIMEOUT_MS,
    ),
  )
  const typed = await evaluate<string>(`(() => {
    const editor = document.querySelector('[data-component="prompt-input"]')
    if (!editor) return "没有编辑器"
    editor.focus()
    document.execCommand("insertText", false, ${json(TYPED_TEXT)})
    return (editor.textContent ?? "").trim()
  })()`)
  check("prompt 编辑器收得下打的字", typed === TYPED_TEXT, typed)
  // 状态条现在住在会话页最底下那条**状态栏**里(v2-console:目标板状态永远在场,不用点)。
  check(
    "会话页底部状态栏在位(session-status-bar)",
    await waitFor(`!!document.querySelector('[data-component="session-status-bar"]')`, APPEAR_TIMEOUT_MS),
  )
  check(
    "状态栏里的目标状态条在位(bench-target-strip)",
    await waitFor(
      `!!document.querySelector('[data-component="session-status-bar"] [data-component="bench-target-strip"]')`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  // 日志与 GDB 现在在**底部控制台**里,缺省收着(文本流要宽度,不占右栏)。先按状态栏上那个开关。
  const openedConsole = await evaluate<string>(`(() => {
    const toggle = document.querySelector('[data-component="session-status-bar"] button[data-slot="console-toggle"]')
    if (!toggle) return "no-toggle"
    if (toggle.getAttribute("aria-pressed") === "true") return "already"
    toggle.click()
    return "clicked"
  })()`)
  check("状态栏上开得了底部控制台", openedConsole !== "no-toggle", openedConsole)
  check(
    "日志面板(核心仪器,永远在)在底部控制台里(bench-log-panel)",
    await waitFor(
      `!!document.querySelector('[data-component="session-console"] [data-component="bench-log-panel"]')`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  check(
    // 文件名现在在状态栏的读数上(控制台的页签行说的是"采集状态 + 来源",不重复说文件),
    // 行仍在面板里 —— 断言的还是同一件事:挑中的是最新那一份,而且真把它读出来了。
    "日志面板经真 file.list/file.read 读到最新那一份(不是旧的那份)",
    await waitFor(
      `(() => {
    const panel = document.querySelector('[data-component="session-console"] [data-component="bench-log-panel"]')
    const bar = document.querySelector('[data-component="session-status-bar"]')
    if (!panel || !bar) return false
    const text = panel.innerText ?? ""
    return (bar.innerText ?? "").includes("hw-20260918-101112345.log")
      && text.includes("NACK @ 0x48") && !text.includes("不该被选中")
  })()`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  check(
    "日志行按嵌入式常见形态分了级(E/W 各有,HardFault 算 error)",
    await evaluate<boolean>(`(() => {
    const lines = [...document.querySelectorAll('[data-component="bench-log-panel"] [data-slot="line"]')]
    const level = (needle) => lines.find((line) => (line.textContent ?? "").includes(needle))?.getAttribute("data-level")
    return level("NACK @ 0x48") === "error" && level("接近满量程") === "warn"
      && level("HardFault") === "error" && level("sched: tick") === "debug"
  })()`),
  )
  // 收回去:下面那一串示波器操作要按坐标点画布,右栏高度与从前一致时最稳。
  // 顺手也把"关得掉"这一半验了 —— 开合是同一个按钮。
  await evaluate(`(() => {
    const toggle = document.querySelector('[data-component="session-status-bar"] button[data-slot="console-toggle"]')
    if (toggle && toggle.getAttribute("aria-pressed") === "true") toggle.click()
    return true
  })()`)
  check(
    "底部控制台关得掉",
    await waitFor(`!document.querySelector('[data-component="session-console"]')`, APPEAR_TIMEOUT_MS),
  )
  // 逻辑分析仪现在**按需**露出(仪器注册表:核心 ∪ 本会话用过 ∪ 磁盘上有数据 ∪ 用户钉住)。
  // 这份种出来的工程只有示波器采集,所以 LA 默认藏在"+ 仪器"里 —— 先钉住它再断言面板。
  // 钉住是落 localStorage 的,所以第二次跑时它已经在了,两种情形都得认。
  const pinnedLa = await evaluate<string>(`(() => {
    const tab = document.querySelector('[data-component="instrument-rail"] button[data-slot="tab"][data-instrument="la"]')
    if (tab) { tab.click(); return "already" }
    const button = document.querySelector('[data-component="bench-instrument-picker"] button[data-instrument="la"]')
    if (!button) return "no-button"
    button.click()
    return "clicked"
  })()`)
  check("「+ 仪器」里钉得住逻辑分析仪", pinnedLa !== "no-button", pinnedLa)
  check(
    "右栏逻辑分析仪仪器体在位(la-body)",
    await waitFor(`!!document.querySelector('[data-component="la-body"]')`, APPEAR_TIMEOUT_MS),
  )
  // 右栏一次只显示一台波形仪器(页内小页签),所以断言示波器之前先切回去。
  const pickedScope = await evaluate<string>(`(() => {
    if (document.querySelector('[data-component="scope-body"]')) return "already"
    const tab = document.querySelector('[data-component="instrument-rail"] button[data-slot="tab"][data-instrument="scope"]')
    if (!tab) return "no-tab"
    tab.click()
    return "clicked"
  })()`)
  check("右栏页签切得回示波器", pickedScope !== "no-tab", pickedScope)
  check(
    "示波器历史采集面板读取离线证据",
    await waitFor(
      `document.querySelector('[data-component="scope-body"]')?.textContent.includes('offline-fixture') === true`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  check(
    "示波器真波形 Canvas 挂载",
    await waitFor(`!!document.querySelector('[data-component="scope-waveform"] canvas')`, APPEAR_TIMEOUT_MS),
  )
  const scopeData = await evaluate<{ channels: { points: { min: number; max: number }[] }[] }>(
    `window.api.kernel.request('scope.view', ${json({ dir: scopeDir, columns: 32 })})`,
  )
  check(
    "scope.view 跨真实 contextBridge 保留窄脉冲",
    scopeData.channels[0].points.some((point) => point.max > 3),
  )
  await evaluate(`document.querySelector('[data-component="scope-waveform"]').scrollIntoView({block:'center'})`)
  check(
    "波形放大按钮可操作",
    await waitFor(
      `(() => {
    const button = document.querySelector('[data-component="scope-waveform"] button[aria-label="放大波形"]')
    return !!button && !button.disabled
  })()`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  await evaluate(`document.querySelector('[data-component="scope-waveform"] button[aria-label="放大波形"]').click()`)
  await waitFor(
    `document.querySelector('[data-component="scope-waveform"] [data-slot="plot"]')?.getAttribute('aria-busy') === 'false'`,
    APPEAR_TIMEOUT_MS,
  )
  for (const [name, fraction] of [
    ["游标 A", 0.4],
    ["游标 B", 0.6],
  ] as const) {
    await clickText([name])
    const pos = await evaluate<{ x: number; y: number }>(`(() => {
      const canvas = document.querySelector('[data-component="scope-waveform"] canvas')
      canvas.scrollIntoView({block:'center'})
      const r = canvas.getBoundingClientRect()
      return {x:r.left+r.width*${fraction}, y:r.top+50}
    })()`)
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...pos, button: "left", clickCount: 1 })
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...pos, button: "left", clickCount: 1 })
  }
  check(
    "示波器 A/B 游标显示时间差",
    await waitFor(
      `document.querySelector('[data-slot="cursor-table"]')?.textContent.includes('Δt') === true`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  await clickText(["查看仪器截图"])
  check(
    "同次采集截图经 RPC 显示",
    await waitFor(
      `(() => {const image=document.querySelector('img[alt="示波器仪器截图"]');return !!image && image.complete && image.naturalWidth>0})()`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  if (process.env.YOMA_PAINT_SCREENSHOT) {
    // 上面为了点游标把示波器滚到了屏幕中间;截图是给人看右栏整体的,先滚回顶上。
    await evaluate(
      `document.querySelector('[data-component="instrument-rail"]')?.scrollIntoView({ block: "start" })`,
    )
    const shot = await send("Page.captureScreenshot", { format: "png" })
    writeFileSync(process.env.YOMA_PAINT_SCREENSHOT, Buffer.from(shot.result!.data as string, "base64"))
  }
  check("会话页没崩到错误页", (await evaluate<boolean>(CRASHED)) === false)
  drain("会话页")

  // ------------------------------------------------------------------ 4b. 子 agent
  // 种好的主 / 子会话挪进 app 的会话根,reload 之后:侧栏只列主会话;主会话里有 agent 卡片,展开有结果与
  // 「打开子会话」;子会话页有「← 主会话」、没有输入框;点回去又是主会话。卡片与子会话页的渲染只有这里跑真窗口。
  const info = await evaluate<{ sessionsRoot?: string } | string>(
    `window.api.kernel.request("app.info").catch((error) => "ERR " + error.message)`,
  )
  const sessionsRoot = typeof info === "object" ? info.sessionsRoot : undefined
  check("app.info 回了会话根", !!sessionsRoot, typeof info === "string" ? info : String(sessionsRoot))
  if (sessionsRoot) moveSeededSessions(seedStaging, sessionsRoot)
  await send("Page.reload", { ignoreCache: false })
  // 侧栏的工程组缺省收着,点开才列会话(列的是 session.list,子 agent 的会话内核就不给)。
  const expandProject = await waitFor(
    `(() => {
    const button = [...document.querySelectorAll('[data-component="codex-sidebar"] button[aria-expanded]')]
      .find((el) => (el.textContent ?? "").includes(${json(WORKSPACE_NAME)}))
    if (!button) return false
    if (button.getAttribute("aria-expanded") !== "true") button.click()
    return true
  })()`,
    MOUNT_TIMEOUT_MS,
  )
  check("侧栏点得开工程组", expandProject)
  const parentRow = `document.querySelector('[data-component="codex-sidebar"] button[data-session-id=${json(seededSubagent.parentID)}]')`
  check("侧栏列出派子 agent 的主会话", await waitFor(`!!${parentRow}`, APPEAR_TIMEOUT_MS))

  // 侧栏行的悬浮底框。**这一条只有真指针悬上去才验得到** —— 2026-09-20 之前它用 bg-layer-01 当 hover,
  // 而浅色主题下 layer-01 与侧栏自己的底色 bg-deep 同为 grey-100(theme.css),于是鼠标划过去毫无反应,
  // 而 DOM、类名、快照全是对的。谁要是再把它改回同色的一档,这里会红。
  // 断言的是**合成之后看得见的颜色**,不是"backgroundColor 这个字符串变了没有" ——
  // 那条弱断言对 bug 版本照样是绿的(透明 -> rgb(250,250,250),值确实变了,而 250 就是侧栏自己的底色)。
  // 变异验证逮到的正是这一点。
  {
    const anyRow = `document.querySelector('[data-component="codex-sidebar"] button')`
    const probe = `(() => {
      const row = ${anyRow}
      const side = document.querySelector('[data-component="codex-sidebar"]')
      if (!row || !side) return null
      const num = (c) => (c.match(/[\\d.]+/g) ?? []).map(Number)
      const bg = num(getComputedStyle(side).backgroundColor)
      const fg = num(getComputedStyle(row).backgroundColor)
      const a = fg.length > 3 ? fg[3] : 1
      // 行的底(可能半透明)合成到侧栏的底之上 = 眼睛真正看到的那个颜色。
      const seen = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a))
      const delta = [0, 1, 2].reduce((sum, i) => sum + Math.abs(seen[i] - bg[i]), 0)
      return { delta: Math.round(delta), seen: seen.map(Math.round).join(","), bg: bg.slice(0, 3).join(",") }
    })()`
    const spot = await evaluate<{ x: number; y: number } | null>(
      `(() => { const r = ${anyRow}?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null })()`,
    )
    if (spot) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y })
    const hover = await evaluate<{ delta: number; seen: string; bg: string } | null>(probe)
    check(
      "侧栏行悬浮时真的画出底框(合成后与侧栏底色可辨)",
      !!hover && hover.delta >= 6,
      hover ? `底 ${hover.bg} -> 悬浮 ${hover.seen}(差 ${hover.delta})` : "取不到侧栏",
    )
    // 指针挪开,别把悬浮态留给后面的检查与截图。
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 })
  }
  check(
    "侧栏不列子 agent 的会话(前台、后台两个都不列)",
    await evaluate<boolean>(
      `![${json(seededSubagent.childID)}, ${json(seededSubagent.backgroundID)}].some((id) => document.querySelector('[data-component="codex-sidebar"] button[data-session-id="' + id + '"]'))`,
    ),
  )
  await evaluate(`${parentRow}?.click()`)
  // 前台那张 agent 卡片:按折叠态那一格任务描述认,之后的查询都收在这张卡里(同一页上还有后台那张与通知行)。
  // 2026-09-20 起卡片不再穿硬件卡的仪器皮(hw-trigger / hw-body),类型与描述也不再靠一个打上去的 `·` 隔开 ——
  // 类型是自己一枚名牌([data-slot="agent"]),所以这里按描述那一格认,不按拼出来的整串认。
  const agentCard = `[...document.querySelectorAll('[data-component="tool-part-wrapper"]')].find((el) => (el.querySelector('[data-component="agent-trigger"] [data-slot="task"]')?.textContent ?? "").includes(${json(SUBAGENT_DESCRIPTION)}))`
  check("主会话里画出 agent 卡片(类型名牌 + 描述)", await waitFor(`!!${agentCard}`, MOUNT_TIMEOUT_MS))
  check(
    "agent 卡片折叠态:类型名牌与完成结论都在",
    await evaluate<boolean>(
      `(${agentCard}?.querySelector('[data-component="agent-trigger"] [data-slot="agent"]')?.textContent ?? "").includes("Explore")
        && (${agentCard}?.querySelector('[data-component="agent-trigger"] [data-slot="facts"]')?.textContent ?? "").length > 0`,
    ),
  )
  await evaluate(`${agentCard}?.querySelector('[data-component="tool-trigger"]')?.click()`)
  check(
    "展开 agent 卡片:结果与「打开子会话」",
    await waitFor(
      `(${agentCard}?.querySelector('[data-component="agent-result"]')?.textContent ?? "").includes(${json(SUBAGENT_ANSWER)})
        && !!${agentCard}?.querySelector('[data-component="agent-actions"] button')`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  // 后台那个的完成通知:挂在一条 synthetic 的用户消息上,画成通知行(不是用户气泡),展开是结果全文。
  const notice = `[...document.querySelectorAll('[data-component="task-notification"]')].find((el) => (el.textContent ?? "").includes(${json(BACKGROUND_DESCRIPTION)}))`
  check(
    "后台子 agent 的完成通知画成通知行(不是用户气泡)",
    await waitFor(
      `!!${notice} && ${notice}.getAttribute("data-status") === "completed" && !!${notice}.closest('[data-component="user-message"][data-synthetic]')`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  await evaluate(`${notice}?.querySelector('[data-component="tool-trigger"]')?.click()`)
  check(
    "展开通知行:后台子 agent 的结果",
    await waitFor(
      `(${notice}?.querySelector('[data-component="agent-result"]')?.textContent ?? "").includes(${json(BACKGROUND_ANSWER)})`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  if (process.env.YOMA_PAINT_SCREENSHOT_SUBAGENT) {
    // 两张卡都展开着,滚到前台那张上 —— 这一张是给人看子 agent 卡片长相的。
    await evaluate(`${agentCard}?.scrollIntoView({ block: "center" })`)
    const shot = await send("Page.captureScreenshot", { format: "png" })
    writeFileSync(process.env.YOMA_PAINT_SCREENSHOT_SUBAGENT, Buffer.from(shot.result!.data as string, "base64"))
  }
  drain("主会话(agent 卡片 + 通知行)")
  await evaluate(`${agentCard}?.querySelector('[data-component="agent-actions"] button')?.click()`)
  check(
    "子会话页:「← 主会话」在位、没有输入框",
    await waitFor(
      `!!document.querySelector('[data-component="subagent-back"]') && !document.querySelector('[data-component="session-prompt-dock"]')`,
      MOUNT_TIMEOUT_MS,
    ),
  )
  check(
    "子会话页画出子 agent 的 transcript 与标题",
    await waitFor(
      `(document.querySelector('[data-session-title]')?.textContent ?? "").includes(${json(SUBAGENT_DESCRIPTION)})
        && document.body.innerText.includes(${json(SUBAGENT_ANSWER)})`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  check("子会话页没崩到错误页", (await evaluate<boolean>(CRASHED)) === false)
  drain("子会话页")
  await evaluate(`document.querySelector('[data-component="subagent-back"] button')?.click()`)
  check(
    "「← 主会话」回得去(输入框回来了)",
    await waitFor(
      `!!document.querySelector('[data-component="session-prompt-dock"]') && (document.querySelector('[data-session-title]')?.textContent ?? "").includes(${json(SUBAGENT_PARENT_TITLE)})`,
      MOUNT_TIMEOUT_MS,
    ),
  )
  check("主会话页没崩到错误页", (await evaluate<boolean>(CRASHED)) === false)
  drain("回到主会话")

  // ------------------------------------------------------------------ 5. 草稿页
  const clickedNew = await clickText(["新对话", "New chat"])
  check("点得到「新对话」", clickedNew !== false, String(clickedNew))
  check(
    "草稿页打开(新会话 composer + 编辑器)",
    await waitFor(
      `!!document.querySelector('[data-component="session-new-composer"]') && !!document.querySelector('[data-component="prompt-input"]')`,
      MOUNT_TIMEOUT_MS,
    ),
  )
  drain("草稿页")

  // ------------------------------------------------------------------ 6. 手册库 / 调试台
  const clickedManuals = await clickText(["手册库"])
  check("点得到「手册库」", clickedManuals !== false, String(clickedManuals))
  check(
    "手册库页渲染",
    await waitFor(
      `[...document.querySelectorAll("h1")].some((el) => (el.textContent ?? "").trim() === "手册库")`,
      MOUNT_TIMEOUT_MS,
    ),
  )
  drain("手册库页")

  const clickedBench = await clickText(["调试台", "Debug bench"])
  check("点得到「调试台」", clickedBench !== false, String(clickedBench))
  check("调试台页渲染", await waitFor(`!!document.querySelector('[data-component="bench-page"]')`, MOUNT_TIMEOUT_MS))
  drain("调试台页")
} catch (error) {
  check("首屏闸门跑完", false, (error as Error).message)
}

// --------------------------------------------------------------------------- 收尾

/** 等 Electron 自己退,最多等 ms。回 true 表示它退了。 */
async function waitForExit(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (childExit === undefined && Date.now() < deadline) await sleep(100)
  return childExit !== undefined
}

/**
 * 关窗口的顺序:先请它自己关(CDP Browser.close —— 走 before-quit 那套守护树清理、把库
 * flush 干净),再 SIGTERM,最后才 SIGKILL。强杀是下策:句柄没放开,临时目录就删不掉。
 */
async function shutdownElectron(): Promise<void> {
  if (!socketClosed) {
    // Browser.close 之后端点立刻没了,这个请求多半等不到回包 —— 不回也正常,别当错误。
    await send("Browser.close", {}, 3_000).catch(() => undefined)
    if (!socketClosed) socket.close()
  }
  if (await waitForExit(5_000)) return
  killChild("SIGTERM")
  if (await waitForExit(5_000)) return
  killChild("SIGKILL")
  await waitForExit(2_000)
}

// 先把账算清、把结论印出来,再去收摊。反过来的话,一个删不掉的临时目录或一个不肯退的
// Electron 就能把 30/30 全过变成闸门失败 —— 那是最招人恨的一种假红。
const exitCode = failed === 0 ? 0 : 1
console.log(`\n${results.length} 项检查,用了 ${elapsed()}(窗口在屏幕上的时间)`)
if (failed === 0) {
  console.log("全部通过")
} else {
  console.log(`${failed} 项失败`)
  if (logTail.length) console.log(`\nElectron 最后几行输出:\n${logTail.join("\n")}`)
}

await shutdownElectron().catch((error: unknown) => {
  console.warn(`  [warn] 关 Electron 时出了岔子:${(error as Error).message}`)
})
cleanup()
process.exit(exitCode)
