/**
 * 上下文详情面板。
 *
 * 相对 opencode 少了两块:
 *   - **system prompt 预览** —— opencode 把整段系统提示词挂在 UserMessage.system 上下发,
 *     内核不下发(系统提示词是 host 侧拼的,不进 transcript),于是这块整个删掉,
 *     用量拆分里的 system 段也就恒为 0。
 *   - **revert 过滤** —— 没有 session.revert,消息不会被"回滚"隐藏。
 */

import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { checksum } from "@yoma-desktop/util/encode"
import { same } from "@/utils/same"
import { Icon } from "@yoma-desktop/ui/icon"
import { Accordion } from "@yoma-desktop/ui/accordion"
import { StickyAccordionHeader } from "@yoma-desktop/ui/sticky-accordion-header"
import { File } from "@yoma-desktop/session-ui/file"
import { ScrollView } from "@yoma-desktop/ui/scroll-view"
import type { Message, Part } from "@yoma-desktop/kernel"
import { useLanguage } from "@/context/language"
import { createProviderCatalog } from "@/components/kernel-providers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { getSessionContext, getSessionTokenTotal } from "./session-context-metrics"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import { createSessionContextFormatter } from "./session-context-format"

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

function Stat(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong">{props.value}</div>
    </div>
  )
}

function RawMessageContent(props: { message: Message; getParts: (id: string) => Part[]; onRendered: () => void }) {
  const file = createMemo(() => {
    const parts = props.getParts(props.message.id)
    const contents = JSON.stringify({ message: props.message, parts }, null, 2)
    return {
      name: `${props.message.role}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: Message
  getParts: (id: string) => Part[]
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.message.role} <span class="text-text-base">• {props.message.id}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent message={props.message} getParts={props.getParts} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: Message[] = []

export function SessionContextTab() {
  const sync = useSync()
  const language = useLanguage()
  const providers = createProviderCatalog()
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync().data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const ctx = createMemo(() => getSessionContext(messages(), providers()))
  const tokens = createMemo(() => info()?.tokens)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  const cost = createMemo(() => {
    return usd().format(info()?.cost ?? 0)
  })

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.modelLabel
  })

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.input, messages().length],
      () => {
        const c = ctx()
        if (!c?.input) return []
        return estimateSessionContextBreakdown({
          messages: messages(),
          parts: sync().data.part as Record<string, Part[] | undefined>,
          input: c.input,
        })
      },
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  const stats = [
    { label: "context.stats.session", value: () => info()?.title ?? params.id ?? "—" },
    { label: "context.stats.messages", value: () => counts().all.toLocaleString(language.intl()) },
    { label: "context.stats.provider", value: providerLabel },
    { label: "context.stats.model", value: modelLabel },
    { label: "context.stats.limit", value: () => formatter().number(ctx()?.limit) },
    { label: "context.stats.totalTokens", value: () => formatter().number(getSessionTokenTotal(tokens())) },
    { label: "context.stats.usage", value: () => formatter().percent(ctx()?.usage) },
    { label: "context.stats.inputTokens", value: () => formatter().number(tokens()?.input) },
    { label: "context.stats.outputTokens", value: () => formatter().number(tokens()?.output) },
    { label: "context.stats.reasoningTokens", value: () => formatter().number(tokens()?.reasoning) },
    {
      label: "context.stats.cacheTokens",
      value: () => `${formatter().number(tokens()?.cache.read)} / ${formatter().number(tokens()?.cache.write)}`,
    },
    { label: "context.stats.userMessages", value: () => counts().user.toLocaleString(language.intl()) },
    { label: "context.stats.assistantMessages", value: () => counts().assistant.toLocaleString(language.intl()) },
    { label: "context.stats.totalCost", value: cost },
    { label: "context.stats.sessionCreated", value: () => formatter().time(info()?.time.created) },
    { label: "context.stats.lastActivity", value: () => formatter().time(ctx()?.message.time.created) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined
  const getParts = (id: string) => (sync().data.part[id] ?? []) as Part[]

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 pb-10 flex flex-col gap-10">
        <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
          <For each={stats}>
            {(stat) => <Stat label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />}
          </For>
        </div>

        <Show when={breakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("context.breakdown.title")}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={breakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": BREAKDOWN_COLOR[segment.key],
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={breakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
                    <div>{breakdownLabel(segment.key)}</div>
                    <div class="text-text-weaker">{segment.percent.toLocaleString(language.intl())}%</div>
                  </div>
                )}
              </For>
            </div>
            <div class="hidden text-11-regular text-text-weaker">{language.t("context.breakdown.note")}</div>
          </div>
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("context.rawMessages.title")}</div>
          <Accordion multiple>
            <For each={messages()}>
              {(message) => (
                <RawMessage message={message} getParts={getParts} onRendered={restoreScroll} time={formatter().time} />
              )}
            </For>
          </Accordion>
        </div>
      </div>
    </ScrollView>
  )
}
