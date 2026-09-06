import { createEffect, createSignal, Show, Suspense, type ParentProps } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, showToast, ToastRegion } from "@/utils/toast"
import { CodexSidebar } from "./layout/codex-sidebar"
import { CodexSearch } from "./layout/codex-search"
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
  createEffect(() => {
    const state = platform.updater?.state()
    if (state?.status !== "ready" || announced() === state.version) return
    try {
      localStorage.setItem(ANNOUNCED_KEY, state.version)
    } catch {
      // 存不了就每次重载都喊一次 —— 比漏喊好。
    }
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("settings.updates.toast.ready.title"),
      description: language.t("settings.updates.toast.ready.description", { version: state.version }),
      actions: [{ label: language.t("toast.update.action.installRestart"), onClick: () => void platform.updater?.install() }],
    })
  })

  const [searchOpen, setSearchOpen] = createSignal(false)
  const [sidebarOpen, setSidebarOpen] = createSignal(true)

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
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
          <CodexSidebar onOpenSearch={() => setSearchOpen(true)} />
        </Show>
        <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
          <Suspense>{props.children}</Suspense>
        </main>
      </div>
      {import.meta.env.DEV && <DebugBar inline />}
      <ToastRegion v2 />
      <Show when={searchOpen()}>
        <CodexSearch onClose={() => setSearchOpen(false)} />
      </Show>
    </div>
  )
}
