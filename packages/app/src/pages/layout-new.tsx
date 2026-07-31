import { createEffect, createSignal, Show, Suspense, type ParentProps } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { CodexSidebar } from "./layout/codex-sidebar"
import { CodexSearch } from "./layout/codex-search"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const navigate = useNavigate()
  setNavigate(navigate)

  createEffect(() => setV2Toast(true))

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
