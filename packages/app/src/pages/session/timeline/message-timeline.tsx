import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { createVirtualizer, defaultRangeExtractor, elementScroll, type VirtualItem } from "@tanstack/solid-virtual"
import {
  groupRefs,
  Message,
  MessageDivider,
  Part as MessagePart,
  partDefaultOpen,
  type PartRef,
} from "@yoma-desktop/session-ui/message-part"
import { FileIcon } from "@yoma-desktop/ui/file-icon"
import { Icon as IconV2 } from "@yoma-desktop/ui/v2/icon"
import { IconButtonV2 } from "@yoma-desktop/ui/v2/icon-button-v2"
import { MenuV2 } from "@yoma-desktop/ui/v2/menu-v2"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@yoma-desktop/ui/v2/dialog-v2"
import { InlineInput } from "@yoma-desktop/ui/inline-input"
import { ButtonV2 } from "@yoma-desktop/ui/v2/button-v2"
import { ScrollView } from "@yoma-desktop/ui/scroll-view"
import { TextReveal } from "@yoma-desktop/ui/text-reveal"
import { TextShimmer } from "@yoma-desktop/ui/text-shimmer"
import type { AssistantMessage, Message as MessageType, Part as PartType, UserMessage } from "@yoma-desktop/kernel"
import { showToast } from "@/utils/toast"
import { getFilename } from "@yoma-desktop/util/path"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSessionKey } from "@/pages/session/session-layout"
import { useSettings } from "@/context/settings"
import { useDrafts } from "@/context/drafts"
import { sessionHref } from "@/utils/session-href"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useCommand } from "@/context/command"
import { sessionTitle } from "@/utils/session-title"
import { scheduleConnectedMeasure } from "./measure"
import { ContextGroupRow } from "./context-group-row"
import { TurnChangesRow } from "./turn-changes-row"
import { TimelineSearch } from "./timeline-search"
import { createTimelineProjection } from "./projection"
import { MessageComment, TimelineRow, TimelineRowMap } from "./rows"
import { ModelRequestStatus } from "./model-request-status"
import { filterVirtualIndexes } from "./virtual-items"
import { SubagentBack, SubagentStatus } from "../subagent/subagent-header"

const emptyMessages: MessageType[] = []
const emptyParts: PartType[] = []
const emptyAssistantMessages: AssistantMessage[] = []
const idle = { type: "idle" as const }

type FramedTimelineRow = Exclude<TimelineRow.TimelineRow, { _tag: "TurnGap" }>
type TimelineRowByTag<T extends TimelineRow.TimelineRow["_tag"]> = Extract<TimelineRow.TimelineRow, { _tag: T }>

const timelineFallbackItemSize = 60
const timelineCache = new Map<string, { measurements: VirtualItem[]; toolOpen: Record<string, boolean | undefined> }>()

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

function TimelineThinkingRow(props: { reasoningHeading?: string; showReasoningSummaries: boolean }) {
  const language = useLanguage()

  return (
    <div data-slot="session-turn-thinking">
      <TextShimmer text={language.t("ui.sessionTurn.status.thinking")} />
      <Show when={!props.showReasoningSummaries}>
        <TextReveal text={props.reasoningHeading} class="session-turn-thinking-heading" travel={25} duration={700} />
      </Show>
    </div>
  )
}

export function MessageTimeline(props: {
  scroll: { overflow: boolean; bottom: boolean; jump: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onHistoryScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  shouldAnchorBottom: () => boolean
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  userMessages: UserMessage[]
  anchor: (id: string) => string
  setRevealMessage?: (fn: (id: string) => void) => void
  /** 会话内搜索跳到一处时叫:不停掉跟随到底的话,流式输出会立刻把视口拽回底部。 */
  onPauseAutoScroll?: () => void
  /** 更早的消息还没加载:搜索条要说一声"只搜了已加载的"。 */
  historyMore?: boolean
  setScrollToEnd?: (fn: () => void) => void
  setHistoryAnchor?: (handlers: { capture: () => void; restore: (done: boolean) => void }) => void
}) {
  let touchGesture: number | undefined

  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const settings = useSettings()
  const drafts = useDrafts()
  const dialog = useDialog()
  const language = useLanguage()
  const { params, sessionKey } = useSessionKey()
  const ownerSessionKey = sessionKey()
  const cached = timelineCache.get(ownerSessionKey)
  const initialMeasurements = cached?.measurements
  const coldBottomMount = !initialMeasurements?.length && props.shouldAnchorBottom()

  const [listRoot, setListRoot] = createSignal<HTMLDivElement>()
  const sessionID = createMemo(() => params.id)
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync().data.session_status[id] ?? idle
  })
  const sessionMessages = createMemo(() => (sessionID() ? (sync().data.message[sessionID()!] ?? []) : []))
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync().session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const getMsgParts = (msgId: string) => sync().data.part[msgId] ?? emptyParts
  const getMsgPart = (messageID: string, partID: string) => getMsgParts(messageID).find((part) => part.id === partID)
  const showHeader = createMemo(() => !!titleValue())
  const projection = createTimelineProjection({
    messages: sessionMessages,
    userMessages: () => props.userMessages,
    parts: getMsgParts,
    status: sessionStatus,
    showReasoningSummaries: settings.general.showReasoningSummaries,
  })
  const activeMessageID = projection.activeMessageID
  const assistantMessagesByParent = projection.assistantMessagesByParent
  const messageByID = projection.messageByID
  const messageLastRowIndex = projection.messageLastRowIndex
  const messageRowIndex = projection.messageRowIndex
  const timelineRowByKey = projection.rowByKey
  const timelineRows = projection.rows

  let prependAnchor: { key: string; offset: number } | undefined
  let prependAnchorFrame: number | undefined
  let prependLoading = false
  const clearPrependAnchor = () => {
    prependLoading = false
    prependAnchor = undefined
    if (prependAnchorFrame === undefined) return
    cancelAnimationFrame(prependAnchorFrame)
    prependAnchorFrame = undefined
  }
  const capturePrependAnchor = () => {
    prependLoading = true
    updatePrependAnchor()
  }
  const updatePrependAnchor = () => {
    const root = listRoot()
    if (!root) return
    const view = root.getBoundingClientRect()
    const anchor = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!anchor) return
    if (!anchor.element.dataset.timelineKey) return
    prependAnchor = { key: anchor.element.dataset.timelineKey, offset: anchor.rect.top - view.top }
  }
  const restorePrependAnchor = (done: boolean) => {
    if (done) prependLoading = false
    applyPrependAnchor()
  }
  const applyPrependAnchor = () => {
    const root = listRoot()
    if (!root || !prependAnchor) return
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    let frames = 0
    let stable = 0
    const apply = () => {
      prependAnchorFrame = undefined
      const anchor = prependAnchor
      if (!anchor) return
      const element = root.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(anchor.key)}"]`)
      const delta = element
        ? element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset
        : undefined
      if (delta !== undefined && Math.abs(delta) > 0.5) {
        root.scrollTop += delta
        stable = 0
      } else {
        stable += 1
      }
      frames += 1
      if (stable >= 30 || frames >= 180) {
        if (!prependLoading) prependAnchor = undefined
        return
      }
      prependAnchorFrame = requestAnimationFrame(apply)
    }
    prependAnchorFrame = requestAnimationFrame(apply)
  }

  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>(cached?.toolOpen ?? {})
  const [renderOverscan, setRenderOverscan] = createSignal(initialMeasurements?.length || coldBottomMount ? 6 : 20)
  let resizePinnedIndexes: number[] = []
  let resizePinFrame: number | undefined
  let virtualContent: HTMLDivElement | undefined
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return timelineRows().length
    },
    getScrollElement: () => listRoot() ?? null,
    initialOffset: () => (props.shouldAnchorBottom() ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: initialMeasurements,
    estimateSize: () => timelineFallbackItemSize,
    scrollToFn: (offset, options, instance) => {
      // Expose the computed range before core writes an anchor correction so the browser does not clamp it to the old height.
      if (virtualContent) virtualContent.style.height = `${instance.getTotalSize()}px`
      elementScroll(offset, options, instance)
    },
    get getItemKey() {
      const rows = timelineRows()
      return (index: number) => {
        const row = rows[index]
        // ResizeObserver can report a removed element after its row has left the projection.
        if (!row) return `removed:${index}`
        return TimelineRow.key(row)
      }
    },
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    get scrollMargin() {
      return showHeader() ? 64 : 0
    },
    overscan: 50,
    paddingEnd: 64,
    rangeExtractor: (range) => {
      const id = activeMessageID()
      const active = id ? (messageLastRowIndex().get(id) ?? -1) : -1
      const indexes = defaultRangeExtractor({ ...range, overscan: renderOverscan() })
      return filterVirtualIndexes(
        [...new Set([...resizePinnedIndexes, ...indexes, ...(active < 0 ? [] : [active])])].sort((a, b) => a - b),
        range.count,
      )
    },
  })
  const resizeItem = virtualizer.resizeItem
  virtualizer.resizeItem = (index, size) => {
    const item = virtualizer.measurementsCache[index]
    const previous = item ? (virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
    const root = listRoot()
    if (root && previous !== undefined && Math.abs(size - previous) > root.clientHeight) {
      const view = root.getBoundingClientRect()
      resizePinnedIndexes = [...root.querySelectorAll<HTMLElement>("[data-index]")]
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.bottom > view.top && rect.top < view.bottom
        })
        .map((element) => Number(element.dataset.index))
      if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
      resizePinFrame = requestAnimationFrame(() => {
        resizePinFrame = requestAnimationFrame(() => {
          resizePinFrame = undefined
          resizePinnedIndexes = []
        })
      })
    }
    resizeItem(index, size)
  }
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= instance.getLogicalScrollOffset()
  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [item.key, item] as const)),
  )
  const virtualRowKeys = createMemo(() => virtualizer.getVirtualItems().map((item) => item.key as string))
  createEffect(() => {
    props.setRevealMessage?.((id) => {
      const index = messageRowIndex().get(id)
      if (index === undefined) return
      virtualizer.scrollToIndex(index, { align: "center" })
    })
    props.setScrollToEnd?.(() => virtualizer.scrollToEnd())
    props.setHistoryAnchor?.({ capture: capturePrependAnchor, restore: restorePrependAnchor })
  })

  // ---- 会话内搜索(cmd+F)。条本身、索引、高亮都在 TimelineSearch 里,只在开着的时候挂载;这里只管开关、
  // "可搜的 part 从上到下是哪些 / 各在第几行",以及跳到一处时要动时间线的那几下(滚动、展开卡片)。
  const command = useCommand()
  const [search, setSearch] = createStore({ open: false, focusTick: 0 })
  command.register("session.search", () => [
    {
      id: "session.search",
      title: language.t("session.search.placeholder"),
      keybind: "mod+f",
      hidden: true,
      onSelect: () => setSearch({ open: true, focusTick: search.focusTick + 1 }),
    },
  ])
  // 可搜的就是画得出来的:照着行收 part,所以顺序 = 屏幕上从上到下,每个 part 都有行号可滚。
  const searchable = createMemo(() => {
    const parts: PartType[] = []
    const where = new Map<string, { row: number; groupKey?: string }>()
    if (!search.open) return { parts, where }
    timelineRows().forEach((row, index) => {
      if (row._tag === "UserMessage") {
        const shown = getMsgParts(row.userMessageID).find((part) =>
          part.type === "task" ? true : part.type === "text" && !part.synthetic,
        )
        if (!shown) return
        parts.push(shown)
        where.set(shown.id, { row: index })
        return
      }
      if (row._tag !== "AssistantPart") return
      for (const ref of groupRefs(row.group)) {
        const part = getMsgPart(ref.messageID, ref.partID)
        if (!part) continue
        parts.push(part)
        where.set(part.id, { row: index, groupKey: row.group.type === "context" ? row.group.key : undefined })
      }
    })
    return { parts, where }
  })
  const revealSearchMatch = (partID: string) => {
    const at = searchable().where.get(partID)
    if (!at) return
    props.onPauseAutoScroll?.()
    // 命中在收着的卡片里:把卡片(和它所在的「已探索」组)打开,字才画得出来、才圈得上。
    if (at.groupKey) setToolOpen(at.groupKey, true)
    // 工具卡和后台任务的通知行都是收着的:正文(输出 / 结果全文)要打开才画得出来。
    const type = searchable().parts.find((part) => part.id === partID)?.type
    if (type === "tool" || type === "task") setToolOpen(partID, true)
    virtualizer.scrollToIndex(at.row, { align: "center" })
  }

  let overscanFrame: number | undefined
  onMount(() => {
    overscanFrame = requestAnimationFrame(() => {
      if (props.shouldAnchorBottom()) virtualizer.scrollToEnd()
      overscanFrame = requestAnimationFrame(() => {
        overscanFrame = undefined
        if (renderOverscan() < 20) setRenderOverscan(20)
        if (props.shouldAnchorBottom()) virtualizer.scrollToEnd()
      })
    })
  })

  let bottomAnchorSessionKey = ""
  let bottomAnchorFrame: number | undefined

  const maybeAnchorBottom = () => {
    const key = sessionKey()
    if (bottomAnchorSessionKey === key) return
    if (timelineRows().length === 0) return
    bottomAnchorSessionKey = key
    if (!props.shouldAnchorBottom()) return
    if (bottomAnchorFrame !== undefined) cancelAnimationFrame(bottomAnchorFrame)
    if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
    clearPrependAnchor()
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    bottomAnchorFrame = requestAnimationFrame(() => {
      bottomAnchorFrame = undefined
      if (sessionKey() !== key) return
      virtualizer.scrollToEnd()
    })
  }

  let measuredSessionKey = sessionKey()
  createEffect(() => {
    const key = sessionKey()
    timelineRows().length
    if (measuredSessionKey !== key) {
      measuredSessionKey = key
      virtualizer.measure()
    }
    maybeAnchorBottom()
  })

  onCleanup(() => {
    clearPrependAnchor()
    timelineCache.delete(ownerSessionKey)
    timelineCache.set(ownerSessionKey, { measurements: virtualizer.takeSnapshot(), toolOpen: { ...toolOpen } })
    while (timelineCache.size > 16) timelineCache.delete(timelineCache.keys().next().value!)
    if (bottomAnchorFrame !== undefined) cancelAnimationFrame(bottomAnchorFrame)
    if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
    if (overscanFrame !== undefined) cancelAnimationFrame(overscanFrame)
    props.setRevealMessage?.(() => {})
    props.setScrollToEnd?.(() => {})
    props.setHistoryAnchor?.({ capture: () => {}, restore: () => {} })
  })

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
  })
  let titleRef: HTMLInputElement | undefined

  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot()) return
    setListRoot(root)
    props.setScrollRef(root)
  }

  const handleListWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    if (!prependLoading) clearPrependAnchor()
    const root = event.currentTarget
    const delta = normalizeWheelDelta({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      rootHeight: root.clientHeight,
    })
    if (!delta) return
    markBoundaryGesture({ root, target: event.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
  }

  const handleListTouchStart = (event: TouchEvent) => {
    if (!prependLoading) clearPrependAnchor()
    touchGesture = event.touches[0]?.clientY
  }

  const handleListTouchMove = (event: TouchEvent & { currentTarget: HTMLDivElement }) => {
    const next = event.touches[0]?.clientY
    const prev = touchGesture
    touchGesture = next
    if (next === undefined || prev === undefined) return

    const delta = prev - next
    if (!delta) return

    markBoundaryGesture({
      root: event.currentTarget,
      target: event.target,
      delta,
      onMarkScrollGesture: props.onMarkScrollGesture,
    })
  }

  const handleListTouchEnd = () => {
    touchGesture = undefined
  }

  const handleListPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!prependLoading) clearPrependAnchor()
    if (event.target !== event.currentTarget) return
    props.onMarkScrollGesture(event.currentTarget)
  }

  const handleListScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (prependLoading) updatePrependAnchor()
    props.onScheduleScrollState(event.currentTarget)
    props.onHistoryScroll()
    if (!props.hasScrollGesture()) return
    props.onUserScroll()
    props.onAutoScrollHandleScroll()
    props.onMarkScrollGesture(event.currentTarget)
  }

  onCleanup(() => {
    props.setScrollRef(undefined)
  })

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const titleMutation = useMutation(() => ({
    mutationFn: (input: { id: string; title: string }) =>
      sdk().client.session.rename(input.id, input.title),
    onSuccess: (_, input) => {
      sync().set(
        produce((draft) => {
          const index = draft.session.findIndex((s) => s.id === input.id)
          if (index !== -1) draft.session[index].title = input.title
        }),
      )
      setTitle("editing", false)
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
        }),
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID()) return
    setTitle({ editing: true, draft: titleLabel() ?? "" })
    requestAnimationFrame(() => {
      if (!titleRef) return
      titleRef.focus()
      titleRef.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle("editing", false)
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const next = title.draft.trim()
    if (!next || next === (titleLabel() ?? "")) {
      setTitle("editing", false)
      return
    }

    titleMutation.mutate({ id, title: next })
  }

  const navigateAfterSessionRemoval = (sessionID: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    if (nextSessionID) {
      navigate(sessionHref(nextSessionID))
      return
    }
    // 没有下一个会话了 —— 开一张草稿页,而不是回那个已经不存在的 /<dir>/session 路由。
    drafts.create({ directory: sdk().directory })
  }

  const deleteSession = async (sessionID: string) => {
    const session = sync().session.get(sessionID)
    if (!session) return false

    const sessions = (sync().data.session ?? []).filter((s) => !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const ok = await sdk()
      .client.session.delete(sessionID)
      .then(() => true)
      .catch((err: unknown) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!ok) return false

    navigateAfterSessionRemoval(sessionID, nextSession?.id)

    sync().set(
      produce((draft) => {
        draft.session = draft.session.filter((s) => s.id !== sessionID)
      }),
    )

    sync().session.evict(sessionID)
    return true
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(
      () => sessionTitle(sync().session.get(props.sessionID)?.title) ?? language.t("command.session.new"),
    )
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <DialogV2 fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("session.delete.title")}
            description={language.t("session.delete.confirm", { name: name() })}
          />
        </DialogHeader>
        <DialogFooter>
          <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 variant="danger" onClick={handleDelete}>
            {language.t("session.delete.button")}
          </ButtonV2>
        </DialogFooter>
      </DialogV2>
    )
  }

  const workingTurn = (userMessageID: string) => sessionStatus().type !== "idle" && activeMessageID() === userMessageID

  const turnDurationMs = (userMessageID: string) => {
    const message = messageByID().get(userMessageID)
    if (!message || message.role !== "user") return
    const end = (assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages).reduce<number | undefined>(
      (max, item) => {
        const completed = item.time.completed
        if (typeof completed !== "number") return max
        if (max === undefined) return completed
        return Math.max(max, completed)
      },
      undefined,
    )
    if (typeof end !== "number") return
    if (end < message.time.created) return
    return end - message.time.created
  }

  const assistantCopyPartID = (userMessageID: string) => {
    if (workingTurn(userMessageID)) return null
    const messages = assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = getMsgParts(message.id)
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || !part.text?.trim()) continue
        return part.id
      }
    }
  }

  const renderAssistantPart = (
    row: Accessor<TimelineRowMap["AssistantPart"]>,
    ref: Accessor<PartRef>,
    onSizeChange?: () => void,
  ) => {
    const message = createMemo(() => messageByID().get(ref().messageID))
    const part = createMemo(() => getMsgPart(ref().messageID, ref().partID))
    const defaultOpen = createMemo(() => {
      const item = part()
      if (!item) return
      return partDefaultOpen(item, settings.general.shellToolPartsExpanded(), settings.general.editToolPartsExpanded())
    })

    return (
      <Show when={message()}>
        {(message) => (
          <Show when={part()}>
            {(part) => (
              <MessagePart
                part={part()}
                message={message()}
                showAssistantCopyPartID={assistantCopyPartID(row().userMessageID)}
                turnDurationMs={turnDurationMs(row().userMessageID)}
                useV2Actions
                defaultOpen={defaultOpen()}
                toolOpen={toolOpen[part().id] ?? defaultOpen()}
                onToolOpenChange={(open) => setToolOpen(part().id, open)}
                deferToolContent
                virtualizeDiff={false}
                onContentRendered={onSizeChange}
              />
            )}
          </Show>
        )}
      </Show>
    )
  }

  const renderAssistantPartGroup = (row: Accessor<TimelineRowMap["AssistantPart"]>, onSizeChange?: () => void) => {
    const refs = createMemo(() => groupRefs(row().group))
    const parts = createMemo(() =>
      refs().flatMap((ref) => {
        const part = getMsgPart(ref.messageID, ref.partID)
        return part?.type === "tool" ? [part] : []
      }),
    )

    // 组的类型跟着 key 走(`part:` / `context:`),同一行不会变;「找东西」的那一行只有一个工具时也走 ContextGroupRow。
    return (
      <Show
        when={row().group.type === "context"}
        fallback={renderAssistantPart(row, () => refs()[0]!, onSizeChange)}
      >
        <ContextGroupRow
          groupKey={row().group.key}
          refs={refs()}
          parts={parts()}
          isOpen={(key) => toolOpen[key]}
          onOpenChange={setToolOpen}
          renderCard={(ref) => renderAssistantPart(row, ref, onSizeChange)}
        />
      </Show>
    )
  }

  function TimelineRowFrame(input: { row: Accessor<FramedTimelineRow>; children: JSX.Element }) {
    const anchor = () => {
      const row = input.row()
      return row._tag === "CommentStrip" || (row._tag === "UserMessage" && row.anchor)
    }
    const previousAssistantPart = () => {
      const row = input.row()
      return row._tag === "AssistantPart" && row.previousAssistantPart
    }

    return (
      <div
        id={anchor() ? props.anchor(input.row().userMessageID) : undefined}
        data-message-id={input.row().userMessageID}
        data-timeline-row={input.row()._tag}
        classList={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-200 2xl:max-w-[1000px]": props.centered,
          "md:mx-auto": props.centered,
          "pt-3": previousAssistantPart(),
        }}
      >
        <div data-component="session-turn" class="min-w-0 w-full relative" style={{ height: "auto" }}>
          {input.children}
        </div>
      </div>
    )
  }

  const renderTimelineRow = (row: Accessor<TimelineRow.TimelineRow>, onSizeChange?: () => void) => {
    switch (row()._tag) {
      case "TurnGap":
        return <div data-timeline-row="TurnGap" aria-hidden="true" class="h-6" />
      case "CommentStrip": {
        const commentStripRow = row as Accessor<TimelineRowByTag<"CommentStrip">>
        const comments = createMemo(() =>
          getMsgParts(commentStripRow().userMessageID).flatMap((part) => MessageComment.fromPart(part) ?? []),
        )
        return (
          <TimelineRowFrame row={commentStripRow}>
            <div class="w-full px-4 md:px-5 pb-2">
              <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                <div class="flex w-max min-w-full justify-end gap-2">
                  <Index each={comments()}>
                    {(comment) => (
                      <div
                        classList={{
                          "shrink-0 max-w-[260px] rounded-[6px] border-[0.5px] border-border-weak-base bg-background-stronger px-2.5 py-2": true,
                        }}
                      >
                        <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                          <FileIcon node={{ path: comment().path, type: "file" }} class="size-3.5 shrink-0" />
                          <span class="truncate">{getFilename(comment().path)}</span>
                          <Show when={comment().selection}>
                            {(selection) => (
                              <span class="shrink-0 text-text-weak">
                                {selection().startLine === selection().endLine
                                  ? `:${selection().startLine}`
                                  : `:${selection().startLine}-${selection().endLine}`}
                              </span>
                            )}
                          </Show>
                        </div>
                        <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                          {comment().comment}
                        </div>
                      </div>
                    )}
                  </Index>
                </div>
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "UserMessage": {
        const userMessageRow = row as Accessor<TimelineRowByTag<"UserMessage">>
        const message = createMemo(() => {
          const m = messageByID().get(userMessageRow().userMessageID)
          if (m?.role === "user") return m
        })
        return (
          <TimelineRowFrame row={userMessageRow}>
            <Show when={message()}>
              {(message) => (
                <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
                  <div data-slot="session-turn-message-content" aria-live="off">
                    <Message
                      message={message()}
                      parts={getMsgParts(userMessageRow().userMessageID)}
                      useV2Actions
                      partOpen={(partID) => toolOpen[partID]}
                      onPartOpenChange={setToolOpen}
                    />
                  </div>
                </div>
              )}
            </Show>
          </TimelineRowFrame>
        )
      }
      case "TurnDivider": {
        const turnDividerRow = row as Accessor<TimelineRowByTag<"TurnDivider">>
        return (
          <TimelineRowFrame row={turnDividerRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-compaction">
                <MessageDivider
                  label={language.t(
                    turnDividerRow().label === "compaction" ? "ui.messagePart.compaction" : "ui.message.interrupted",
                  )}
                />
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "AssistantPart": {
        const assistantPartRow = row as Accessor<TimelineRowByTag<"AssistantPart">>
        return (
          <TimelineRowFrame row={assistantPartRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div
                data-slot="session-turn-assistant-content"
                aria-hidden={workingTurn(assistantPartRow().userMessageID)}
              >
                {renderAssistantPartGroup(assistantPartRow, onSizeChange)}
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "Thinking": {
        const thinkingRow = row as Accessor<TimelineRowByTag<"Thinking">>
        return (
          <TimelineRowFrame row={thinkingRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineThinkingRow
                reasoningHeading={thinkingRow().reasoningHeading}
                showReasoningSummaries={settings.general.showReasoningSummaries()}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Compacting": {
        const compactingRow = row as Accessor<TimelineRowByTag<"Compacting">>
        return (
          <TimelineRowFrame row={compactingRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-thinking" data-compacting>
                <TextShimmer text={language.t("ui.sessionTurn.status.compacting")} />
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "TurnChanges": {
        const changesRow = row as Accessor<TimelineRowByTag<"TurnChanges">>
        const parts = createMemo(() =>
          changesRow().refs.flatMap((ref) => {
            const part = getMsgPart(ref.messageID, ref.partID)
            return part ? [part] : []
          }),
        )
        return (
          <TimelineRowFrame row={changesRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TurnChangesRow
                rowKey={TimelineRow.key(changesRow())}
                parts={parts()}
                directory={sdk().directory}
                isOpen={(key) => toolOpen[key]}
                onOpenChange={setToolOpen}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "ModelRequest": {
        const requestRow = row as Accessor<TimelineRowByTag<"ModelRequest">>
        return (
          <TimelineRowFrame row={requestRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <ModelRequestStatus
                row={requestRow()}
                title={language.t(`session.modelRequest.${requestRow().state}`, {
                  provider: requestRow().providerID,
                  attempt: requestRow().attempt ?? 0,
                  maxAttempts: requestRow().maxAttempts ?? 0,
                })}
              />
            </div>
          </TimelineRowFrame>
        )
      }
    }
  }

  function TimelineRowView(props: { row: TimelineRow.TimelineRow; onSizeChange?: () => void }) {
    return renderTimelineRow(() => props.row, props.onSizeChange)
  }

  function VirtualTimelineRow(props: { rowKey: string }) {
    let element: HTMLDivElement
    const initialItem = virtualItemByKey().get(props.rowKey)!
    const initialRow = timelineRowByKey().get(props.rowKey)!
    const item = createMemo(() => virtualItemByKey().get(props.rowKey) ?? initialItem)
    const row = createMemo(() => timelineRowByKey().get(props.rowKey) ?? initialRow)
    const asyncFile = () => {
      const value = row()
      if (value._tag !== "AssistantPart") return false
      if (value.group.type !== "part") return false
      const part = getMsgPart(value.group.ref.messageID, value.group.ref.partID)
      return part?.type === "tool" && ["edit", "write"].includes(part.tool)
    }
    const [ready, setReady] = createSignal(initialItem.size <= timelineFallbackItemSize || !asyncFile())
    let contentMeasureFrame: number | undefined

    onMount(() => virtualizer.measureElement(element))

    createEffect(
      on(
        () => item().index,
        () => {
          virtualizer.measureElement(element)
        },
        { defer: true },
      ),
    )

    onCleanup(() => {
      if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
    })

    return (
      <div
        data-timeline-key={props.rowKey}
        style={{
          position: "absolute",
          top: `${item().start - (showHeader() ? 64 : 0)}px`,
          left: "0",
          width: "100%",
          height: `${item().size}px`,
          overflow: "clip",
        }}
      >
        <div
          ref={(value) => {
            element = value
          }}
          data-index={item().index}
          style={{ "min-height": ready() ? undefined : `${initialItem.size}px` }}
        >
          <TimelineRowView
            row={row()}
            onSizeChange={() => {
              setReady(true)
              if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
              contentMeasureFrame = scheduleConnectedMeasure(element, virtualizer.measureElement)
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div class="relative w-full h-full min-w-0">
      <Show when={search.open}>
        <div class="contents" style={{ "--timeline-search-top": showHeader() ? "52px" : "8px" }}>
          <TimelineSearch
            parts={searchable().parts}
            rowOf={(partID) => searchable().where.get(partID)?.row}
            firstVisibleRow={() => virtualizer.range?.startIndex ?? 0}
            showReasoning={settings.general.showReasoningSummaries()}
            root={listRoot()}
            partial={props.historyMore ?? false}
            focusTick={search.focusTick}
            onReveal={revealSearchMatch}
            onClose={() => setSearch("open", false)}
          />
        </div>
      </Show>
      <div
        class="absolute left-1/2 -translate-x-1/2 z-[60] pointer-events-none transition-all duration-200 ease-out"
        classList={{
          "bottom-8": true,
          "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump,
          "opacity-0 translate-y-2 pointer-events-none": !props.scroll.overflow || !props.scroll.jump,
          "scale-[0.8]": !props.scroll.overflow || !props.scroll.jump,
        }}
      >
        <button
          type="button"
          aria-label={language.t("session.messages.jumpToLatest")}
          class="pointer-events-auto flex items-center justify-center w-8 h-7 px-2 py-1.5 rounded-lg border-none cursor-pointer text-v2-text-text-base backdrop-blur-[2px]"
          style={{
            background: "color-mix(in srgb, var(--v2-background-bg-base) 92%, transparent)",
            "box-shadow": "var(--v2-elevation-raised), 0px 2px 8px var(--v2-background-bg-base)",
          }}
          onClick={props.onResumeScroll}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M12.3333 8.66665L8 13L3.66667 8.66665M8 12.6667V2.83332"
              stroke="currentColor"
              stroke-linecap="square"
            />
          </svg>
        </button>
      </div>
      <ScrollView
        viewportRef={bindListRoot}
        onWheel={handleListWheel}
        onTouchStart={handleListTouchStart}
        onTouchMove={handleListTouchMove}
        onTouchEnd={handleListTouchEnd}
        onTouchCancel={handleListTouchEnd}
        onPointerDown={handleListPointerDown}
        onScroll={handleListScroll}
        onClick={props.onAutoScrollInteraction}
        class="relative min-w-0 w-full h-full"
        style={{
          "--sticky-accordion-top": showHeader() ? "48px" : "0px",
        }}
      >
        <Show when={showHeader()}>
          <div
            data-session-title
            classList={{
              "sticky top-0 z-30 w-full pb-4 pr-3 pl-2 bg-[linear-gradient(to_bottom,var(--v2-background-bg-base)_48px,transparent)]":
                true,
            }}
          >
            <div class="h-12 w-full flex items-center justify-between gap-2">
              <div
                class="flex items-center gap-1 min-w-0 flex-1"
              >
                {/* 子 agent 的会话:标题前面是「← 主会话 / 类型」,右边是任务状态与停止(没有菜单、没有输入框)。 */}
                <Show when={info()?.parentID}>
                  {(parentID) => (
                    <SubagentBack
                      parentID={parentID()}
                      agent={info()?.agent ?? sync().data.task[sessionID()!]?.agent}
                    />
                  )}
                </Show>
                <div class="flex items-center min-w-0 flex-1 w-full">
                  <Show when={titleLabel() || title.editing}>
                    <Show
                      when={title.editing}
                      fallback={
                        <h1
                          data-slot="session-title-child"
                          classList={{
                            "text-14-medium text-text-strong truncate w-fit rounded-[6px] px-2 py-1 hover:bg-v2-overlay-simple-overlay-hover":
                              true,
                          }}
                          onClick={openTitleEditor}
                        >
                          {titleLabel()}
                        </h1>
                      }
                    >
                      <InlineInput
                        ref={(el) => {
                          titleRef = el
                        }}
                        data-slot="session-title-child"
                        value={title.draft}
                        disabled={titleMutation.isPending}
                        class="text-14-medium text-text-strong block field-sizing-content self-start rounded-[6px] px-2 py-1"
                        style={{ "--inline-input-shadow": "none" }}
                        onInput={(event) => setTitle("draft", event.currentTarget.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void saveTitleEditor()
                            return
                          }
                          if (event.key === "Escape") {
                            event.preventDefault()
                            closeTitleEditor()
                          }
                        }}
                        onBlur={closeTitleEditor}
                      />
                    </Show>
                  </Show>
                </div>
              </div>
              <Show when={sessionID()} keyed>
                {(id) => (
                  <div class="shrink-0 flex items-center gap-2">
                    <Show when={info()?.parentID}>
                      <SubagentStatus sessionID={id} />
                    </Show>
                    <SessionContextUsage placement="bottom" buttonAppearance="v2" />
                    <Show when={!info()?.parentID}>
                      <MenuV2
                        gutter={6}
                        placement="bottom-end"
                        open={title.menuOpen}
                        onOpenChange={(open) => {
                          setTitle("menuOpen", open)
                          if (open) return
                        }}
                      >
                        <MenuV2.Trigger
                          as={IconButtonV2}
                          icon={<IconV2 name="outline-dots" />}
                          variant="ghost-muted"
                          size="large"
                          aria-label={language.t("common.moreOptions")}
                          aria-expanded={title.menuOpen}
                        />
                        <MenuV2.Portal>
                          <MenuV2.Content
                            style={{ width: "120px", "min-width": "120px" }}
                            onCloseAutoFocus={(event) => {
                              if (title.pendingRename) {
                                event.preventDefault()
                                setTitle("pendingRename", false)
                                openTitleEditor()
                              }
                            }}
                          >
                            <MenuV2.Item
                              onSelect={() => {
                                setTitle("pendingRename", true)
                                setTitle("menuOpen", false)
                              }}
                            >
                              {language.t("common.rename")}
                            </MenuV2.Item>
                            <MenuV2.Separator />
                            <MenuV2.Item onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} />)}>
                              {language.t("common.delete")}...
                            </MenuV2.Item>
                          </MenuV2.Content>
                        </MenuV2.Portal>
                      </MenuV2>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
        <div
          data-timeline-virtual-content
          ref={(element) => {
            virtualContent = element
            props.setContentRef(element)
          }}
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
            width: "100%",
          }}
        >
          <For each={virtualRowKeys()}>{(rowKey) => <VirtualTimelineRow rowKey={rowKey} />}</For>
          <Show when={timelineRows().length > 0}>
            <div
              data-timeline-row="bottom-spacer"
              aria-hidden="true"
              class="h-16 absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtualizer.getTotalSize() - 64}px)` }}
            />
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}
