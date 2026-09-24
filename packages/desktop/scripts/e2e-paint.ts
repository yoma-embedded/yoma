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
  EXPLORE_FILE,
  moveSeededSessions,
  seedSubagentSession,
  CHANGED_NEW_FILE,
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
    // `appendSwitch("remote-debugging-port", process.env.YOMA_DEBUG_PORT || "9222")`:缺省值是引号里那个数,
    // 环境变量给了就用环境变量(这条闸门的子进程继承同一份环境)。
    const hit = readFileSync(file, "utf8").match(/remote-debugging-port"[^"\n]*"(\d+)"/)
    if (hit?.[1]) return Number(process.env.YOMA_DEBUG_PORT || hit[1])
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
// YOMA_PAINT_LOCALE=en-US:本机模拟英文系统(Windows runner 的 navigator.languages 是 en-US)。
// 走 Chromium 的 --lang:CDP 的 Emulation.setLocaleOverride 只管 Intl,navigator.language 不跟着变。
const child = spawn(electron, [mainEntry, ...(process.env.YOMA_PAINT_LOCALE ? [`--lang=${process.env.YOMA_PAINT_LOCALE}`] : [])], {
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
  // 本机模拟 CI 的 Windows 岗:GitHub 的 Windows runner 屏幕是 1024×768(窗口被夹到这么小),滚动条还占宽度。
  // YOMA_PAINT_VIEWPORT=1008x690 把视口压到那个尺寸,YOMA_PAINT_CLASSIC_SCROLLBARS=1 让滚动条像 Windows 那样占地方。
  const viewport = /^(\d+)x(\d+)$/.exec(process.env.YOMA_PAINT_VIEWPORT ?? "")
  if (viewport) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: Number(viewport[1]),
      height: Number(viewport[2]),
      deviceScaleFactor: 1,
      mobile: false,
    })
  }
  if (process.env.YOMA_PAINT_LOCALE) {
    await waitFor(HOME_MOUNTED, MOUNT_TIMEOUT_MS)
    console.log(
      `  (语言模拟) navigator.language = ${await evaluate<string>("navigator.language")},界面:${await evaluate<string>(
        `document.querySelector('[data-component="codex-sidebar"]')?.innerText.includes("新对话") ? "中文" : "非中文"`,
      )}`,
    )
  }
  if (process.env.YOMA_PAINT_CLASSIC_SCROLLBARS === "1") {
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "::-webkit-scrollbar{width:17px;height:17px}::-webkit-scrollbar-thumb{background:#999}"; document.head.appendChild(s) })`,
    })
    await evaluate(`(() => { const s = document.createElement("style"); s.textContent = "::-webkit-scrollbar{width:17px;height:17px}::-webkit-scrollbar-thumb{background:#999}"; document.head.appendChild(s); return true })()`)
  }

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
  // 界面语言一并钉成中文:下面按中文的 aria-label / 按钮字找元素(「放大波形」「游标 A」…),而 app 缺省跟
  // navigator.languages 走 —— GitHub 的 Windows runner 是 en-US,示波器面板的文案 f152305 起走 i18n 之后,
  // 那边的按钮叫 "Zoom in",闸门就找不到它(v0.3.2 的 ci 撞上的)。预热读的是裸 localStorage,persist 层走
  // storeGet,两边都写(截图工装同一个做法)。
  const seeded = await evaluate<string>(`Promise.all([
      window.api.storeSet("yoma.global.dat", "server", ${json(stored)}),
      window.api.storeSet("yoma.global.dat", "language", ${json(json({ locale: "zh" }))}),
    ]).then(() => { localStorage.setItem("yoma.global.dat:language", ${json(json({ locale: "zh" }))}); return "ok" })
    .catch((error) => "ERR " + error.message)`)
  check("storeSet 写入 yoma.global.dat:server 与界面语言", seeded === "ok", seeded)

  await send("Page.reload", { ignoreCache: false })
  check("reload 后首页重新挂载", await waitFor(HOME_MOUNTED, MOUNT_TIMEOUT_MS))
  check(
    "界面是中文(下面的检查按中文文案找元素,不看 runner 的系统语言)",
    await waitFor(
      `document.querySelector('[data-component="codex-sidebar"]')?.innerText.includes("新对话") === true`,
      APPEAR_TIMEOUT_MS,
    ),
  )
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
  // 持久化的写现在先落在渲染器的内存副本里、攒 100 ms 才发给主进程(app 的 namespace-storage.ts)。落盘边界是
  // pagehide:打完字**立刻** reload(两次求值之间只隔一个 CDP 往返,远小于 100 ms),草稿得还在 —— 丢了就是
  // 那一批没赶在页面消失之前交出去。
  await evaluate(`location.reload()`)
  // reload 之后应用自己回到这个会话页(路由是记着的),不经过首页。
  check(
    "草稿还在:攒着没发的那一批在页面消失之前落盘了",
    await waitFor(
      `(document.querySelector('[data-component="prompt-input"]')?.textContent ?? "").trim() === ${json(TYPED_TEXT)}`,
      MOUNT_TIMEOUT_MS,
    ),
    await evaluate<string>(`(document.querySelector('[data-component="prompt-input"]')?.textContent ?? "<没有编辑器>").trim()`),
  )
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
  // 2026-09-23:只有日志一台文本仪器时控制台不画自己的页签行,最大化 / 关闭挂在串口那一行工具条右端;
  // 没连串口时发送行不出现。量的是"日志第一行上面压着多少壳":从前是页签行 + 连接行 + 状态行 ≈ 90px。
  const consoleChrome = await evaluate<{
    head: boolean
    close: boolean
    send: boolean
    above: number
    gap: number
    toolbar: number
    width: number
  }>(`(() => {
    const root = document.querySelector('[data-component="session-console"]')
    const lines = root?.querySelector('[data-component="bench-log-panel"] [data-slot="lines"]')
    const toolbar = root?.querySelector('[data-component="serial-controls"] [data-slot="toolbar"]')
    const box = (el) => el?.getBoundingClientRect()
    return {
      head: !!root?.querySelector('[data-slot="head"]'),
      close: !!root?.querySelector('[data-component="serial-controls"] [data-slot="toolbar"] [data-slot="actions"] button:last-child'),
      send: !!root?.querySelector('[data-slot="send-bar"]'),
      above: root && lines ? Math.round(box(lines).top - box(root).top) : -1,
      gap: toolbar && lines ? Math.round(box(lines).top - box(toolbar).bottom) : -1,
      toolbar: toolbar ? Math.round(box(toolbar).height) : -1,
      width: root ? Math.round(box(root).width) : -1,
    }
  })()`)
  check(
    "底部控制台只有日志一台时没有自己的页签行,关闭按钮在串口工具条上,没连串口时没有发送行",
    !consoleChrome.head && consoleChrome.close && !consoleChrome.send,
    JSON.stringify(consoleChrome),
  )
  // 日志和工具条之间什么都没有(没有状态行、没有空框);控制台够宽(≥ 640px)时工具条是一行。
  // 窄的时候允许折行 —— 1024 宽的窗口(macOS runner 就是)要靠"先缩后折"才保得住一行,这里钉的正是它。
  check(
    "日志紧贴在串口工具条下面,够宽时工具条只有一行",
    consoleChrome.gap >= 0 &&
      consoleChrome.gap <= 12 &&
      (consoleChrome.width < 640 || (consoleChrome.toolbar > 0 && consoleChrome.toolbar <= 40)),
    `上面共 ${consoleChrome.above}px,工具条 ${consoleChrome.toolbar}px,间隔 ${consoleChrome.gap}px,控制台宽 ${consoleChrome.width}px`,
  )
  // 收回去:下面那一串示波器操作要按坐标点画布,右栏高度与从前一致时最稳。
  // 顺手也把"关得掉"这一半验了 —— 用的是工具条上那颗关闭(页签行没了之后它是控制台里唯一的关闭)。
  await evaluate(`(() => {
    const close = document.querySelector('[data-component="session-console"] [data-slot="actions"] button:last-child')
    if (close) { close.click(); return true }
    const toggle = document.querySelector('[data-component="session-status-bar"] button[data-slot="console-toggle"]')
    if (toggle && toggle.getAttribute("aria-pressed") === "true") toggle.click()
    return true
  })()`)
  check(
    "底部控制台关得掉",
    await waitFor(`!document.querySelector('[data-component="session-console"]')`, APPEAR_TIMEOUT_MS),
  )
  // 右栏的仪器只从左侧栏的「仪器」挑(2026-09-23 起右栏不再有自己那排页签与「+ 仪器」):
  // f152305 起右栏缺省收着,点左侧栏的示波器把它打开。已经开着就不动 —— 同一个按钮再点一次是收起。
  await evaluate(`(() => {
    if (!document.querySelector('[data-component="scope-body"]'))
      document.querySelector('[data-component="workbench-nav"] button[data-instrument="scope"]')?.click()
    return true
  })()`)
  check(
    "左侧栏的仪器入口打得开右栏(instrument-rail)",
    await waitFor(`!!document.querySelector('[data-component="instrument-rail"]')`, APPEAR_TIMEOUT_MS),
  )
  check(
    "右栏不再有自己的仪器页签与「+ 仪器」",
    await evaluate<boolean>(`(() => {
      const rail = document.querySelector('[data-component="instrument-rail"]')
      return !!rail && !rail.querySelector('[data-slot="tablist"], [data-component="bench-instrument-picker"]')
    })()`),
  )
  check(
    "右栏顶上那一行写着当前仪器的名字",
    await waitFor(
      `!!document.querySelector('#review-panel button[aria-label="仪器"], #review-panel button[aria-label="Instruments"]')?.textContent?.match(/示波器|Oscilloscope/)`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  // 逻辑分析仪按需露出(这份种出来的工程只有示波器采集),左侧栏的入口总在,点它就钉住并摊开。
  const pickedLa = await evaluate<string>(`(() => {
    if (document.querySelector('[data-component="la-body"]')) return "already"
    const button = document.querySelector('[data-component="workbench-nav"] button[data-instrument="la"]')
    if (!button) return "no-button"
    button.click()
    return "clicked"
  })()`)
  check("左侧栏切得到逻辑分析仪", pickedLa !== "no-button", pickedLa)
  check(
    "右栏逻辑分析仪仪器体在位(la-body)",
    await waitFor(`!!document.querySelector('[data-component="la-body"]')`, APPEAR_TIMEOUT_MS),
  )
  // 右栏一次只显示一台波形仪器,所以断言示波器之前先切回去。
  const pickedScope = await evaluate<string>(`(() => {
    if (document.querySelector('[data-component="scope-body"]')) return "already"
    const button = document.querySelector('[data-component="workbench-nav"] button[data-instrument="scope"]')
    if (!button) return "no-button"
    button.click()
    return "clicked"
  })()`)
  check("左侧栏切得回示波器", pickedScope !== "no-button", pickedScope)
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
  // 诊断(Windows 岗上这一步在等的 15 秒里波形被卸掉了,本机复现不出来):每 250 ms 记一次右栏的样子,只记变化。
  await evaluate(`(() => {
    const trace = (window.__scopeTrace = [])
    const t0 = performance.now()
    let last = ""
    const snap = () => {
      const q = (s) => document.querySelector(s)
      const wave = q('[data-component="scope-waveform"]')
      const zoom = wave?.querySelector('button[aria-label="放大波形"]')
      const state = JSON.stringify({
        panel: !!q('#review-panel'),
        mode: [...document.querySelectorAll('#review-panel button[aria-pressed="true"]')].map((b) => b.getAttribute("aria-label")).join(","),
        rail: q('[data-component="instrument-rail"]') ? (q('[data-component="instrument-rail"] [data-slot="empty"]') ? "empty" : "body") : "none",
        scopeBody: !!q('[data-component="scope-body"]'),
        wave: !!wave,
        zoom: zoom ? (zoom.disabled ? "disabled" : "enabled") : "none",
        busy: wave?.querySelector('[data-slot="plot"]')?.getAttribute("aria-busy"),
        err: q('[data-component="scope-body"] [role="alert"]')?.textContent?.slice(0, 120),
        pick: q('[data-component="scope-body"] select')?.value?.slice(-40),
        nav: [...document.querySelectorAll('[data-component="workbench-nav"] button')].map((b) => b.dataset.instrument + (b.getAttribute("aria-pressed") === "true" ? "*" : "")).join(" "),
        canvas: wave?.querySelector("canvas")?.clientWidth,
      })
      if (state !== last) trace.push(Math.round(performance.now() - t0) + "ms " + state)
      last = state
    }
    snap()
    window.__scopeTraceTimer = setInterval(snap, 250)
    return true
  })()`)
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
  const trace = await evaluate<string[]>(`(() => { clearInterval(window.__scopeTraceTimer); return window.__scopeTrace ?? [] })()`)
  const zoomReady = await evaluate<boolean>(
    `!!document.querySelector('[data-component="scope-waveform"] button[aria-label="放大波形"]:not([disabled])')`,
  )
  if (!zoomReady) for (const line of trace) console.log(`  (波形轨迹) ${line}`)
  const zoomState = await evaluate<string>(`JSON.stringify({
    waveform: !!document.querySelector('[data-component="scope-waveform"]'),
    rail: !!document.querySelector('[data-component="instrument-rail"]'),
    railEmpty: !!document.querySelector('[data-component="instrument-rail"] [data-slot="empty"]'),
    scopeBody: !!document.querySelector('[data-component="scope-body"]'),
    panel: !!document.querySelector('#review-panel'),
    zoom: document.querySelector('[data-component="scope-waveform"] button[aria-label="放大波形"]')?.disabled,
    size: [innerWidth, innerHeight],
  })`)
  if ((JSON.parse(zoomState) as { zoom?: boolean }).zoom !== false) console.log(`  (诊断) ${zoomState}`)
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
  // 「本轮改动」:主会话那一轮里 write 新建了一个文件、edit 改了一个。数据是从工具结果的 details 合成的
  // (edit 的 patch、write 的 before),所以这两条同时也在验内核给 write 补的那一层真的接上了。
  const changesRow = `document.querySelector('[data-component="session-turn-diffs-group"]')`
  const changedFile = (file: string) =>
    `${changesRow}?.querySelector('[data-slot="accordion-item"][data-file=' + JSON.stringify(${json(file)}) + ']')`
  check(
    "主会话那一轮底下有「本轮改动」:新建的文件 +3,改过的文件 +2",
    await waitFor(
      `(() => {
        const counts = (item) => [...(item?.querySelectorAll('[data-component="diff-changes"] span') ?? [])].map((el) => el.textContent).join(" ")
        const created = ${changedFile(CHANGED_NEW_FILE)}
        const edited = ${changedFile(EXPLORE_FILE)}
        return ${changesRow}?.querySelectorAll('[data-slot="accordion-item"]').length === 2
          && counts(created) === "+3 -0" && !!created.querySelector('[data-slot="session-turn-diff-note"]')
          && counts(edited) === "+2 -0" && !edited.querySelector('[data-slot="session-turn-diff-note"]')
          && !${changesRow}.querySelector('[data-slot="session-turn-diff-view"]')
      })()`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  // 主会话那一轮跑完了:两张 agent 卡(子 agent 卡与硬件卡一样不收)原样在外面,write / edit 收进「处理详情」,
  // 回答与「本轮改动」在外面。write 卡此刻不在 DOM 里 —— 后面的查找要能把段和卡一起打开。
  const writeCard = `[...document.querySelectorAll('[data-component="tool-part-wrapper"]')].find((el) => (el.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent ?? "").includes(${json(CHANGED_NEW_FILE)}))`
  const mainFold = `document.querySelector('[data-component="process-group"]')`
  check(
    "主会话那一轮收成「处理详情」:write / edit 收在里面(2 次调用),agent 卡照旧在外面",
    await waitFor(
      `(() => {
        const header = ${mainFold}
        const count = header?.querySelector('[data-slot="process-group-count"]')?.textContent ?? ""
        return !!header && header.getAttribute("aria-expanded") === "false" && /^2/.test(count)
          && !${writeCard} && !!${agentCard}
      })()`,
      APPEAR_TIMEOUT_MS,
    ),
    await evaluate<string>(`${mainFold}?.textContent ?? "(没有这一行)"`),
  )
  await evaluate(`${changedFile(EXPLORE_FILE)}?.querySelector('[data-slot="accordion-trigger"]')?.click()`)
  check(
    "点开改过的文件:diff 画出来了(有高度),另一个文件仍收着",
    await waitFor(
      `(() => {
        const views = [...(${changesRow}?.querySelectorAll('[data-slot="session-turn-diff-view"]') ?? [])]
        return views.length === 1 && views[0].getBoundingClientRect().height > 20
          && !!${changedFile(EXPLORE_FILE)}?.contains(views[0])
      })()`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  if (process.env.YOMA_PAINT_SCREENSHOT_CHANGES) {
    await evaluate(`${changesRow}?.scrollIntoView({ block: "center" })`)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const shot = await send("Page.captureScreenshot", { format: "png" })
    writeFileSync(process.env.YOMA_PAINT_SCREENSHOT_CHANGES, Buffer.from(shot.result!.data as string, "base64"))
  }
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
  // 这一轮已经跑完:回答之前的三次只读调用收成「处理详情」一行(几次调用、几次失败折叠着就看得见),回答在外面。
  // 点开它,下面才是那一行「已探索」。文字跟语言走,这里只认数字与结构。
  const childFold = `document.querySelector('[data-component="process-group"]')`
  check(
    "子会话页:跑完的那一轮收成「处理详情」一行(3 次调用、1 次失败),点开之前看不见「已探索」",
    await waitFor(
      `(() => {
        const header = ${childFold}
        if (!header) return false
        const count = header.querySelector('[data-slot="process-group-count"]')?.textContent ?? ""
        const failed = header.querySelector('[data-slot="process-group-failed"]')?.textContent ?? ""
        return header.getAttribute("aria-expanded") === "false" && /^3/.test(count) && /^1/.test(failed)
          && !document.querySelector('[data-component="context-tool-group"]')
      })()`,
      APPEAR_TIMEOUT_MS,
    ),
    await evaluate<string>(`${childFold}?.textContent ?? "(没有这一行)"`),
  )
  await evaluate(`${childFold}?.click()`)
  // 子 agent 回答之前连着做了三次只读调用(ls + 两次 read,其中一次读不到):时间线上并成一行,折叠着就说得出
  // 「几次读取、几个列表、几次失败」,点开才是逐张卡片。文字跟语言走,这里只认数字与结构。
  const contextGroup = `document.querySelector('[data-component="context-tool-group"]')`
  check(
    "连着的只读调用并成一行,失败的折叠着也看得见",
    await waitFor(
      `(() => {
        const group = ${contextGroup}
        if (!group) return false
        const subtitle = group.querySelector('[data-slot="basic-tool-tool-subtitle"]')?.textContent ?? ""
        const failed = group.querySelector('[data-slot="basic-tool-tool-arg"]')?.textContent ?? ""
        return group.dataset.timelinePartIds?.split(",").length === 3
          && group.dataset.failed === "true"
          && /^2 .+ · 1 /.test(subtitle)
          && /^1 /.test(failed)
          && !group.querySelector('[data-slot="context-tool-group-list"]')
          && document.querySelectorAll('[data-component="tool-part-wrapper"]').length === 0
      })()`,
      APPEAR_TIMEOUT_MS,
    ),
    await evaluate<string>(`${contextGroup}?.textContent ?? "(没有这一行)"`),
  )
  await evaluate(`${contextGroup}?.querySelector('[data-component="tool-trigger"]')?.click()`)
  check(
    "点开是逐张卡片(三张,读不到的那张是错误卡)",
    await waitFor(
      `(() => {
        const list = ${contextGroup}?.querySelector('[data-slot="context-tool-group-list"]')
        return list?.querySelectorAll('[data-component="tool-part-wrapper"]').length === 3
          && (list?.textContent ?? "").includes(${json(EXPLORE_FILE)})
      })()`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  if (process.env.YOMA_PAINT_SCREENSHOT_CONTEXT) {
    await evaluate(`${contextGroup}?.scrollIntoView({ block: "center" })`)
    await sleep(300)
    const shot = await send("Page.captureScreenshot", { format: "png" })
    writeFileSync(process.env.YOMA_PAINT_SCREENSHOT_CONTEXT, Buffer.from(shot.result!.data as string, "base64"))
  }
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

  // 会话内查找(cmd+F)。快捷键走 CDP 的真按键(不是往 DOM 上派事件)—— 同时也在验 Electron 的菜单没把它吞掉。
  // 时间线是虚拟列表,计数来自数据层、高亮来自眼前的 DOM,两样都要看;命中在收着的卡片里时卡片得自己打开。
  const MOD = process.platform === "darwin" ? 4 : 2
  const pressKey = async (key: string, code: string, vk: number, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, key, code, modifiers, windowsVirtualKeyCode: vk })
    }
  }
  const searchInput = `document.querySelector('[data-component="timeline-search"] [data-slot="timeline-search-input"]')`
  const searchCount = `(document.querySelector('[data-slot="timeline-search-count"]')?.textContent ?? "")`
  const typeQuery = (value: string) =>
    evaluate(`(() => { const input = ${searchInput}; input.focus(); input.select(); document.execCommand("insertText", false, ${json(value)}) })()`)
  const painted = (name: string) =>
    `[...(CSS.highlights.get(${json(name)}) ?? [])].map((range) => range.toString().toLowerCase())`
  // 同一页上有两个「查找」:右栏开着文件页签时 cmd+F 原本归文件内查找(file-tabs.tsx 在 window 捕获阶段接),
  // 焦点在对话这一栏里才归会话内查找。这里把焦点放到时间线上再按 —— 这条闸门头一次跑就是栽在这个归属上。
  await evaluate(`document.querySelector('[data-find-scope="session"] .scroll-view__viewport')?.focus()`)
  await pressKey("f", "KeyF", 70, MOD)
  check(
    "cmd+F 打开会话内查找,焦点在输入框里",
    await waitFor(`!!${searchInput} && document.activeElement === ${searchInput}`, APPEAR_TIMEOUT_MS),
  )
  // write 卡片收在「处理详情」里(DOM 里还没有它)。先记下这一点:后面的查找会跳进它里面,那时段和卡都得自己打开。
  check(
    "查找之前 write 卡片收在收着的「处理详情」里",
    await evaluate<boolean>(`!${writeCard} && ${mainFold}?.getAttribute("aria-expanded") === "false"`),
  )
  await typeQuery("STM32F405RGTX")
  check(
    "查找:计数来自整个会话(子 agent 的结果 + write 的内容 + 回复,共 3 处),眼前的命中上了色",
    await waitFor(
      `/^[1-3]\\/3$/.test(${searchCount}) && ${painted("timeline-search-hit-active")}.length === 1
        && [...${painted("timeline-search-hit")}, ...${painted("timeline-search-hit-active")}].every((text) => text === "stm32f405rgtx")`,
      APPEAR_TIMEOUT_MS,
    ),
    await evaluate<string>(searchCount),
  )
  const before = await evaluate<string>(searchCount)
  await pressKey("Enter", "Enter", 13)
  check(
    "回车跳到下一处",
    await waitFor(`${searchCount} !== ${json(before)} && /^[1-3]\\/3$/.test(${searchCount})`, APPEAR_TIMEOUT_MS),
    `${before} → ${await evaluate<string>(searchCount)}`,
  )
  // 只在 write 卡片的输出里出现的词:跳过去时「处理详情」与卡片都得开着,字才画得出来、才圈得上。
  await typeQuery("successfully wrote")
  check(
    "命中在收着的「处理详情」里的卡片上:段和卡自己打开,当前那一处圈在它的输出上",
    await waitFor(
      `${searchCount} === "1/1" && !!${writeCard}?.querySelector('[data-component="tool-output"]')
        && ${painted("timeline-search-hit-active")}[0] === "successfully wrote"`,
      APPEAR_TIMEOUT_MS,
    ),
    await evaluate<string>(searchCount),
  )
  if (process.env.YOMA_PAINT_SCREENSHOT_SEARCH) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    const shot = await send("Page.captureScreenshot", { format: "png" })
    writeFileSync(process.env.YOMA_PAINT_SCREENSHOT_SEARCH, Buffer.from(shot.result!.data as string, "base64"))
  }
  // 后台任务的通知行也是收着的,结果全文在里面:跳到那儿的命中时它得自己打开(展开状态现在和工具卡一样记在时间线上)。
  await evaluate(`(() => { const n = ${notice}; if (n?.querySelector('[data-component="agent-result"]')) n.querySelector('[data-component="tool-trigger"]')?.click() })()`)
  check("查找之前通知行是收着的", await waitFor(`!!${notice} && !${notice}.querySelector('[data-component="agent-result"]')`, APPEAR_TIMEOUT_MS))
  await typeQuery("RM0090")
  const inNotice = `(() => {
    const range = [...(CSS.highlights.get("timeline-search-hit-active") ?? [])][0]
    return !!range && !!${notice}?.querySelector('[data-component="agent-result"]')?.contains(range.startContainer)
  })()`
  await waitFor(`/^\\d+\\/\\d+$/.test(${searchCount})`, APPEAR_TIMEOUT_MS)
  for (let i = 0; i < 3 && !(await evaluate<boolean>(inNotice)); i++) {
    await pressKey("Enter", "Enter", 13)
    await waitFor(inNotice, 1_500)
  }
  check("命中在收着的通知行里:通知行自己打开,当前那一处圈在结果全文上", await evaluate<boolean>(inNotice), await evaluate<string>(searchCount))
  // 计数和高亮是同一个口径:界面上有、数据层没有的字(「处理详情」那一行的标签)搜不到,也不上色 ——
  // 头一版 DOM 层自己圈,会出现计数写着"无结果"、屏幕上却一片高亮。
  await typeQuery("处理详情")
  check(
    "只在界面标签里出现的词:计数说没有,屏幕上也不圈",
    await waitFor(
      `${searchCount}.length > 0 && !/\\d/.test(${searchCount}) && ${painted("timeline-search-hit")}.length === 0 && ${painted("timeline-search-hit-active")}.length === 0`,
      APPEAR_TIMEOUT_MS,
    ),
    await evaluate<string>(searchCount),
  )
  await pressKey("Escape", "Escape", 27)
  check(
    "Esc 关掉查找,高亮清干净",
    await waitFor(
      `!document.querySelector('[data-component="timeline-search"]') && !CSS.highlights.has("timeline-search-hit") && !CSS.highlights.has("timeline-search-hit-active")`,
      APPEAR_TIMEOUT_MS,
    ),
  )
  drain("会话内查找")

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
