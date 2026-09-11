import "@/index.css"
import { I18nProvider } from "@yoma-desktop/ui/context"
import { DialogProvider } from "@yoma-desktop/ui/context/dialog"
import { FileComponentProvider } from "@yoma-desktop/ui/context/file"
import { MarkedProvider } from "@yoma-desktop/ui/context/marked"
import { File } from "@yoma-desktop/session-ui/file"
import { Font } from "@yoma-desktop/ui/font"
import { ThemeProvider } from "@yoma-desktop/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router, useParams, useSearchParams } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import {
  type Component,
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  type JSX,
  lazy,
  type ParentProps,
  Show,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider, useCommand, type CommandOption } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "@/context/server-sync"
import { GlobalProvider } from "@/context/global"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider, useNotification } from "@/context/notification"
import { usePlatform } from "@/context/platform"
import { PromptProvider } from "@/context/prompt"
import { SettingsProvider } from "@/context/settings"
import { DraftsProvider, useDrafts, type Draft } from "@/context/drafts"
import { SDKProvider, useSDK } from "@/context/sdk"
import DirectoryLayout, { DirectoryDataProvider } from "@/pages/directory-layout"
import NewLayout from "@/pages/layout-new"
import { ErrorPage } from "./pages/error"
import { sessionHref } from "./utils/session-href"
import { isSessionNotFoundError } from "./utils/server-errors"

import Session from "@/pages/session"
import { NewHome } from "@/pages/home"

const NewSession = lazy(() => import("@/pages/new-session"))
const ManualsPage = lazy(() => import("@/pages/manuals"))
const BenchPage = lazy(() => import("@/pages/bench"))

const SessionRoute = () => {
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const sdk = useSDK()
  const drafts = useDrafts()

  // 旧形状 /<base64(dir)>/session/<id> —— 桌面端记着的上次路由可能还是它,转到正式路由。
  if (params.id) return <Navigate href={sessionHref(params.id)} />

  // The bare /:dir/session route (no id) is replaced by a draft at /new-session?draftId=…
  createEffect(() => {
    if (params.id || search.draftId) return
    if (!drafts.ready() || !sdk().directory) return
    drafts.create({ directory: sdk().directory }, search.prompt)
  })

  return (
    <SessionProviders>
      <Session />
    </SessionProviders>
  )
}

function TargetSessionRoute() {
  const params = useParams<{ id: string }>()
  const sync = useServerSync()
  const [missing, setMissing] = createSignal(false)
  const cached = createMemo(() => sync().session.get(params.id))
  const [resolved] = createResource(
    () => {
      if (cached()) return
      return { id: params.id, sync: sync() }
    },
    ({ id, sync }) =>
      // 原来解析的是 lineage(沿 parentID 往上找祖先链)。内核里 session 之间没有父子,
      // 所以退化成"把这一个会话取回来"。
      sync.session.resolve(id).catch((error: unknown) => {
        // 会话不存在不是致命错误 —— 回首页就行。换内核之后尤其常见:桌面端记着的上次
        // 路由带的是 opencode 格式的 id(ses_xxx),而新内核的 id 是 UUID。
        // **不能往上抛**,否则整个 app 崩到错误页。
        if (isSessionNotFoundError(error, id)) {
          setMissing(true)
          return undefined
        }
        throw error
      }),
  )
  // 内核里 session 之间没有父子关系,所以路由解析的结果就是这一个会话本身。
  const current = createMemo(() => {
    const hit = cached() ?? resolved()
    return hit?.id === params.id ? hit : undefined
  })
  const directory = createMemo(() => current()?.directory)
  const targetDirectory = () => directory()!

  return (
    // 会话已经不存在了:回首页,别把用户留在一张空页面上。
    <Show when={!missing()} fallback={<Navigate href="/" />}>
      <TargetServerScopedProviders directory={directory} sessionID={() => params.id}>
        <Show when={!!current() || resolved.state !== "errored"} fallback={<ErrorPage error={resolved.error} />}>
          <Show when={directory()}>
            <SDKProvider directory={targetDirectory}>
              <DirectoryDataProvider directory={targetDirectory} sessionRoute>
                <TargetSessionPage />
              </DirectoryDataProvider>
            </SDKProvider>
          </Show>
        </Show>
      </TargetServerScopedProviders>
    </Show>
  )
}

function TargetSessionPage() {
  const sdk = useSDK()
  return (
    <Show when={sdk().directory} keyed>
      <SessionProviders>
        <Session />
      </SessionProviders>
    </Show>
  )
}

// 内核的 SDK / sync 上下文。以前这里还要先 gate 在"当前选中哪台服务器"上,
// 现在只有一个内核,剩下的就是把两个 provider 摊开。
function SelectedServerProviders(props: ParentProps) {
  return (
    <ServerSDKProvider>
      <ServerSyncProvider>{props.children}</ServerSyncProvider>
    </ServerSDKProvider>
  )
}

// Provider-only wrapper for the /:dir routes. It has no visual chrome of its own —
// the shell is mounted once in the router root (see NewAppLayout).
function DirectoryRouteProviders(props: ParentProps) {
  return (
    <SelectedServerProviders>
      <ServerScopedProviders>{props.children}</ServerScopedProviders>
    </SelectedServerProviders>
  )
}

function DraftRoute() {
  const [search] = useSearchParams<{ draftId?: string }>()
  const drafts = useDrafts()
  return (
    <Show when={drafts.ready()}>
      <Show
        when={search.draftId ? drafts.get(search.draftId) : undefined}
        keyed
        fallback={<Navigate href="/" />}
      >
        {(draft) => <ResolvedDraftRoute draft={draft} />}
      </Show>
    </Show>
  )
}

function ResolvedDraftRoute(props: { draft: Draft }) {
  const directory = () => props.draft.directory

  return (
    <Show when={props.draft.directory} keyed>
      <TargetServerScopedProviders directory={directory}>
        <SDKProvider directory={directory}>
          <DirectoryDataProvider directory={directory} draftID={props.draft.draftID}>
            <DraftProviders>
              <NewSession />
            </DraftProviders>
          </DirectoryDataProvider>
        </SDKProvider>
      </TargetServerScopedProviders>
    </Show>
  )
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
      exportDebugLogs?: () => Promise<string>
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function BodyDesignClass() {
  createRenderEffect(() => {
    if (typeof document === "undefined") return

    document.body.toggleAttribute("data-new-layout", true)
    document.body.classList.add("font-(family-name:--font-family-text)", "text-[13px]", "font-[440]")
  })

  return null
}

// Server-agnostic providers shared across every route. These live in the shared
// shell (router root) so they stay mounted regardless of the active server/route.
function SharedProviders(props: ParentProps) {
  return (
    <>
      <BodyDesignClass />
      <CommandProvider>
        <DesktopCommands />
        {props.children}
      </CommandProvider>
    </>
  )
}

function DesktopCommands() {
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()

  command.register("desktop", () => {
    const commands: CommandOption[] = []
    if (platform.platform === "desktop" && platform.exportDebugLogs) {
      commands.push({
        id: "logs.export",
        title: "Export logs",
        category: language.t("command.category.settings"),
        onSelect: () => {
          void platform.exportDebugLogs?.()
        },
      })
    }
    return commands
  })

  return null
}

type ServerScopedShellProps = ParentProps<{
  directory?: () => string | undefined
  sessionID?: () => string | undefined
}>

// Server-scoped providers for the routes that are not bound to one directory.
function ServerScopedProviders(props: ParentProps) {
  return (
    <LayoutProvider>
      <ModelsProvider>{props.children}</ModelsProvider>
    </LayoutProvider>
  )
}

function NewAppLayout(props: ParentProps) {
  return (
    <SelectedServerProviders>
      <ServerScopedProviders>
        <NewLayout>{props.children}</NewLayout>
      </ServerScopedProviders>
    </SelectedServerProviders>
  )
}

function TargetServerScopedProviders(props: ServerScopedShellProps) {
  return (
    <>
      <MarkSessionNotificationsViewed sessionID={props.sessionID} />
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </>
  )
}

function MarkSessionNotificationsViewed(props: { sessionID?: () => string | undefined }) {
  const notification = useNotification()
  createEffect(() => {
    const sessionID = props.sessionID?.()
    if (!notification.ready() || !sessionID) return
    if (notification.session.unseenCount(sessionID) === 0) return
    notification.session.markViewed(sessionID)
  })
  return null
}

function SessionProviders(props: ParentProps) {
  return (
    <FileProvider>
      <PromptProvider>
        <CommentsProvider>{props.children}</CommentsProvider>
      </PromptProvider>
    </FileProvider>
  )
}

// FileProvider and CommentsProvider stay because PromptInput uses file search and comment context.
function DraftProviders(props: ParentProps) {
  return (
    <FileProvider>
      <PromptProvider>
        <CommentsProvider>{props.children}</CommentsProvider>
      </PromptProvider>
    </FileProvider>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => <ErrorPage error={error} />}
            >
              <QueryProvider>
                <DialogProvider>
                  <MarkedProvider>
                    <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                  </MarkedProvider>
                </DialogProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  router?: Component<BaseRouterProps>
}) {
  // The visual new layout lives in the router root so it remains mounted across
  // route changes. Draft and session routes override only their server-bound data
  // providers beneath it.
  const ServerShell = (shellProps: ParentProps) => (
    <QueryProvider>
      <SharedProviders>
        {props.children}
        {shellProps.children}
      </SharedProviders>
    </QueryProvider>
  )

  return (
    <GlobalProvider>
      <SettingsProvider>
        <Dynamic
          component={props.router ?? Router}
          root={(routerProps) => (
            <DraftsProvider>
              <NotificationProvider>
                <ServerShell>
                  <NewAppLayout>{routerProps.children}</NewAppLayout>
                </ServerShell>
              </NotificationProvider>
            </DraftsProvider>
          )}
        >
          <Routes />
        </Dynamic>
      </SettingsProvider>
    </GlobalProvider>
  )
}

function Routes() {
  return (
    <>
      <Route component={DirectoryRouteProviders}>
        <Route path="/:dir" component={DirectoryLayout}>
          <Route path="/" component={() => <Navigate href="session" />} />
          <Route path="/session/:id?" component={SessionRoute} />
        </Route>
      </Route>
      <Route path="/" component={NewHome} />
      <Route path="/manuals" component={ManualsPage} />
      <Route path="/bench" component={BenchPage} />
      <Route path="/:dir/session/:id" component={LegacySessionRedirect} />
      <Route path="/new-session" component={DraftRoute} />
      <Route path="/session/:id" component={TargetSessionRoute} />
      <Route path="/server/:serverKey/session/:id" component={LegacySessionRedirect} />
    </>
  )
}

/**
 * 旧会话路由的去处。两种形状都只是改了地址:
 *   /server/<base64(serverKey)>/session/<id>  多服务器时代的正式形状
 *   /<base64(dir)>/session/<id>               更早的、按目录编址的形状
 * 桌面端把上次的路由存进了 localStorage(renderer/index.tsx),这两条重定向是
 * 为了让升级后那条记忆仍然落在会话上,而不是 404。
 */
function LegacySessionRedirect() {
  const params = useParams<{ id: string }>()
  return <Navigate href={sessionHref(params.id)} />
}
