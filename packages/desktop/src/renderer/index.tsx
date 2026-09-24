// @refresh reload

import {
  INLINE_ATTACHMENT_EXTENSIONS,
  createNamespaceStorage,
  type NamespaceStorage,
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  useCommand,
} from "@yoma-desktop/app"
import type { UpdaterState } from "@yoma-desktop/app/updater"
import { createMemoryHistory, MemoryRouter, type BaseRouterProps } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import { resetZoom, setPinchZoomEnabled, webviewZoom, zoomIn, zoomOut } from "./webview-zoom"
import "./styles.css"
import { Logo } from "@yoma-desktop/ui/logo"
import { useTheme } from "@yoma-desktop/ui/theme/context"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

void initI18n()

const [updaterState, setUpdaterState] = createSignal<UpdaterState>({ status: "disabled" })
void window.api.updater.subscribe(setUpdaterState)

const lastActiveUrlKey = "yoma.desktop.last-active-url"

function getLastActiveUrl() {
  if (typeof localStorage !== "object") return "/"
  try {
    const value = localStorage.getItem(lastActiveUrlKey)
    if (value?.startsWith("/") && !value.startsWith("//")) return value
  } catch {}
  return "/"
}

function setLastActiveUrl(value: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.setItem(lastActiveUrlKey, value)
  } catch {}
}

function DesktopMemoryRouter(props: BaseRouterProps) {
  const history = createMemoryHistory()
  const initialUrl = getLastActiveUrl()
  if (initialUrl !== "/") history.set({ value: initialUrl, replace: true, scroll: false })
  onCleanup(history.listen(setLastActiveUrl))
  return <MemoryRouter {...props} history={history} />
}

const createPlatform = (): Platform => {
  const attachmentPaths = new WeakMap<File, string>()
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const runDesktopMenuAction: Platform["runDesktopMenuAction"] = (action) => {
    switch (action) {
      case "view.resetZoom":
        resetZoom()
        return
      case "view.zoomIn":
        zoomIn()
        return
      case "view.zoomOut":
        zoomOut()
        return
    }

    return window.api.runDesktopMenuAction(action)
  }

  // 每个名字空间在渲染器里留一份内存副本:只读一次,写攒成批(app 的 namespace-storage.ts)。
  const storage = (() => {
    const namespaces = new Map<string, NamespaceStorage>()
    const driver = { items: window.api.storeItems, update: window.api.storeUpdate, clear: window.api.storeClear }
    const flushAll = () => Promise.all([...namespaces.values()].map((namespace) => namespace.flush()))
    // 攒着的改动的落盘边界:窗口退到后台,以及页面要走(关窗、退出、reload)。flush 是同步把这一批交给 IPC 的,
    // 页面消失之前消息已经发出去了,主进程照常处理。
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void flushAll()
    })
    window.addEventListener("pagehide", () => void flushAll())
    // relaunch 是 app.exit(0),页面收不到 pagehide:主进程走之前会来要一次(main/renderer-storage.ts)。
    window.api.onStorageFlush(flushAll)

    return (name = "default.dat") => {
      const cached = namespaces.get(name)
      if (cached) return cached
      const next = createNamespaceStorage(driver, name)
      namespaces.set(name, next)
      return next
    }
  })()

  return {
    platform: "desktop",
    os,
    version: pkg.version,

    async openDirectoryPickerDialog(opts) {
      return window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
      })
    },

    async openAttachmentPickerDialog(opts, onFile) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        defaultPath: opts?.defaultPath,
        // 不设类型过滤:有真实路径的文件一律能交给 agent(固件产物 .elf / .bin / .hex 也是)。
        extensions: opts?.extensions,
        inlineExtensions: INLINE_ATTACHMENT_EXTENSIONS,
      })
      if (!result) return
      try {
        for (const file of result.files) {
          // 只有图片的字节要进渲染器;其余只是一个带名字和路径的空壳,attachments 会把它转成 @path。
          const bytes = file.inline ? [await window.api.readPickedFile(result.token, file.path)] : []
          const selected = new File(bytes, file.name)
          attachmentPaths.set(selected, file.path)
          await onFile(selected)
        }
      } finally {
        await window.api.releasePickedFiles(result.token)
      }
    },

    getPathForFile(file) {
      return attachmentPaths.get(file) ?? window.api.getPathForFile(file)
    },

    async createDirectory(parent, name) {
      return window.api.createDirectory(parent, name)
    },

    async writeTextFile(input) {
      return window.api.writeTextFile(input)
    },

    openLink(url: string) {
      window.api.openLink(url)
    },
    async openPath(path: string) {
      return window.api.openPath(path)
    },

    back() {
      window.history.back()
    },

    forward() {
      window.history.forward()
    },

    storage,

    updater: {
      state: updaterState,
      check: () => window.api.updater.check(),
      install: () => window.api.updater.install(),
      autoCheck: {
        get: () => window.api.updater.getAutoCheck(),
        set: (value) => window.api.updater.setAutoCheck(value),
      },
    },

    exportDebugLogs: () => window.api.exportDebugLogs(),

    recordFatalRendererError: (error) => window.api.recordFatalRendererError(error),

    restart: async () => {
      window.api.relaunch()
    },

    notify: async (title, description, href) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return

      const notification = new Notification(title, {
        body: description ?? "",
      })
      notification.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        handleNotificationClick(href)
        notification.close()
      }
    },

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    manuals: window.api.manuals,

    // preload 的 wire 类型刻意松(零依赖纪律),真形状由 kernel 的 mailbox-view 定义;
    // 两边的一致性由 bench 的 view-check 闸门 + e2e 钉住,这里只是收窄。
    mailbox: window.api.mailbox as unknown as Platform["mailbox"],

    webviewZoom,

    getPinchZoomEnabled: () => window.api.getPinchZoomEnabled(),

    setPinchZoomEnabled,

    runDesktopMenuAction,

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})

render(() => {
  const platform = createPlatform()
  const loadLocale = async () => {
    const current = await platform.storage?.("yoma.global.dat").getItem("language")
    const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
    const raw = current ?? legacy
    if (!raw) return
    const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
    if (!locale) return
    const next = normalizeLocale(locale)
    if (next !== "en") await loadLocaleDict(next)
    return next satisfies Locale
  }

  const [locale] = createResource(loadLocale)

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
  }

  function Inner() {
    const cmd = useCommand()
    menuTrigger = (id) => cmd.trigger(id)

    const theme = useTheme()

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) {
        void window.api.setBackgroundColor(bg)
      }
    })

    return null
  }

  function App() {
    const splash = (
      <div
        data-component="startup-splash"
        aria-label="Yoma"
        class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base"
      >
        <Logo class="w-64 h-12 opacity-50 animate-pulse" />
      </div>
    )

    // 启动只等一件事:语言字典。原来还要等 sidecar 的 awaitInitialization()(HTTP 服务端的
    // 端口/密码)和 electron-store 里的"默认服务器" —— 两者都随多服务器概念一起删了,
    // 内核的 MessagePort 由 preload 在窗口创建时牵好,renderer 不必等它。
    const ready = createMemo(() => !locale.loading)

    return (
      <Show when={ready()} fallback={splash}>
        <AppInterface router={DesktopMemoryRouter}>
          <Inner />
        </AppInterface>
      </Show>
    )
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest}>
        <App />
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
