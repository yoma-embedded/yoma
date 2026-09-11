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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveElectron } from "./electron-bin.ts"

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
    result?: { value?: unknown; description?: string }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
  error?: { message?: string }
}

/**
 * dev 构建里 Electron 自己往控制台打的 CSP 提醒,是给开发者看的提示,不是页面出的错。
 * 它既可能走 console,也可能以 Log 条目到达,所以按文字滤,两条路都滤。
 */
const IGNORED_ERROR = /Electron Security Warning|Insecure Content-Security-Policy/i

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
  check(
    "右栏逻辑分析仪仪器体在位(la-body)",
    await waitFor(`!!document.querySelector('[data-component="la-body"]')`, APPEAR_TIMEOUT_MS),
  )
  check("会话页没崩到错误页", (await evaluate<boolean>(CRASHED)) === false)
  drain("会话页")

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
