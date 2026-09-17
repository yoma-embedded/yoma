import { createEffect, createSignal, Show, Suspense, type ParentProps } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, showToast, ToastRegion } from "@/utils/toast"
import { CodexSidebar } from "./layout/codex-sidebar"
import { PreflightBanner } from "@/components/preflight-banner"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const language = useLanguage()
  const navigate = useNavigate()
  setNavigate(navigate)

  createEffect(() => setV2Toast(true))

  // 更新下好了要喊一声:标题栏那颗悬停才展开的小药丸没人会发现。每个版本只喊一次
  // (记在 localStorage —— main 那边的 ready 状态会在每次 renderer 重载时重新推过来),
  // 带一个"重启安装"动作;不点也没事,退出时会自动装(autoInstallOnAppQuit)。
  const ANNOUNCED_KEY = "yoma.updater.announced"
  const announced = (): string | undefined => {
    try {
      return localStorage.getItem(ANNOUNCED_KEY) ?? undefined
    } catch {
      return undefined
    }
  }
  // `available` 是同一件事的另一种收场:这份安装不能自己升级(没有 Developer ID 的 mac 包),
  // 新版不会被下载,动作是打开发布页。它更需要喊 —— 不喊的话用户永远不知道出了新版。
  createEffect(() => {
    const state = platform.updater?.state()
    if ((state?.status !== "ready" && state?.status !== "available") || announced() === state.version) return
    try {
      localStorage.setItem(ANNOUNCED_KEY, state.version)
    } catch {
      // 存不了就每次重载都喊一次 —— 比漏喊好。
    }
    const selfUpdate = state.status === "ready"
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t(selfUpdate ? "settings.updates.toast.ready.title" : "settings.updates.toast.available.title"),
      description: language.t(
        selfUpdate ? "settings.updates.toast.ready.description" : "settings.updates.toast.available.description",
        { version: state.version },
      ),
      actions: [
        {
          label: language.t(selfUpdate ? "toast.update.action.installRestart" : "settings.updates.action.openDownload"),
          onClick: () => void platform.updater?.install(),
        },
      ],
    })
  })

  const [sidebarOpen, setSidebarOpen] = createSignal(true)

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready" && state?.status !== "available") return
      return state.version
    },
    actionLabel: () =>
      platform.updater?.state().status === "available"
        ? language.t("settings.updates.action.openDownload")
        : language.t("toast.update.action.installRestart"),
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar update={update} sidebar={{ opened: sidebarOpen, toggle: () => setSidebarOpen((value) => !value) }} />
      <PreflightBanner />
      <div class="flex flex-1 min-h-0 min-w-0">
        <Show when={sidebarOpen()}>
          <CodexSidebar />
        </Show>
        <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
          <Suspense>{props.children}</Suspense>
        </main>
      </div>
      <ToastRegion v2 />
    </div>
  )
}
