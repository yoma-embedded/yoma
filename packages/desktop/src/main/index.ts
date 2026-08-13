import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow, Notification } from "electron"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

// 深引用叶子模块 —— 走 `@yoma-desktop/bench` 主入口会把整个内核 inline 进
// out/main/index.js(bench 在 devDependencies 里,externalizeDeps 不碰它)。
import { defaultConfigDir } from "@yoma-desktop/bench/mailbox/paths"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { spawnKernel, type KernelProcess } from "./kernel"
import { createMailboxMain, type MailboxMain } from "./mailbox"
import type { MailboxSettings } from "./mailbox-controller"
import { getStore } from "./store"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import {
  createMainWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { registerManualsIpcHandlers } from "./manuals"

// 2026-08 起运行时身份就是 Yoma(名字进钥匙串条目、appId 定 userData 目录)。
// 旧的 ai.opencode.desktop* 目录弃在原地不迁移 —— 当时明确决定旧数据不要了,
// 这也顺手解决了"打包版访问 dev 版创建的 OpenCode Safe Storage 要输密码"的弹窗。
const APP_NAMES: Record<string, string> = {
  dev: "Yoma Dev",
  beta: "Yoma Beta",
  prod: "Yoma",
}
const APP_IDS: Record<string, string> = {
  dev: "com.yoma.desktop.dev",
  beta: "com.yoma.desktop.beta",
  prod: "com.yoma.desktop",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let kernelProcess: KernelProcess | null = null
/** 调试台托管。声明提到这里,是为了让 stopSidecars(定义在它被创建之前)能带走守护树。 */
let mailboxMain: MailboxMain | null = null

const pendingDeepLinks: string[] = []

/**
 * engines/bin + engines/data 的位置。
 *
 * 必须显式传给工具工厂,**不能** 依赖 my-pi 的 enginesDir() 向上查找:那个查找只认
 * "名字叫 engines 且存在"的目录,会高高兴兴地找到一个没有 bin/ 的空壳,然后报
 * "去跑 bun engines/build.ts",让人以为是没编译。
 */
/**
 * 把窗口接到内核上。
 *
 * 必须挂在 did-finish-load 上而不是只调一次:每次 reload(开发期 HMR、崩溃恢复)
 * renderer 的 MessagePort 都会失效,不重新牵线就是一个哑掉的通道 —— 而且不报错,
 * 表现为"点什么都没反应"。
 */
function attachKernelToWindow(win: BrowserWindow): void {
  const attach = () => kernelProcess?.attach(win)
  win.webContents.on("did-finish-load", attach)
  if (!win.webContents.isLoading()) attach()
}

function resolveEnginesDir(): string | undefined {
  if (process.env.YOMA_ENGINES_DIR) return process.env.YOMA_ENGINES_DIR
  // 打包后走 extraResources;开发期走仓库根的 engines 软链(指向 ../my-pi/engines)。
  if (app.isPackaged) return join(process.resourcesPath, "engines")
  return join(app.getAppPath(), "..", "..", "engines")
}

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

/** 保留只为兼容 renderer 还在调的 IPC 通道;HTTP sidecar 已经不存在了。 */
async function killSidecar() {}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "com.yoma.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "Yoma Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  logger = initLogging()
  initCrashReporter()

  const stopSidecars = async () => {
    const kernel = kernelProcess
    kernelProcess = null
    // 调试台守护先停:任务在飞时退出 app,守护与 turn 孙进程会变成无人监督地
    // 继续烧录/gdb 的孤儿(自动更新的 relaunch 走同一条路)。内核可以慢慢来,
    // 板子不行。
    await mailboxMain?.stopAll().catch(() => {})
    await kernel?.stop()
  }
  const relaunch = () => {
    void stopSidecars().finally(() => {
      app.relaunch()
      app.exit(0)
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("yoma://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    void stopSidecars()
  })

  app.on("will-quit", () => {
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: webContents.getURL(), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stopSidecars().finally(() => app.exit(0))
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())

  // tauri→electron 的 .dat 迁移已随运行时身份换成 Yoma 一起摘除:Yoma 从未发过 tauri 版,
  // 那套迁移只会把 opencode 时代的陈年草稿灌进全新的 userData(实测旧目录里真有 .dat)。
  // 深链协议与 electron-builder 配置里声明的 protocols(yoma://)一致。
  app.setAsDefaultProtocolClient("yoma")
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars)
  // 信箱调试台:main 托管守护进程,renderer 走 window.api.mailbox。
  mailboxMain = createMailboxMain({
    // 信箱克隆跟着**全局配置目录**走(凭据/技能/上下文同一处),不跟 userData ——
    // 命令行那侧也落在这里,同一个物理目录才让单实例锁真的是锁。
    configDir: defaultConfigDir(),
    // 会话仍在 userData:它是给桌面端回放看的,不是跨进程共享的 agent 状态。
    sessionsRoot: join(app.getPath("userData"), "sessions"),
    enginesDir: resolveEnginesDir(),
    // 打包后本文件在 asar 里,而守护 .mjs 被 asarUnpack 解出(electron-builder 配置)。
    bundleDir: dirname(fileURLToPath(import.meta.url)).replace("app.asar", "app.asar.unpacked"),
    broadcast: (event) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("mailbox-event", event)
    },
    persistence: {
      get: () => {
        const value = getStore("opencode.mailbox").get("settings") as MailboxSettings | undefined
        return value && typeof value.remote === "string" && (value.role === "runner" || value.role === "mother")
          ? value
          : undefined
      },
      set: (settings) => getStore("opencode.mailbox").set("settings", settings),
    },
    // 挂起等人时喊一声。**不看窗口有没有聚焦** —— 要动手的人多半在板子那边,
    // 而这条通知就是把"闭环停在这儿了"送出去的唯一手段。
    notify: ({ title, body }) => {
      if (Notification.isSupported()) new Notification({ title, body }).show()
    },
    log: (line) => writeLog("mailbox", "daemon", { line }),
  })
  const mailbox = mailboxMain
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    attachKernel: (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) kernelProcess?.attach(win)
    },
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    mailbox: {
      configure: (settings) => mailbox.controller.configure(settings),
      start: (task) => mailbox.controller.start(task),
      stop: () => mailbox.controller.stop(),
      status: () => mailbox.controller.status(),
      probe: (remote) => mailbox.probe(remote),
      ackHuman: (input) => mailbox.ackHuman(input),
      composeJob: (input) => mailbox.composeJob(input),
    },
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
  })
  registerManualsIpcHandlers()
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.OPENCODE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  // HTTP sidecar 整条路径已经拆除:renderer 现在通过 MessagePort 直连内核
  // utilityProcess(见 main/kernel.ts),不再需要端口、密码、CORS 和健康探测。
  //
  // serverReady 这个 Deferred 还留着,是因为 renderer 的 awaitInitialization() 仍在
  // 等它才渲染 —— 给一个占位值让启动继续。ServerConnection 这一整套概念的清除
  // 是后续独立工作(它散在 app 的路由与标签页里)。
  yield* Deferred.succeed(serverReady, {
    url: "kernel://local",
    username: null,
    password: null,
  })

  // my-pi 内核进程。整个 app 只 fork 这一个 —— my-pi 的 probe 租约、gdb session 表、
  // log capture 都是模块级全局,分片 fork 会让两个进程各自以为自己独占探针。
  kernelProcess = spawnKernel({
    sessionsRoot: join(app.getPath("userData"), "sessions"),
    stateDir: app.getPath("userData"),
    enginesDir: resolveEnginesDir(),
    onStdout: (message) => writeLog("kernel", "stdout", { message }),
    onStderr: (message) => writeLog("kernel", "stderr", { message }, "warn"),
    onExit: (code) => writeLog("kernel", "kernel exited", { code }, "warn"),
  })
  kernelProcess.ready.catch((error: unknown) => {
    // 内核起不来不该让窗口开不出来 —— 前端还得能显示错误并引导去配置模型凭据。
    logger.error("kernel failed to start", String(error))
  })

  mainWindow = createMainWindow()
  if (mainWindow) {
    attachKernelToWindow(mainWindow)
    createMenu({
      trigger: (id) => {
        const win = BrowserWindow.getFocusedWindow() ?? mainWindow
        if (win) sendMenuCommand(win, id)
      },
      checkForUpdates: () => {
        void showUpdaterDialog(updater, true)
      },
      relaunch: () => {
        relaunch()
      },
    })
  }
})

Effect.runFork(main)
