import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { app, BrowserWindow, ipcMain, Notification } from "electron"

import { Effect } from "effect"
import contextMenu from "electron-context-menu"

// 深引用叶子模块 —— 走 `@yoma-desktop/bench` 主入口会把整个内核 inline 进
// out/main/index.js(bench 在 devDependencies 里,externalizeDeps 不碰它)。
import { defaultConfigDir } from "@yoma-desktop/bench/mailbox/paths"

import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendMenuCommand } from "./ipc"
import { spawnKernel, type KernelProcess } from "./kernel"
import { createMailboxMain, type MailboxMain } from "./mailbox"
import type { MailboxSettings } from "./mailbox-controller"
import { getStore } from "./store"
import { currentLogDir, exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { flushRendererStorage } from "./renderer-storage"
import { createMenu } from "./menu"
import { preferAppEnv } from "./app-env"
import { disableInstallOnQuit, setupAutoUpdater, showUpdaterDialog, updaterAutoCheckPrefs } from "./updater"
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
const TEST_ONBOARDING = process.env.YOMA_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let kernelProcess: KernelProcess | null = null
/** 调试台托管。声明提到这里,是为了让 stopSidecars(定义在它被创建之前)能带走守护树。 */
let mailboxMain: MailboxMain | null = null

/**
 * engines/bin + engines/data 的位置。
 *
 * 必须显式传给工具工厂,**不能** 依赖 yoma 的 enginesDir() 向上查找:那个查找只认
 * "名字叫 engines 且存在"的目录,会高高兴兴地找到一个没有 bin/ 的空壳,然后报
 * "去跑 npm run engines:build",让人以为是没编译。
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

/**
 * photon(读图缩放的 wasm 库)所在目录。打包后它走 extraResources 落在 `resources/photon`;
 * 开发期不设,由内核按 node_modules 解析(kernel 的 host/domain/image/photon.ts)。
 *
 * 设在 `process.env` 上而不是当参数传:内核 utilityProcess 与信箱守护都是 `{...process.env}` 起的,
 * 一处设置两条路都看得见 —— 信箱那条是**纯 node**(ELECTRON_RUN_AS_NODE),没有 process.resourcesPath 可查。
 */
function ensurePhotonDirEnv(): void {
  if (process.env.YOMA_PHOTON_DIR) return
  if (app.isPackaged) process.env.YOMA_PHOTON_DIR = join(process.resourcesPath, "photon")
}

function resolveEnginesDir(): string | undefined {
  if (process.env.YOMA_ENGINES_DIR) return process.env.YOMA_ENGINES_DIR
  // 打包后走 extraResources;开发期走仓库根的 engines 软链(指向 ../yoma/engines)。
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

  process.env.YOMA_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "com.yoma.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `yoma-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.YOMA_DB = ":memory:"
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
    // 下好的更新不在这次 exit 上装(见 disableInstallOnQuit):NSIS 换文件与 relaunch 拉起
    // 旧 exe 会撞在一起;留到下一次正常退出。
    disableInstallOnQuit()
    // app.exit 不触发 pagehide,渲染器攒着的持久化改动要在这里显式要回来(和停守护 / 内核并行,不多等)。
    const windows = BrowserWindow.getAllWindows().map((win) => ({
      alive: () => !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed(),
      send: (channel: "storage-flush") => win.webContents.send(channel),
      owns: (sender: unknown) => sender === win.webContents,
    }))
    void Promise.allSettled([stopSidecars(), flushRendererStorage(windows, ipcMain)]).finally(() => {
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
  ensurePhotonDirEnv()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  // 开发构建开调试端口给 e2e 与截图工装用。YOMA_DEBUG_PORT 可以换:工装要和开着的 dev:desktop 同时跑时,两边都占 9222 就互相卡住。
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", process.env.YOMA_DEBUG_PORT || "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))

  app.on("second-instance", () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // 退出必须先把守护树与内核带走,**等它们真的死了**再退:electron-updater 的"退出时安装"
  // 挂在 quit 事件上,fire-and-forget 的 stopSidecars 要几秒(信箱守护 5 s 宽限 + 内核 3 s),
  // 而 quit 紧跟 will-quit 就来 —— 不拦一下,NSIS 会在烧录 / gdb 的孙进程还活着时开始换文件。
  // 第一次 before-quit 拦下来、停完再 app.quit();第二次放行。stopSidecars 自身有界(≤ 8 s)。
  let quitting = false
  app.on("before-quit", (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    void stopSidecars().finally(() => app.quit())
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

  yield* Effect.promise(() => app.whenReady())
  const readyAt = process.uptime()

  // tauri→electron 的 .dat 迁移已随运行时身份换成 Yoma 一起摘除:Yoma 从未发过 tauri 版,
  // 那套迁移只会把 opencode 时代的陈年草稿灌进全新的 userData(实测旧目录里真有 .dat)。
  registerRendererProtocol()
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
        const value = getStore("yoma.mailbox").get("settings") as MailboxSettings | undefined
        return value && typeof value.remote === "string" && (value.role === "runner" || value.role === "mother")
          ? value
          : undefined
      },
      set: (settings) => getStore("yoma.mailbox").set("settings", settings),
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
    attachKernel: (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) kernelProcess?.attach(win)
    },
    relaunch,
    updater,
    updaterAutoCheck: updaterAutoCheckPrefs(),
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
  // 定时检查看"自动检查"开关;设置页的"立即检查"走 check(),不看开关。
  const updateTimer = setInterval(() => void updater.checkPeriodic(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  // yoma 内核进程。整个 app 只 fork 这一个 —— yoma 的 probe 租约、gdb session 表、
  // log capture 都是模块级全局,分片 fork 会让两个进程各自以为自己独占探针。
  kernelProcess = spawnKernel({
    sessionsRoot: join(app.getPath("userData"), "sessions"),
    stateDir: app.getPath("userData"),
    enginesDir: resolveEnginesDir(),
    // 内核的调试轨迹 trace.jsonl 跟本次启动的日志放在一起(docs/调试留痕-规划-20260924.md §3.1)
    logDir: currentLogDir(),
    onStdout: (message) => writeLog("kernel", "stdout", { message }),
    onStderr: (message) => writeLog("kernel", "stderr", { message }, "warn"),
    onExit: (code) => writeLog("kernel", "kernel exited", { code }, "warn"),
    onUnresponsive: (silentMs) => writeLog("kernel", "kernel unresponsive", { silentMs }, "warn"),
    onResponsive: (stalledMs) => writeLog("kernel", "kernel responsive again", { stalledMs }, "warn"),
  })
  kernelProcess.ready.catch((error: unknown) => {
    // 内核起不来不该让窗口开不出来 —— 前端还得能显示错误并引导去配置模型凭据。
    logger.error("kernel failed to start", String(error))
  })

  mainWindow = createMainWindow()
  const windowAt = process.uptime()
  if (mainWindow) {
    // 启动耗时(自进程起来的毫秒数):Electron 就绪 → 窗口建好 → 首帧画完、窗口亮出来。
    // 动启动顺序之前先看这一行,改完再看一遍。
    mainWindow.once("ready-to-show", () => {
      writeLog("main", "startup", {
        readyMs: Math.round(readyAt * 1000),
        windowMs: Math.round(windowAt * 1000),
        shownMs: Math.round(process.uptime() * 1000),
      })
      // Dock 图标等窗口亮出来再设:它要同步解一张 1024×1024 的 PNG,实测约 55 ms —— 就绪到窗口建好一共才
      // 120 ms,别的(协议、更新器、信箱、IPC、netlog、起内核)加起来不到 10 ms。只挪到建窗口之后还不够:
      // 那时 main 正忙着给渲染器喂首批资源,解码照样挡路(实测就绪 → 亮出来 266 ms,那样只回来约 25 ms,挪到这里约 45 ms)。
      // 打包后的 Dock 图标本来就来自 bundle,这里晚一步没人看得见;开发态会先闪一下 Electron 的缺省图标。
      setDockIcon()
    })
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
