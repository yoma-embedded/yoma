import { createEffect, createMemo, createResource, createSignal, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { IconButtonV2 } from "@yoma-desktop/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@yoma-desktop/ui/v2/icon"
import { KeybindV2 } from "@yoma-desktop/ui/v2/keybind-v2"
import { TooltipV2 } from "@yoma-desktop/ui/v2/tooltip-v2"

import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { WindowsAppMenu } from "./windows-app-menu"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { createMediaQuery } from "@solid-primitives/media"
import { useGlobal } from "@/context/global"
import { useDrafts } from "@/context/drafts"
import "./titlebar.css"

const v2TitlebarHeight = 36
const minTitlebarZoom = 0.25
const windowsControlsBaseWidth = 138 // 3 native Windows caption buttons at 46px each.

export type TitlebarUpdate = {
  version: () => string | undefined
  installing: () => boolean
  install: () => void
}

export function Titlebar(props: {
  update?: TitlebarUpdate
  sidebar?: { opened: () => boolean; toggle: () => void }
}) {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const mobile = createMediaQuery("(max-width: 767px)")
  const bottom = createMemo(() => mobile() && settings.general.mobileTitlebarPosition() === "bottom")

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const zoom = () => platform.webviewZoom?.() ?? 1
  const titlebarZoom = () => (windows() ? Math.max(zoom(), minTitlebarZoom) : zoom())
  const minHeight = () => {
    if (mac()) return `${v2TitlebarHeight / zoom()}px`
    if (windows()) return `${v2TitlebarHeight / Math.min(titlebarZoom(), 1)}px`
    return undefined
  }
  const windowsControlsWidth = () => `${windowsControlsBaseWidth / Math.max(titlebarZoom(), 1)}px`

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`
  const creating = createMemo(() => {
    const route = layout.route()
    if (route.type === "draft" || route.type === "dir-new-sesssion") return true
    if (!params.dir) return false
    if (params.id) return false
    const parts = location.pathname.replace(/\/+$/, "").split("/")
    return parts.at(-1) === "session"
  })

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const updateState = createMemo<TitlebarUpdatePillState>(() => {
    const installing = props.update?.installing() ?? false
    const version = props.update?.version()
    return {
      visible: version !== undefined || installing,
      installing,
      label: "Update",
      ariaLabel: language.t("toast.update.action.installRestart"),
      title: version ? `Update ${version}` : undefined,
      onInstall: () => props.update?.install(),
    }
  })
  const v2RightState = createMemo<TitlebarV2RightState>(() => ({
    update: updateState(),
  }))

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  return (
    <header
      data-slot="titlebar-v2"
      classList={{
        "shrink-0 relative flex flex-row h-9 bg-v2-background-bg-deep overflow-visible": true,
        "order-last": bottom(),
      }}
      style={{
        "min-height": minHeight(),
        // Keep native macOS traffic lights clear even when the desktop window is narrow.
        "padding-left": mac() ? `${84 / zoom()}px` : 0,
        width: windows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        "max-width": windows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        "align-self": windows() ? "flex-start" : undefined,
      }}
      // Electron 的无边框窗口靠 CSS app-region 拖动(见 ui/styles/base.css)——
      // 属性名是 opencode 时代的 tauri 遗留,但选择器是活的,不能改名。
      data-tauri-drag-region
    >
      {(() => {
        const layout = useLayout()
        const global = useGlobal()
        const drafts = useDrafts()
        const [session] = createResource(
          () => {
            const route = layout.route()
            if (route.type !== "session") return undefined
            return { route, sdk: global.ctx.sdk }
          },
          ({ route, sdk }) => sdk.client.session.get(route.sessionId).catch(() => {}),
        )

        /**
         * 首页按钮是个来回开关:在会话/草稿上点一下去首页,再点一下回刚才那页。
         * 以前"刚才那页"是标签条里的 recent 标签(持久化在 tabs.recent);标签没了之后
         * 只记这一次会话里离开的那个地址 —— 重启后桌面端本来就会把上次的路由还原回来。
         */
        const [back, setBack] = createSignal<string | undefined>()

        const newSession = () => {
          const route = layout.route()
          const activeSession = session()
          if (route.type === "session" && activeSession) {
            drafts.create({ directory: activeSession.directory }, "")
            return
          }

          if (route.type === "draft") {
            const draft = drafts.get(route.draftID)
            if (draft) {
              drafts.create({ directory: draft.directory }, "")
              return
            }
          }

          const current = layout.projects.list()[0] ?? global.ctx.projects.list()[0]
          if (!current) return
          drafts.create({ directory: current.worktree }, "")
        }

        const toggleHome = () => {
          if (layout.route().type === "home") {
            const target = back()
            if (target) navigate(target)
            return
          }
          setBack(`${location.pathname}${location.search}`)
          navigate("/")
        }

        command.register("titlebar-home", () => [
          {
            // 标签条没了之后 mod+t 也没了;首页和草稿页上也得有一条键盘/菜单路径能开新会话。
            // 会话页自己也注册 session.new(同一个 id,command 注册表按 id 先到先得,不会双触发)。
            id: "session.new",
            title: language.t("command.session.new"),
            category: language.t("command.category.session"),
            keybind: "mod+shift+s",
            hidden: true,
            onSelect: newSession,
          },
          {
            id: "home.toggle",
            title: language.t("home.title"),
            category: language.t("command.category.view"),
            keybind: "mod+b",
            hidden: true,
            onSelect: toggleHome,
          },
        ])

        return (
          <div
            class="h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 px-2 md:pr-3"
            classList={{
              "pt-2": !bottom(),
              "pb-2": bottom(),
              "md:pl-2": mac(),
              "md:pl-4": !mac(),
            }}
          >
            <ChannelIndicator />
            <Show when={windows() || linux()}>
              <WindowsAppMenu command={command} platform={platform} variant="v2" />
            </Show>
            <Show when={props.sidebar}>
              {(sidebar) => (
                <TooltipV2
                  placement="bottom"
                  value={
                    sidebar().opened() ? language.t("codex.collapseSidebar") : language.t("codex.expandSidebar")
                  }
                  class="shrink-0"
                >
                  <IconButtonV2
                    type="button"
                    variant="ghost-muted"
                    size="large"
                    class="!w-9 shrink-0"
                    icon={<IconV2 name="sidebar" />}
                    state={sidebar().opened() ? "pressed" : undefined}
                    onClick={() => sidebar().toggle()}
                    aria-label={
                      sidebar().opened() ? language.t("codex.collapseSidebar") : language.t("codex.expandSidebar")
                    }
                    aria-pressed={sidebar().opened()}
                  />
                </TooltipV2>
              )}
            </Show>
            <TooltipV2
              placement="bottom"
              value={
                <>
                  {language.t("home.title")}
                  <KeybindV2 keys={command.keybindParts("home.toggle")} variant="neutral" />
                </>
              }
              class="shrink-0"
            >
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="large"
                class="!w-9 shrink-0"
                icon={<IconV2 name="grid-plus" />}
                state={layout.route().type === "home" ? "pressed" : undefined}
                onClick={toggleHome}
                aria-label={language.t("home.title")}
                aria-pressed={layout.route().type === "home"}
              />
            </TooltipV2>

            <Show when={!creating()}>
              <TooltipV2 placement="bottom" value={language.t("command.session.new")}>
                <IconButtonV2
                  type="button"
                  variant="ghost-muted"
                  size="large"
                  class="shrink-0"
                  icon={<IconV2 name="plus" />}
                  onClick={newSession}
                  aria-label={language.t("command.session.new")}
                />
              </TooltipV2>
            </Show>
            <div class="flex-1" />
            <TitlebarV2Right state={v2RightState()} />
          </div>
        )
      })()}
    </header>
  )
}

type TitlebarUpdatePillState = {
  visible: boolean
  installing: boolean
  label: string
  ariaLabel: string
  title?: string
  onInstall: () => void
}

type TitlebarV2RightState = {
  update: TitlebarUpdatePillState
}

function TitlebarV2Right(props: { state: TitlebarV2RightState }) {
  return (
    <div class="relative z-20 flex shrink-0 items-center justify-end gap-0 overflow-visible">
      <Show when={props.state.update.visible}>
        <TitlebarUpdateIconButton state={props.state.update} />
      </Show>
      <div id="opencode-titlebar-right" class="flex shrink-0 items-center justify-end gap-0" />
    </div>
  )
}

function TitlebarUpdateIconButton(props: { state: TitlebarUpdatePillState }) {
  return (
    <div class="group relative mr-3 h-5 w-5 shrink-0 rounded-full bg-v2-background-bg-deep transition-[width] duration-150 ease-out hover:z-30 hover:w-[68px] focus-within:z-30 focus-within:w-[68px] motion-reduce:transition-none">
      <button
        type="button"
        class="absolute right-0 top-0 z-10 flex h-5 w-5 items-center justify-end overflow-hidden rounded-full bg-v2-icon-icon-accent/20 text-v2-icon-icon-accent transition-[width,background-color] duration-150 ease-out group-hover:w-[68px] group-hover:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] group-focus-within:w-[68px] group-focus-within:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] focus-visible:outline-none disabled:opacity-60 motion-reduce:transition-none"
        onClick={props.state.onInstall}
        disabled={props.state.installing}
        aria-busy={props.state.installing}
        aria-label={props.state.ariaLabel}
      >
        <span class="shrink-0 ml-[8px] mr-px text-[11px] text-v2-text-text-accent [font-weight:530] opacity-0 translate-x-2 motion-safe:transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-x-0 group-focus-within:opacity-100 group-focus-within:translate-x-0 motion-reduce:translate-x-0">
          Update
        </span>
        <span class="flex size-5 shrink-0 items-center justify-center">
          <Show
            when={!props.state.installing}
            fallback={<span data-slot="titlebar-update-loader" aria-hidden="true" />}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128" stroke="currentColor" />
            </svg>
          </Show>
        </span>
      </button>
    </div>
  )
}

function ChannelIndicator() {
  return (
    <>
      {["beta", "dev"].includes(import.meta.env.VITE_YOMA_CHANNEL) && (
        <div class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono">
          {import.meta.env.VITE_YOMA_CHANNEL.toUpperCase()}
        </div>
      )}
    </>
  )
}
