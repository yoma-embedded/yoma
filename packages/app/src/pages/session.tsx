import type { ToolConfirmView, UserMessage } from "@yoma-desktop/kernel"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { useData } from "@yoma-desktop/session-ui/context"
import { createQuery, useMutation, useQueryClient } from "@tanstack/solid-query"
import {
  onCleanup,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createComputed,
  on,
  onMount,
  untrack,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { debounce } from "@solid-primitives/scheduled"
import { useLocal } from "@/context/local"
import { useFile } from "@/context/file"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@yoma-desktop/ui/resize-handle"
import { createAutoScroll } from "@yoma-desktop/ui/hooks"
import { showToast } from "@/utils/toast"
import { kernel } from "@/utils/kernel"
import { base64Encode } from "@yoma-desktop/util/encode"
import { useLocation, useSearchParams } from "@solidjs/router"
import { NewSessionView, SessionHeader } from "@/components/session"
import { useComments } from "@/context/comments"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { PromptInput } from "@/components/prompt-input"
import { useSettingsCommand } from "@/components/settings-dialog"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import {
  createPromptInputController,
  createSessionComposerRegionController,
  SessionComposerRegion,
} from "@/pages/session/composer"
import { createSessionTabs, createSizing, shouldShowFileTree } from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/timeline/message-timeline"
import { createTimelineModel } from "@/pages/session/timeline/model"
import { useSessionLayout } from "@/pages/session/session-layout"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { debug as debugDock } from "@/pages/session/debug/debug-data"
import { BenchProvider } from "@/pages/session/bench/bench-context"
import { SessionConsole } from "@/pages/session/console/session-console"
import { SessionStatusBar } from "@/pages/session/console/session-status-bar"
import { consoleUI } from "@/pages/session/console/console-state"
import { useConsoleCommands } from "@/pages/session/console/use-console-commands"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { Identifier } from "@/utils/id"
import { Persist, persisted } from "@/utils/persist"
import { formatServerError } from "@/utils/server-errors"
import { directoryKey } from "@/context/global-sync/utils"
import { createSessionOwnership } from "./session/session-ownership"
import { prependRetracted, type RetractedMessage } from "./session/composer/queue-retract"
import { dockTasks } from "./session/subagent/task-view"

type FollowupItem = FollowupDraft & { id: string }
type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context">
const emptyFollowups: FollowupItem[] = []

const sessionViewState = () => ({
  messageId: undefined as string | undefined,
})

export default function Page() {
  const serverSync = useServerSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const settings = useSettings()
  const prompt = usePrompt()
  const comments = useComments()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const location = useLocation()
  const { params, sessionKey, workspaceKey, tabs, view } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  // 打开子会话 / 停止子 agent 的回调由宿主挂在 Data 上下文上(agent 卡片、状态栏任务面板、子 agent 坞同一份)。
  const data = useData()

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    dockSnap: false,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })

  const inputController = createPromptInputController({
    sessionKey,
    sessionID: () => params.id,
    queryOptions: serverSync().queryOptions,
  })

  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }
        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== base64Encode(sdk().directory)) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()
  // view().reviewPanel 是右栏的"开着没开"那一位(持久化字段名是审查页时代留下的)。
  const desktopDockOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const desktopFileTreeOpen = createMemo(
    () =>
      isDesktop() &&
      shouldShowFileTree({
        visible: settings.visibility.fileTree(),
        opened: layout.fileTree.opened(),
      }),
  )
  const desktopSidePanelOpen = createMemo(() => desktopDockOpen() || desktopFileTreeOpen())
  // 右侧四模式面板的可见性 —— 与 SessionSidePanel 内的 Show 条件保持一致
  const dockVisible = createMemo(() => isDesktop() && !!params.id)
  // 新布局这一行有 gap-2(8px)：中间栏按百分比减宽时要把这道缝一起减掉，
  // 否则 中间 + 缝 + 右栏 会超出一格，右栏顶掉右侧 8px 留白（贴到窗口边）。
  const rowGap = () => 8
  const sessionPanelWidth = createMemo(() => {
    if (dockVisible()) {
      if (!debugDock.opened()) return `calc(100% - ${36 + rowGap()}px)` // 收起态：给展开窄条(w-9)留位
      return `calc(100% - ${layout.dock.width() + rowGap()}px)` // 三个子页同一个宽度：右栏固定宽，中间吃剩下的
    }
    if (!desktopSidePanelOpen()) return "100%"
    if (desktopDockOpen()) return `${layout.session.width()}px`
    return `calc(100% - ${layout.fileTree.width()}px)`
  })
  const centered = createMemo(() => isDesktop() && !desktopDockOpen())

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
  })
  const activeFileTab = tabState.activeFileTab
  const timeline = createTimelineModel({ sessionID: () => params.id })
  const historyLoading = timeline.history.loading
  const historyMore = timeline.history.more
  const lastUserMessage = timeline.lastUserMessage
  const messagesReady = timeline.ready
  const sessionSync = timeline.resource
  const userMessages = timeline.userMessages

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) void file.load(path)
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: sdk().directory, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    ...sessionViewState(),
    deferRender: false,
  })

  const [followup, setFollowup] = persisted(
    Persist.workspace(sdk().directory, "followup", ["followup.v1"]),
    createStore<{
      items: Record<string, FollowupItem[] | undefined>
      failed: Record<string, string | undefined>
      paused: Record<string, boolean | undefined>
      edit: Record<string, FollowupEdit | undefined>
    }>({
      items: {},
      failed: {},
      paused: {},
      edit: {},
    }),
  )

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      const owner = sessionOwnership.capture()
      requestAnimationFrame(() => {
        setTimeout(() => owner.run(() => setStore("deferRender", false)), 0)
      })
    }
    return key
  })

  let dockFrame: number | undefined

  createComputed((prev) => {
    const open = desktopDockOpen()
    if (prev === undefined || prev === open) return open

    if (dockFrame !== undefined) cancelAnimationFrame(dockFrame)
    setUi("dockSnap", true)
    dockFrame = requestAnimationFrame(() => {
      dockFrame = undefined
      setUi("dockSnap", false)
    })
    return open
  }, desktopDockOpen())

  /**
   * 工作区未提交改动。审查页拆掉之后这份 diff 只剩一个用处:文件树/资源管理器上那些
   * "改过"的角标(ExplorerPanel 的 modified / kinds)。
   */
  const vcsKey = createMemo(() => ["session-vcs", sdk().directory, sync().data.vcs?.branch ?? ""] as const)
  const hasVcs = createMemo(() => !!sync().data.vcs?.root)
  /** 刚 git init、一次提交都没有:没有 HEAD 可比,diff 拉了也是空的。 */
  const vcsEmpty = createMemo(() => !!sync().data.vcs?.empty)
  const vcsQuery = createQuery(() => ({
    queryKey: vcsKey(),
    enabled: hasVcs() && !vcsEmpty(),
    queryFn: () =>
      sdk()
        .client.vcs.diff(sdk().directory)
        .catch((error) => {
          console.debug("[session-vcs] failed to load vcs diff", { error })
          return []
        }),
  }))
  const refreshVcs = debounce(() => void queryClient.invalidateQueries({ queryKey: vcsKey() }), 100)
  // avoids suspense
  const vcsDiffs = () => (vcsQuery.isFetched ? (vcsQuery.data ?? []) : [])

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = userMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let revealMessage = (_id: string) => {}
  let scrollToEnd = () => {}
  let scrollMark = 0
  let messageMark = 0

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(
    on(
      () => userMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore(sessionViewState())
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  const stopVcs = serverSDK().event.listen((event) => {
    if (event.type !== "vcs.updated") return
    // 同一个目录有 `D:\x` 与 `D:/x` 两种写法在 app 里流转(路由 vs 会话记录),按归一化后的 key 认。
    if (directoryKey(event.directory) !== directoryKey(sdk().directory)) return
    refreshVcs()
  })
  onCleanup(stopVcs)

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    // Only treat explicit scroll keys as potential "user scroll" gestures.
    if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
      markScrollGesture()
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      inputRef?.focus()
    }
  }

  createEffect(
    on(
      () => sync().data.session_status[params.id ?? ""]?.type,
      (next, prev) => {
        if (next !== "idle" || prev === undefined || prev === "idle") return
        refreshVcs()
      },
      { defer: true },
    ),
  )

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => {
    inputRef?.focus()
  }

  useComposerCommands()
  useSettingsCommand()
  useConsoleCommands()
  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
  })

  createEffect(
    on(
      activeFileTab,
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk().directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync().status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk().directory,
      () => {
        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "none",
  })
  createEffect(
    on(
      () => params.id,
      (id, previous) => {
        if (!id || !previous || id === previous) return
        if (location.hash || store.messageId || ui.pendingMessage) return
        autoScroll.resume()
      },
    ),
  )

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.resume()
    scrollToEnd()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  let captureHistoryAnchor = () => {}
  let restoreHistoryAnchor = (_done: boolean) => {}
  const historyRequests = new Set<string>()
  let historyContinuationFrame: number | undefined
  const loadOlder = async () => {
    const owner = sessionOwnership.capture()
    if (historyLoading() || historyRequests.has(owner.key)) return
    historyRequests.add(owner.key)
    const before = timeline.messages().length
    try {
      await timeline.history.loadOlder({
        before: () => owner.run(captureHistoryAnchor),
        after: (done) => owner.run(() => restoreHistoryAnchor(done)),
      })
    } finally {
      historyRequests.delete(owner.key)
    }
    if (!owner.current() || timeline.messages().length <= before) return
    if (!autoScroll.userScrolled() || !scroller || scroller.scrollTop >= 200 || !historyMore()) return
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
    historyContinuationFrame = requestAnimationFrame(() => {
      historyContinuationFrame = undefined
      owner.run(onHistoryScroll)
    })
  }
  const onHistoryScroll = () => {
    if (
      historyRequests.has(sessionOwnership.key()) ||
      historyLoading() ||
      !autoScroll.userScrolled() ||
      !scroller ||
      scroller.scrollTop >= 200
    )
      return
    void loadOlder()
  }

  onCleanup(() => {
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (!historyMore()) return

      void loadOlder()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          userMessages().length,
        ] as const,
      ([id, ready, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (!more) return
        fill()
      },
      { defer: true },
    ),
  )

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const busy = (sessionID: string) => sync().data.session_working(sessionID)

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  const followupMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; id: string; manual?: boolean }) => {
      const owner = sessionOwnership.capture()
      const item = (followup.items[input.sessionID] ?? []).find((entry) => entry.id === input.id)
      if (!item) return

      if (input.manual) setFollowup("paused", input.sessionID, undefined)
      setFollowup("failed", input.sessionID, undefined)

      const ok = await sendFollowupDraft({
        client: sdk().client,
        sync: sync(),
        serverSync: serverSync(),
        draft: item,
        optimisticBusy: item.sessionDirectory === sdk().directory,
      }).catch((err) => {
        setFollowup("failed", input.sessionID, input.id)
        fail(err)
        return false
      })
      if (!ok) return

      setFollowup("items", input.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== input.id))
      if (input.manual) owner.run(resumeScroll)
    },
  }))

  const followupBusy = (sessionID: string) =>
    followupMutation.isPending && followupMutation.variables?.sessionID === sessionID

  const sendingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    if (!followupBusy(id)) return
    return followupMutation.variables?.id
  })

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    return settings.general.followup() === "queue" && busy(id)
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() => queuedFollowups().map((item) => ({ id: item.id, text: followupText(item) })))

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followupBusy(sessionID)) return Promise.resolve()

    return followupMutation.mutateAsync({ sessionID, id, manual: opts?.manual })
  }

  const editFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
    })
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    const item = queuedFollowups()[0]
    if (!item) return
    if (followupBusy(sessionID)) return
    if (followup.failed[sessionID] === item.id) return
    if (followup.paused[sessionID]) return
    if (busy(sessionID)) return

    void sendFollowup(sessionID, item.id)
  })

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) scrollToEnd()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    userMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync().session.history.loadMore(sessionID),
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    autoScroll: {
      pause: autoScroll.pause,
      forceScrollToBottom: () => {
        autoScroll.resume()
        scrollToEnd()
      },
    },
    scroller: () => scroller,
    anchor,
    revealMessage: (id) => revealMessage(id),
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  onMount(() => {
    makeEventListener(document, "keydown", handleKeyDown)
  })

  onCleanup(() => {
    if (dockFrame !== undefined) cancelAnimationFrame(dockFrame)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  // ── 工具确认条(烧录前先问一声)────────────────────────────────────────────
  // 会话内容 store 里不放它:确认是内核里一条挂起中的询问,不是 transcript 的一部分。事件不重放,
  // 所以进会话页(以及内核重连时)先问一次现状(session.confirms),之后靠 tool.confirm 事件增删 ——
  // 与设置页的工具链安装进度同一套路。种子按 id 合并而不是整表替换:RPC 往返期间到达的结算事件
  // 不能被快照复活成一条答不掉的行。
  const [confirms, setConfirms] = createStore<{ items: ToolConfirmView[]; replying?: string }>({ items: [] })
  const seedConfirms = (sessionID: string) => {
    void kernel.session
      .confirms({ sessionID })
      .then((list) => {
        if (params.id !== sessionID) return
        const pending = list.filter((item) => item.status === "pending")
        setConfirms("items", (items) => {
          const known = new Set(items.map((item) => item.id))
          return [...items, ...pending.filter((item) => !known.has(item.id))]
        })
      })
      .catch(() => {})
  }
  createEffect(
    on(
      () => params.id,
      (sessionID) => {
        // 换会话:旧会话的行与"正在回复"一起清掉,否则一条残留的 replying 会把新会话的按钮全锁死。
        setConfirms({ items: [], replying: undefined })
        if (sessionID) seedConfirms(sessionID)
      },
    ),
  )
  // 子 agent 的任务同理:task.updated 进服务器级的会话 store,事件不重放,所以进会话页与内核重连时问一次现状。
  const seedTasks = (sessionID: string) => {
    void kernel.task
      .list({ sessionID })
      .then((list) => serverSync().session.seedTasks(sessionID, list))
      .catch(() => {})
  }
  createEffect(
    on(
      () => params.id,
      (sessionID) => {
        if (sessionID) seedTasks(sessionID)
      },
    ),
  )
  onMount(() => {
    const stop = serverSDK().event.listen((event) => {
      if (event.type === "kernel.connected") {
        if (params.id) {
          seedConfirms(params.id)
          seedTasks(params.id)
        }
        return
      }
      if (event.type !== "tool.confirm") return
      const view = event.confirm
      // 解锁按 id,与会话归属无关:在 A 点了允许立刻切到 B,A 的结算事件也得把按钮解开。
      if (confirms.replying === view.id) setConfirms("replying", undefined)
      if (view.sessionID !== params.id) return
      setConfirms("items", (items) => {
        const rest = items.filter((item) => item.id !== view.id)
        return view.status === "pending" ? [...rest, view] : rest
      })
    })
    onCleanup(stop)
  })
  const replyConfirm = (id: string, allow: boolean) => {
    setConfirms("replying", id)
    void kernel.session
      .confirmReply({ id, allow })
      .then(({ accepted }) => {
        // 解锁交给 RPC,删行交给事件(两件事别绑在同一条消息上)。没被接受 = 那条询问已经不在了
        // (超时 / 会话关了 / 内核重启过):结算事件可能永远不来,这里直接把行删掉。
        setConfirms("replying", undefined)
        if (!accepted) setConfirms("items", (items) => items.filter((item) => item.id !== id))
      })
      .catch(() => {
        setConfirms("replying", undefined)
        showToast({ variant: "error", title: language.t("session.confirmDock.replyFailed") })
      })
  }

  /**
   * 这一页是子 agent 的会话时,派它的主会话 id。会话信息还没到时先看任务视图(种子与事件都比会话详情早),
   * 免得输入框先冒出来再消失。
   */
  const subagentParent = createMemo(() => {
    const id = params.id
    if (!id) return
    return sync().session.get(id)?.parentID ?? sync().data.task[id]?.parentID
  })

  // ── 固定的「子 agent」坞(缺省后台之后"谁在跑"要有个不随对话滚动的位置)──────────────
  // 只画还没完事的:排队中 / 在跑 / 跑完但通知还在收件箱里排着。停止与打开走 Data 上下文那一份回调
  // (与 agent 卡片、状态栏任务面板同一份),这里不再写一遍 RPC。
  const subagentRows = createMemo(() => {
    const id = params.id
    if (!id) return []
    return dockTasks(sync().data.task, id, sync().data.queue[id])
  })

  // ── 排队中(会话忙时发的消息,照 CC;设计 §6.9)──────────────────────────────────
  // 数据是内核的 session.queue(收件箱现状)。子 agent 的通知也在收件箱里,但它不归用户改,这里只列 user 那几条。
  const queuedPrompts = createMemo(() => {
    const id = params.id
    if (!id) return []
    return (sync().data.queue[id] ?? []).flatMap((item) => (item.kind === "prompt" ? [item] : []))
  })
  const [queueUI, setQueueUI] = createStore<{ retracting: string[] }>({ retracting: [] })
  /**
   * 撤回:逐条 cancelQueued,撤成功的原文与图片拼回输入框(排队的在前、正在打的在后,照 CC);已经被这一轮
   * 取走的提示一句 —— 它已经在 transcript 里了。输入框按发起撤回时的会话捕获,中途切走也回不错地方。
   */
  const retractQueued = async (entryIds: readonly string[]) => {
    const sessionID = params.id
    if (!sessionID || entryIds.length === 0) return
    const owner = sessionOwnership.capture()
    const promptSession = prompt.capture()
    setQueueUI("retracting", (ids) => [...ids, ...entryIds])
    const back: RetractedMessage[] = []
    let consumed = 0
    try {
      for (const entryId of entryIds) {
        const result = await kernel.session.cancelQueued({ sessionID, entryId })
        if (result.kind === "cancelled") back.push({ entryId, text: result.text ?? "", files: result.files })
        else consumed++
      }
    } catch (err) {
      fail(err)
    } finally {
      setQueueUI("retracting", (ids) => ids.filter((id) => !entryIds.includes(id)))
    }
    if (back.length > 0) {
      const next = prependRetracted(promptSession.current(), back)
      promptSession.set(next.prompt, next.cursor)
      owner.run(() => requestAnimationFrame(() => inputRef?.focus()))
    }
    if (consumed > 0) showToast({ title: language.t("session.queueDock.consumed") })
  }
  /** 输入框里按 ↑(空输入):排着的全部撤回来(照 CC 的 popAllEditable)。正在撤的不重复发。 */
  const retractAllQueued = () => {
    const ids = queuedPrompts()
      .map((item) => item.entryId)
      .filter((id) => !queueUI.retracting.includes(id))
    if (ids.length === 0) return queuedPrompts().length > 0
    void retractQueued(ids)
    return true
  }

  const composerRegion = () => {
    const controller = createSessionComposerRegionController({
      sessionKey,
      sessionID: () => params.id,
      prompt,
      centered,
      confirms: () =>
        params.id && confirms.items.length
          ? { items: confirms.items, replying: confirms.replying, onReply: replyConfirm }
          : undefined,
      subagents: () => {
        const rows = subagentRows()
        if (!rows.length) return undefined
        return {
          items: rows,
          onOpen: (taskID) => data.navigateToSession?.(taskID),
          onStop: (taskID) => data.stopTask?.(taskID),
          onStopAll: () => {
            for (const row of rows) if (!row.reporting) data.stopTask?.(row.task.id)
          },
        }
      },
      queue: () =>
        queuedPrompts().length
          ? {
              items: queuedPrompts(),
              retracting: queueUI.retracting,
              onRetract: (entryId) => void retractQueued([entryId]),
            }
          : undefined,
      followup: () =>
        params.id
          ? {
              items: followupDock(),
              sending: sendingFollowup(),
              onSend: (id) => void sendFollowup(params.id!, id, { manual: true }),
              onEdit: editFollowup,
            }
          : undefined,
      setPromptRef: (el) => {
        inputRef = el
      },
      setDockRef: (el) => {
        promptDock = el
      },
    })
    return (
      <SessionComposerRegion
        controller={controller}
        promptInput={
          <PromptInput
            controls={inputController()}
            ref={(el) => {
              inputRef = el
            }}
            onSubmit={() => {
              comments.clear()
              resumeScroll()
            }}
            edit={editingFollowup()}
            onEditLoaded={clearFollowupEdit}
            shouldQueue={queueEnabled}
            onQueue={queueFollowup}
            onRetractQueued={retractAllQueued}
            onAbort={() => {
              const id = params.id
              if (!id) return
              setFollowup("paused", id, true)
            }}
          />
        }
      />
    )
  }

  /**
   * 底部控制台与状态栏只在真会话页上(草稿页没有目标板可说)、只在桌面宽度下。
   * 移动宽度下右栏本来就不显示,再压一条 24px 的状态栏只会把输入框顶掉。
   */
  const consoleVisible = createMemo(() => isDesktop() && !!params.id)

  /**
   * 控制台开合 / 拖高 / 最大化都会改变时间线**视口**的高度,而内容没变 —— `createAutoScroll`
   * 的观察器盯的是内容,这一下它看不见。不补这一句的话:开一次控制台,时间线就停在半空,
   * 而看起来像是"最新那条消息不见了"。用户自己往上翻过(userScrolled)时不动它。
   */
  createEffect(
    on(
      () => [consoleVisible() && consoleUI.opened(), consoleUI.height(), consoleUI.maximized()] as const,
      () => {
        if (autoScroll.userScrolled()) return
        requestAnimationFrame(() => {
          scrollToEnd()
          const el = scroller
          if (el) scheduleScrollState(el)
        })
      },
      { defer: true },
    ),
  )

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {sessionSync() ?? ""}
      <SessionHeader />
      {/* 会话区 = 上面一行(聊天栏 | 右栏) + 底部控制台 + 状态栏。
          左侧栏不在这棵树里,所以"横跨聊天栏与右栏"就是这一列的全宽。 */}
      <BenchProvider>
        <div class="flex-1 min-h-0 flex flex-col">
          <div
            class="flex-1 min-h-0 flex flex-col md:flex-row gap-2 p-2"
            style={{ display: consoleUI.maximized() && consoleVisible() ? "none" : undefined }}
          >
            <div
              classList={{
                "@container relative shrink-0 flex flex-col min-h-0 h-full flex-1 md:flex-none transition-[width]": true,
                "duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                  !size.active() && !ui.dockSnap,
              }}
              style={{
                width: sessionPanelWidth(),
                // 右侧面板全屏时隐藏中间会话栏（inline style 优先级高于 flex 类）
                display: debugDock.fullscreen() ? "none" : undefined,
              }}
            >
              <div
                classList={{
                  "flex-1 min-h-0 flex flex-col bg-v2-background-bg-base rounded-[10px] overflow-hidden": true,
                  "shadow-[var(--v2-elevation-raised)]": !!params.id,
                }}
              >
                <div class="flex-1 min-h-0 overflow-hidden">
                  <Switch>
                    <Match when={params.id}>
                      <Show when={messagesReady() ? params.id : undefined} keyed>
                        {(_id) => (
                          <MessageTimeline
                            scroll={ui.scroll}
                            onResumeScroll={resumeScroll}
                            setScrollRef={setScrollRef}
                            onScheduleScrollState={scheduleScrollState}
                            onAutoScrollHandleScroll={autoScroll.handleScroll}
                            onMarkScrollGesture={markScrollGesture}
                            hasScrollGesture={hasScrollGesture}
                            onUserScroll={markUserScroll}
                            onHistoryScroll={onHistoryScroll}
                            onAutoScrollInteraction={autoScroll.handleInteraction}
                            shouldAnchorBottom={() =>
                              !location.hash && !store.messageId && !ui.pendingMessage && !autoScroll.userScrolled()
                            }
                            centered={centered()}
                            setContentRef={(el) => {
                              content = el
                              autoScroll.contentRef(el)

                              const root = scroller
                              if (root) scheduleScrollState(root)
                            }}
                            userMessages={userMessages()}
                            setHistoryAnchor={(handlers) => {
                              captureHistoryAnchor = handlers.capture
                              restoreHistoryAnchor = handlers.restore
                            }}
                            anchor={anchor}
                            setRevealMessage={(fn) => {
                              revealMessage = fn
                            }}
                            setScrollToEnd={(fn) => {
                              scrollToEnd = fn
                            }}
                          />
                        )}
                      </Show>
                    </Match>
                    <Match when={true}>
                      <NewSessionView />
                    </Match>
                  </Switch>
                </div>

                {/* 子 agent 的会话没有输入框:它只听派它的主 agent(照 CC),用户要插话走主会话。 */}
                <Show when={params.id && !subagentParent()}>{(_) => composerRegion()}</Show>
              </div>

              {/* 右栏（三子页）由面板自己左边缘那根手柄统一调宽，这根只服务旧布局，免得同一条缝上叠两根 */}
              <Show when={!dockVisible() && desktopDockOpen()}>
                <div onPointerDown={() => size.start()}>
                  <ResizeHandle
                    class="-right-1"
                    direction="horizontal"
                    size={layout.session.width()}
                    min={450}
                    max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.45}
                    onResize={(width) => {
                      size.touch()
                      layout.session.resize(width)
                    }}
                  />
                </div>
              </Show>
            </div>

            <SessionSidePanel diffs={vcsDiffs} snap={ui.dockSnap} size={size} />
          </div>

          <Show when={consoleVisible()}>
            <SessionConsole />
            <SessionStatusBar />
          </Show>
        </div>
      </BenchProvider>
    </div>
  )
}
