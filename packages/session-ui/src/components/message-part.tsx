import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
  onCleanup,
  Index,
  type JSX,
  type ComponentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import stripAnsi from "strip-ansi"
import { Dynamic } from "solid-js/web"
import {
  AssistantMessage,
  DatasheetSearchHit,
  DatasheetToolDetails,
  FilePart,
  FlashToolDetails,
  GdbToolDetails,
  LogToolDetails,
  Message as MessageType,
  NetlistToolDetails,
  Part as PartType,
  ReasoningPart,
  Stm32ConfigToolDetails,
  TextPart,
  ToolDetails,
  ToolPart,
  UserMessage,
} from "@yoma-desktop/kernel"
import { useData } from "../context"
import { useFileComponent } from "@yoma-desktop/ui/context/file"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { useI18n } from "@yoma-desktop/ui/context/i18n"
import { BasicTool, GenericTool } from "./basic-tool"
import { Accordion } from "@yoma-desktop/ui/accordion"
import { StickyAccordionHeader } from "@yoma-desktop/ui/sticky-accordion-header"
import { Collapsible } from "@yoma-desktop/ui/collapsible"
import { FileIcon } from "@yoma-desktop/ui/file-icon"
import { Icon } from "@yoma-desktop/ui/icon"
import { ToolErrorCard } from "./tool-error-card"
import { DiffChanges } from "@yoma-desktop/ui/diff-changes"
import { Markdown } from "./markdown"
import { ImagePreview } from "@yoma-desktop/ui/image-preview"
import { getDirectory as _getDirectory, getFilename } from "@yoma-desktop/util/path"
import { checksum } from "@yoma-desktop/util/encode"
import { Tooltip } from "@yoma-desktop/ui/tooltip"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { IconButtonV2 } from "@yoma-desktop/ui/v2/icon-button-v2"
import { TooltipV2 } from "@yoma-desktop/ui/v2/tooltip-v2"
import { TextShimmer } from "@yoma-desktop/ui/text-shimmer"
import { AnimatedCountList } from "./tool-count-summary"
import { ToolStatusTitle } from "./tool-status-title"
import { animate } from "motion"
import { attached, kind } from "./message-file"
import { readPartText } from "./message-part-text"

async function writeClipboard(text: string): Promise<boolean> {
  const body = typeof document === "undefined" ? undefined : document.body
  if (body) {
    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    body.removeChild(textarea)
    if (copied) return true
  }

  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(text).then(
    () => true,
    () => false,
  )
}

function ShellSubmessage(props: { text: string; animate?: boolean }) {
  let widthRef: HTMLSpanElement | undefined
  let valueRef: HTMLSpanElement | undefined

  onMount(() => {
    if (!props.animate) return
    requestAnimationFrame(() => {
      if (widthRef) {
        animate(widthRef, { width: "auto" }, { type: "spring", visualDuration: 0.25, bounce: 0 })
      }
      if (valueRef) {
        animate(valueRef, { opacity: 1, filter: "blur(0px)" }, { duration: 0.32, ease: [0.16, 1, 0.3, 1] })
      }
    })
  })

  return (
    <span data-component="shell-submessage">
      <span ref={widthRef} data-slot="shell-submessage-width" style={{ width: props.animate ? "0px" : undefined }}>
        <span data-slot="basic-tool-tool-subtitle">
          <span
            ref={valueRef}
            data-slot="shell-submessage-value"
            style={props.animate ? { opacity: 0, filter: "blur(2px)" } : undefined}
          >
            {props.text}
          </span>
        </span>
      </span>
    </span>
  )
}

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): Diagnostic[] {
  if (!diagnosticsByFile || !filePath) return []
  const diagnostics = diagnosticsByFile[filePath] ?? []
  return diagnostics.filter((d) => d.severity === 1).slice(0, 3)
}

function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  const i18n = useI18n()
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

export interface MessageProps {
  message: MessageType
  parts: PartType[]
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
  useV2Actions?: boolean
}

export interface MessagePartProps {
  part: PartType
  message: MessageType
  hideDetails?: boolean
  defaultOpen?: boolean
  toolOpen?: boolean
  onToolOpenChange?: (open: boolean) => void
  deferToolContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  useV2Actions?: boolean
}

function MessageActionButton(
  props: Pick<ComponentProps<"button">, "disabled" | "onMouseDown" | "onClick" | "aria-label"> & {
    icon: "check" | "copy" | "reset"
    label: JSX.Element
    useV2?: boolean
  },
) {
  return (
    <Show
      when={props.useV2}
      fallback={
        <Tooltip value={props.label} placement="top" gutter={4}>
          <IconButton
            icon={props.icon}
            size="normal"
            variant="ghost"
            disabled={props.disabled}
            onMouseDown={props.onMouseDown}
            onClick={props.onClick}
            aria-label={props["aria-label"]}
          />
        </Tooltip>
      }
    >
      <TooltipV2 value={props.label} placement="top" gutter={4}>
        <IconButtonV2
          icon={<Icon name={props.icon} size="small" />}
          size="normal"
          variant="ghost-muted"
          disabled={props.disabled}
          onMouseDown={props.onMouseDown}
          onClick={props.onClick}
          aria-label={props["aria-label"]}
        />
      </TooltipV2>
    </Show>
  )
}

export type PartComponent = Component<MessagePartProps>

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

const TEXT_RENDER_PACE_MS = 24
const TEXT_RENDER_IMMEDIATE = 512
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/

function step(size: number) {
  if (size <= 12) return 2
  if (size <= 48) return 4
  if (size <= 96) return 8
  return Math.min(256, Math.ceil(size / 4))
}

function next(text: string, start: number) {
  const end = Math.min(text.length, start + step(text.length - start))
  const max = Math.min(text.length, end + 8)
  for (let i = end; i < max; i++) {
    if (TEXT_RENDER_SNAP.test(text[i] ?? "")) return i + 1
  }
  return end
}

function createPacedValue(getValue: () => string, live?: () => boolean) {
  const [value, setValue] = createSignal(getValue())
  let shown = getValue()
  let timeout: ReturnType<typeof setTimeout> | undefined

  const clear = () => {
    if (!timeout) return
    clearTimeout(timeout)
    timeout = undefined
  }

  const sync = (text: string) => {
    shown = text
    setValue(text)
  }

  const run = () => {
    timeout = undefined
    const text = getValue()
    if (!live?.()) {
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length <= shown.length) {
      sync(text)
      return
    }
    if (text.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
      sync(text)
      return
    }
    const end = next(text, shown.length)
    sync(text.slice(0, end))
    if (end < text.length) timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  }

  createEffect(() => {
    const text = getValue()
    if (!live?.()) {
      clear()
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length < shown.length) {
      clear()
      sync(text)
      return
    }
    if (text.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
      clear()
      sync(text)
      return
    }
    if (text.length === shown.length || timeout) return
    timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  })

  onCleanup(() => {
    clear()
  })

  return value
}

function PacedMarkdown(props: { text: string; cacheKey: string; streaming: boolean }) {
  const value = createPacedValue(
    () => props.text,
    () => props.streaming,
  )

  return (
    <Show when={value()}>
      <Markdown text={value()} cacheKey={props.cacheKey} streaming={props.streaming} />
    </Show>
  )
}

function relativizeProjectPath(path: string, directory?: string) {
  if (!path) return ""
  if (!directory) return path
  if (directory === "/") return path
  if (directory === "\\") return path
  if (path === directory) return ""

  const separator = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(separator) ? directory : directory + separator
  if (!path.startsWith(prefix)) return path
  return path.slice(directory.length)
}

function getDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPath(_getDirectory(path), data.directory)
}

import type { IconProps } from "@yoma-desktop/ui/icon"
import { resolveFileDiff } from "./session-diff"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

export function getToolInfo(tool: string, input: any = {}, _metadata?: ToolDetails): ToolInfo {
  const i18n = useI18n()
  switch (tool) {
    case "read":
      return {
        icon: "glasses",
        title: i18n.t("ui.tool.read"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "grep":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.grep"),
        subtitle: input.pattern,
      }
    case "bash":
      return {
        icon: "console",
        title: i18n.t("ui.tool.shell"),
        subtitle: input.command,
      }
    case "edit":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.edit"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "write":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.write"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "stm32config":
      return {
        icon: "settings-gear",
        title: i18n.t("ui.tool.stm32config"),
        subtitle: input.command,
      }
    case "netlist":
      return {
        icon: "providers",
        title: i18n.t("ui.tool.netlist"),
        subtitle: input.part,
      }
    case "flash":
      return {
        icon: "download",
        title: i18n.t("ui.tool.flash"),
        subtitle: input.chip,
      }
    case "datasheet":
      return {
        icon: "review",
        title: i18n.t("ui.tool.datasheet"),
        subtitle: input.chip,
      }
    case "log":
      return {
        icon: "status",
        title: i18n.t("ui.tool.log"),
        subtitle: input.file,
      }
    case "gdb":
      return {
        icon: "debug",
        title: i18n.t("ui.tool.gdb"),
        subtitle: input.connection,
      }
    default:
      return {
        icon: "mcp",
        title: tool,
      }
  }
}

const CONTEXT_GROUP_TOOLS = new Set(["read", "grep"])

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type !== "context") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

export function groupParts(parts: { messageID: string; part: PartType }[]) {
  const result: PartGroup[] = []
  let start = -1

  const flush = (end: number) => {
    if (start < 0) return
    const first = parts[start]
    const last = parts[end]
    if (!first || !last) {
      start = -1
      return
    }
    result.push({
      key: `context:${first.part.id}`,
      type: "context",
      refs: parts.slice(start, end + 1).map((item) => ({
        messageID: item.messageID,
        partID: item.part.id,
      })),
    })
    start = -1
  }

  parts.forEach((item, index) => {
    if (isContextGroupTool(item.part)) {
      if (start < 0) start = index
      return
    }

    flush(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flush(parts.length - 1)
  return result
}

function index<T extends { id: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.id, item] as const))
}

export function renderable(part: PartType, showReasoningSummaries = true) {
  if (part.type === "tool") return true
  if (part.type === "text") return !!part.text?.trim()
  if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
  return !!PART_MAPPING[part.type]
}

function toolDefaultOpen(tool: string, shell = false, edit = false) {
  if (tool === "bash") return shell
  if (tool === "edit" || tool === "write") return edit
}

export function partDefaultOpen(part: PartType, shell = false, edit = false) {
  if (part.type !== "tool") return
  return toolDefaultOpen(part.tool, shell, edit)
}

export function AssistantParts(props: {
  messages: AssistantMessage[]
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  useV2Actions?: boolean
  working?: boolean
  showReasoningSummaries?: boolean
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
}) {
  const data = useData()
  const emptyParts: PartType[] = []
  const emptyTools: ToolPart[] = []
  const msgs = createMemo(() => index(props.messages))
  const part = createMemo(
    () =>
      new Map(
        props.messages.map((message) => [message.id, index(list(data.store.part?.[message.id], emptyParts))] as const),
      ),
  )

  const grouped = createMemo(
    () =>
      groupParts(
        props.messages.flatMap((message) =>
          list(data.store.part?.[message.id], emptyParts)
            .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
            .map((part) => ({
              messageID: message.id,
              part,
            })),
        ),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  const last = createMemo(() => grouped().at(-1)?.key)

  return (
    <Index each={grouped()}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)

        return (
          <Switch>
            <Match when={entryType() === "context"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "context") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.messageID)?.get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isContextGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )
                const busy = createMemo(() => props.working && last() === entryAccessor().key)

                return (
                  <Show when={parts().length > 0}>
                    <ContextToolGroup parts={parts()} busy={busy()} />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const message = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return msgs().get(entry.ref.messageID)
                })
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return part().get(entry.ref.messageID)?.get(entry.ref.partID)
                })

                return (
                  <Show when={message()}>
                    <Show when={item()}>
                      <Part
                        part={item()!}
                        message={message()!}
                        showAssistantCopyPartID={props.showAssistantCopyPartID}
                        turnDurationMs={props.turnDurationMs}
                        useV2Actions={props.useV2Actions}
                        defaultOpen={partDefaultOpen(item()!, props.shellToolDefaultOpen, props.editToolDefaultOpen)}
                      />
                    </Show>
                  </Show>
                )
              })()}
            </Match>
          </Switch>
        )
      }}
    </Index>
  )
}

function isContextGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

function contextToolDetail(part: ToolPart): string | undefined {
  const info = getToolInfo(
    part.tool,
    part.state.input ?? {},
    "metadata" in part.state ? part.state.metadata : undefined,
  )
  if (info.subtitle) return info.subtitle
  if (part.state.status === "error") return part.state.error
  if ((part.state.status === "running" || part.state.status === "completed") && part.state.title)
    return part.state.title
  const description = part.state.input?.description
  if (typeof description === "string") return description
  return undefined
}

function contextToolTrigger(part: ToolPart, i18n: ReturnType<typeof useI18n>) {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  const path = typeof input.path === "string" ? input.path : "/"
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined
  const include = typeof input.include === "string" ? input.include : undefined
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined

  switch (part.tool) {
    case "read": {
      const args: string[] = []
      if (offset !== undefined) args.push("offset=" + offset)
      if (limit !== undefined) args.push("limit=" + limit)
      return {
        title: i18n.t("ui.tool.read"),
        subtitle: filePath ? getFilename(filePath) : "",
        args,
      }
    }
    case "grep": {
      const args: string[] = []
      if (pattern) args.push("pattern=" + pattern)
      if (include) args.push("include=" + include)
      return {
        title: i18n.t("ui.tool.grep"),
        subtitle: getDirectory(path),
        args,
      }
    }
    default: {
      const info = getToolInfo(part.tool, input, "metadata" in part.state ? part.state.metadata : undefined)
      return {
        title: info.title,
        subtitle: info.subtitle || contextToolDetail(part),
        args: [],
      }
    }
  }
}

function contextToolSummary(parts: ToolPart[]) {
  const read = parts.filter((part) => part.tool === "read").length
  const search = parts.filter((part) => part.tool === "grep").length
  return { read, search }
}

export function registerPartComponent(type: string, component: PartComponent) {
  PART_MAPPING[type] = component
}

export function Message(props: MessageProps) {
  return (
    <Switch>
      <Match when={props.message.role === "user" && props.message}>
        {(userMessage) => (
          <UserMessageDisplay
            message={userMessage() as UserMessage}
            parts={props.parts}
            useV2Actions={props.useV2Actions}
          />
        )}
      </Match>
      <Match when={props.message.role === "assistant" && props.message}>
        {(assistantMessage) => (
          <AssistantMessageDisplay
            message={assistantMessage() as AssistantMessage}
            parts={props.parts}
            showAssistantCopyPartID={props.showAssistantCopyPartID}
            showReasoningSummaries={props.showReasoningSummaries}
            useV2Actions={props.useV2Actions}
          />
        )}
      </Match>
    </Switch>
  )
}

export function AssistantMessageDisplay(props: {
  message: AssistantMessage
  parts: PartType[]
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
  useV2Actions?: boolean
}) {
  const emptyTools: ToolPart[] = []
  const part = createMemo(() => index(props.parts))
  const grouped = createMemo(
    () =>
      groupParts(
        props.parts
          .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
          .map((part) => ({
            messageID: props.message.id,
            part,
          })),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  return (
    <Index each={grouped()}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)

        return (
          <Switch>
            <Match when={entryType() === "context"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "context") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isContextGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )

                return (
                  <Show when={parts().length > 0}>
                    <ContextToolGroup parts={parts()} />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return part().get(entry.ref.partID)
                })

                return (
                  <Show when={item()}>
                    <Part
                      part={item()!}
                      message={props.message}
                      showAssistantCopyPartID={props.showAssistantCopyPartID}
                      useV2Actions={props.useV2Actions}
                    />
                  </Show>
                )
              })()}
            </Match>
          </Switch>
        )
      }}
    </Index>
  )
}

export function ContextToolGroup(props: { parts: ToolPart[]; busy?: boolean; onSizeChange?: () => void }) {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const summary = createMemo(() => contextToolSummary(props.parts))
  const handleOpenChange = (value: boolean) => {
    setOpen(value)
    props.onSizeChange?.()
  }

  return (
    <Collapsible
      open={open()}
      onOpenChange={handleOpenChange}
      variant="ghost"
      class="tool-collapsible"
      data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}
    >
      <Collapsible.Trigger>
        <div data-component="context-tool-group-trigger">
          <span
            data-slot="context-tool-group-title"
            class="min-w-0 flex items-center gap-2 text-14-medium text-text-strong"
          >
            <span data-slot="context-tool-group-label" class="shrink-0">
              <ToolStatusTitle
                active={pending()}
                activeText={i18n.t("ui.sessionTurn.status.gatheringContext")}
                doneText={i18n.t("ui.sessionTurn.status.gatheredContext")}
                split={false}
              />
            </span>
            <span
              data-slot="context-tool-group-summary"
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-base"
            >
              <AnimatedCountList
                items={[
                  {
                    key: "read",
                    count: summary().read,
                    one: i18n.t("ui.messagePart.context.read.one"),
                    other: i18n.t("ui.messagePart.context.read.other"),
                  },
                  {
                    key: "search",
                    count: summary().search,
                    one: i18n.t("ui.messagePart.context.search.one"),
                    other: i18n.t("ui.messagePart.context.search.other"),
                  },
                ]}
                fallback=""
              />
            </span>
          </span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div data-component="context-tool-group-list">
          <Index each={props.parts}>
            {(partAccessor) => {
              const trigger = createMemo(() => contextToolTrigger(partAccessor(), i18n))
              const running = createMemo(
                () => partAccessor().state.status === "pending" || partAccessor().state.status === "running",
              )
              return (
                <div data-slot="context-tool-group-item">
                  <div data-component="tool-trigger">
                    <div data-slot="basic-tool-tool-trigger-content">
                      <div data-slot="basic-tool-tool-info">
                        <div data-slot="basic-tool-tool-info-structured">
                          <div data-slot="basic-tool-tool-info-main">
                            <span data-slot="basic-tool-tool-title">
                              <TextShimmer text={trigger().title} active={running()} />
                            </span>
                            <Show when={!running() && trigger().subtitle}>
                              <span data-slot="basic-tool-tool-subtitle">{trigger().subtitle}</span>
                            </Show>
                            <Show when={!running() && trigger().args?.length}>
                              <For each={trigger().args}>
                                {(arg) => <span data-slot="basic-tool-tool-arg">{arg}</span>}
                              </For>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            }}
          </Index>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

export function UserMessageDisplay(props: {
  message: UserMessage
  parts: PartType[]
  useV2Actions?: boolean
}) {
  const data = useData()
  const dialog = useDialog()
  const i18n = useI18n()
  const [state, setState] = createStore({
    copied: false,
  })
  const copied = () => state.copied

  const textPart = createMemo(
    () => props.parts?.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined,
  )

  const text = createMemo(() => textPart()?.text || "")

  const files = createMemo(() => (props.parts?.filter((p) => p.type === "file") as FilePart[]) ?? [])

  const attachments = createMemo(() => files().filter(attached))

  const model = createMemo(() => {
    const providerID = props.message.model?.providerID
    const modelID = props.message.model?.modelID
    if (!providerID || !modelID) return ""
    const match = data.store.provider?.all?.get(providerID)
    return match?.models?.find((item) => item.id === modelID)?.name ?? modelID
  })
  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { timeStyle: "short" }))

  const stamp = createMemo(() => {
    const created = props.message.time?.created
    if (typeof created !== "number") return ""
    return timefmt().format(created)
  })

  const metaHead = model

  const metaTail = stamp

  const openImagePreview = (url: string, alt?: string) => {
    dialog.show(() => <ImagePreview src={url} alt={alt} />)
  }

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    if (await writeClipboard(content)) {
      setState("copied", true)
      setTimeout(() => setState("copied", false), 2000)
    }
  }

  return (
    <div data-component="user-message" data-timeline-part-id={textPart()?.id}>
      <Show when={attachments().length > 0}>
        <div data-slot="user-message-attachments">
          <For each={attachments()}>
            {(file) => {
              const type = kind(file)
              const name = file.filename ?? i18n.t("ui.message.attachment.alt")

              return (
                <div
                  data-slot="user-message-attachment"
                  data-type={type}
                  data-clickable={type === "image" ? "true" : undefined}
                  title={type === "file" ? name : undefined}
                  onClick={() => {
                    if (type === "image") openImagePreview(file.url, name)
                  }}
                >
                  <Show
                    when={type === "image"}
                    fallback={
                      <div data-slot="user-message-attachment-file">
                        <FileIcon node={{ path: name, type: "file" }} />
                        <span data-slot="user-message-attachment-name">{name}</span>
                      </div>
                    }
                  >
                    <img data-slot="user-message-attachment-image" src={file.url} alt={name} />
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
      <Show when={text()}>
        <>
          <div data-slot="user-message-body">
            <div data-slot="user-message-text">
              {text()}
            </div>
          </div>
          <div data-slot="user-message-copy-wrapper">
            <Show when={metaHead() || metaTail()}>
              <span data-slot="user-message-meta-wrap">
                <Show when={metaHead()}>
                  <span data-slot="user-message-meta" class="text-12-regular text-text-weak cursor-default">
                    {metaHead()}
                  </span>
                </Show>
                <Show when={metaHead() && metaTail()}>
                  <span data-slot="user-message-meta-sep" class="text-12-regular text-text-weak cursor-default">
                    {"\u00A0\u00B7\u00A0"}
                  </span>
                </Show>
                <Show when={metaTail()}>
                  <span data-slot="user-message-meta-tail" class="text-12-regular text-text-weak cursor-default">
                    {metaTail()}
                  </span>
                </Show>
              </span>
            </Show>
            <MessageActionButton
              icon={copied() ? "check" : "copy"}
              label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
              useV2={props.useV2Actions}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                void handleCopy()
              }}
              aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
            />
          </div>
        </>
      </Show>
    </div>
  )
}

export function Part(props: MessagePartProps) {
  const component = createMemo(() => PART_MAPPING[props.part.type])
  return (
    <Show when={component()}>
      <Dynamic
        component={component()}
        part={props.part}
        message={props.message}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
        toolOpen={props.toolOpen}
        onToolOpenChange={props.onToolOpenChange}
        deferToolContent={props.deferToolContent}
        virtualizeDiff={props.virtualizeDiff}
        onContentRendered={props.onContentRendered}
        showAssistantCopyPartID={props.showAssistantCopyPartID}
        turnDurationMs={props.turnDurationMs}
        useV2Actions={props.useV2Actions}
      />
    </Show>
  )
}

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  sessionID?: string
  output?: string
  status?: string
  /** 工具返回的附件(目前只有 datasheet view_figure 会带图片)。 */
  attachments?: FilePart[]
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  deferContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  forceOpen?: boolean
  locked?: boolean
}

export type ToolComponent = Component<ToolProps>

const state: Record<
  string,
  {
    name: string
    render?: ToolComponent
  }
> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

export function getTool(name: string) {
  return state[name]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}

function ToolFileAccordion(props: { path: string; actions?: JSX.Element; children: JSX.Element }) {
  const value = createMemo(() => props.path || "tool-file")

  return (
    <Accordion
      multiple
      data-scope="apply-patch"
      style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
      defaultValue={[value()]}
    >
      <Accordion.Item value={value()}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div data-slot="apply-patch-trigger-content">
              <div data-slot="apply-patch-file-info">
                <FileIcon node={{ path: props.path, type: "file" }} />
                <div data-slot="apply-patch-file-name-container">
                  <Show when={props.path.includes("/")}>
                    <span data-slot="apply-patch-directory">{`\u202A${getDirectory(props.path)}\u202C`}</span>
                  </Show>
                  <span data-slot="apply-patch-filename">{getFilename(props.path)}</span>
                </div>
              </div>
              <div data-slot="apply-patch-trigger-actions">
                {props.actions}
                <Icon name="chevron-grabber-vertical" size="small" />
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content>{props.children}</Accordion.Content>
      </Accordion.Item>
    </Accordion>
  )
}

PART_MAPPING["tool"] = function ToolPartDisplay(props) {
  const part = () => props.part as ToolPart

  const emptyInput: Record<string, any> = {}
  const emptyMetadata: Record<string, any> = {}

  const input = () => part().state?.input ?? emptyInput
  // @ts-expect-error
  const partMetadata = () => part().state?.metadata ?? emptyMetadata

  const render = createMemo(() => ToolRegistry.render(part().tool) ?? GenericTool)
  const controlledOpen = () => (props.onToolOpenChange ? (props.toolOpen ?? props.defaultOpen) : undefined)
  const handleToolOpenChange = (open: boolean) => props.onToolOpenChange?.(open)

  return (
    <Show when={true}>
      <div data-component="tool-part-wrapper" data-timeline-part-id={part().id}>
        <Switch>
          <Match when={part().state.status === "error" && (part().state as any).error}>
            {(error) => {
              return (
                <ToolErrorCard
                  tool={part().tool}
                  error={error()}
                  defaultOpen={props.defaultOpen}
                  open={controlledOpen()}
                  onOpenChange={props.onToolOpenChange ? handleToolOpenChange : undefined}
                />
              )
            }}
          </Match>
          <Match when={true}>
            <Dynamic
              component={render()}
              input={input()}
              tool={part().tool}
              sessionID={part().sessionID}
              metadata={partMetadata()}
              // @ts-expect-error
              output={part().state.output}
              // @ts-expect-error
              attachments={part().state.attachments}
              status={part().state.status}
              hideDetails={props.hideDetails}
              defaultOpen={props.defaultOpen}
              open={controlledOpen()}
              onOpenChange={props.onToolOpenChange ? handleToolOpenChange : undefined}
              deferContent={props.deferToolContent}
              virtualizeDiff={props.virtualizeDiff}
              onContentRendered={props.onContentRendered}
            />
          </Match>
        </Switch>
      </div>
    </Show>
  )
}

export function MessageDivider(props: { label: string }) {
  return (
    <div data-component="compaction-part">
      <div data-slot="compaction-part-divider">
        <span data-slot="compaction-part-line" />
        <span data-slot="compaction-part-label" class="text-12-regular text-text-weak">
          {props.label}
        </span>
        <span data-slot="compaction-part-line" />
      </div>
    </div>
  )
}

PART_MAPPING["compaction"] = function CompactionPartDisplay() {
  const i18n = useI18n()
  return <MessageDivider label={i18n.t("ui.messagePart.compaction")} />
}

PART_MAPPING["text"] = function TextPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const numfmt = createMemo(() => new Intl.NumberFormat(i18n.locale()))
  const part = () => props.part as TextPart
  const interrupted = createMemo(
    () =>
      props.message.role === "assistant" && (props.message as AssistantMessage).error?.name === "MessageAbortedError",
  )

  const model = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const message = props.message as AssistantMessage
    const match = data.store.provider?.all?.get(message.providerID)
    return match?.models?.find((item) => item.id === message.modelID)?.name ?? message.modelID
  })

  const duration = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const message = props.message as AssistantMessage
    const completed = message.time.completed
    const ms =
      typeof props.turnDurationMs === "number"
        ? props.turnDurationMs
        : typeof completed === "number"
          ? completed - message.time.created
          : -1
    if (!(ms >= 0)) return ""
    const total = Math.round(ms / 1000)
    if (total < 60) return i18n.t("ui.message.duration.seconds", { count: numfmt().format(total) })
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return i18n.t("ui.message.duration.minutesSeconds", {
      minutes: numfmt().format(minutes),
      seconds: numfmt().format(seconds),
    })
  })

  const meta = createMemo(() => {
    if (props.message.role !== "assistant") return ""
    const items = [model(), duration(), interrupted() ? i18n.t("ui.message.interrupted") : ""]
    return items.filter((x) => !!x).join(" \u00B7 ")
  })

  const streaming = createMemo(
    () => props.message.role === "assistant" && typeof (props.message as AssistantMessage).time.completed !== "number",
  )
  const text = () => readPartText(data.store.part_text_accum_delta, part())
  const isLastTextPart = createMemo(() => {
    const last = (data.store.part?.[props.message.id] ?? [])
      .filter((item): item is TextPart => item?.type === "text" && !!item.text?.trim())
      .at(-1)
    return last?.id === part().id
  })
  const showCopy = createMemo(() => {
    if (props.message.role !== "assistant") return isLastTextPart()
    if (props.showAssistantCopyPartID === null) return false
    if (typeof props.showAssistantCopyPartID === "string") return props.showAssistantCopyPartID === part().id
    return isLastTextPart()
  })
  const [copied, setCopied] = createSignal(false)

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    if (await writeClipboard(content)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <Show when={text()}>
      <div data-component="text-part" data-timeline-part-id={part().id}>
        <div data-slot="text-part-body">
          <Show when={streaming()} fallback={<Markdown text={text()} cacheKey={part().id} streaming={false} />}>
            <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} />
          </Show>
        </div>
        <Show when={showCopy()}>
          <div data-slot="text-part-copy-wrapper" data-interrupted={interrupted() ? "" : undefined}>
            <MessageActionButton
              icon={copied() ? "check" : "copy"}
              label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
              useV2={props.useV2Actions}
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleCopy}
              aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
            />
            <Show when={meta()}>
              <span data-slot="text-part-meta" class="text-12-regular text-text-weak cursor-default">
                {meta()}
              </span>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}

PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const data = useData()
  const part = () => props.part as ReasoningPart
  const streaming = createMemo(
    () => props.message.role === "assistant" && typeof (props.message as AssistantMessage).time.completed !== "number",
  )
  const text = () => readPartText(data.store.part_text_accum_delta, part())

  return (
    <Show when={text()}>
      <div data-component="reasoning-part" data-timeline-part-id={part().id}>
        <Show when={streaming()} fallback={<Markdown text={text()} cacheKey={part().id} streaming={false} />}>
          <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} />
        </Show>
      </div>
    </Show>
  )
}

ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.offset) args.push("offset=" + props.input.offset)
    if (props.input.limit) args.push("limit=" + props.input.limit)
    const loaded = createMemo(() => {
      if (props.status !== "completed") return []
      const value = props.metadata.loaded
      if (!value || !Array.isArray(value)) return []
      return value.filter((p): p is string => typeof p === "string")
    })
    return (
      <>
        <BasicTool
          {...props}
          icon="glasses"
          trigger={{
            title: i18n.t("ui.tool.read"),
            subtitle: props.input.filePath ? getFilename(props.input.filePath) : "",
            args,
          }}
        />
        <For each={loaded()}>
          {(filepath) => (
            <div data-component="tool-loaded-file">
              <Icon name="enter" size="small" />
              <span>
                {i18n.t("ui.tool.loaded")} {relativizeProjectPath(filepath, data.directory)}
              </span>
            </div>
          )}
        </For>
      </>
    )
  },
})

ToolRegistry.register({
  name: "grep",
  render(props) {
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.pattern) args.push("pattern=" + props.input.pattern)
    if (props.input.include) args.push("include=" + props.input.include)
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.grep"),
          subtitle: getDirectory(props.input.path || "/"),
          args,
        }}
      >
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "bash",
  render(props) {
    const i18n = useI18n()
    const pending = () => props.status === "pending" || props.status === "running"
    const sawPending = pending()
    const text = createMemo(() => {
      const cmd = props.input.command ?? props.metadata.command ?? ""
      const out = stripAnsi(props.output || props.metadata.output || "").replace(/\r\n?/g, "\n")
      return `$ ${cmd}${out ? "\n\n" + out : ""}`
    })
    const [copied, setCopied] = createSignal(false)

    const handleCopy = async () => {
      const content = text()
      if (!content) return
      if (await writeClipboard(content)) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    }

    return (
      <BasicTool
        {...props}
        icon="console"
        trigger={(open) => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.shell")} active={pending()} />
              </span>
              <Show when={!pending() && !open() && props.input.command}>
                <ShellSubmessage text={props.input.command} animate={sawPending} />
              </Show>
            </div>
          </div>
        )}
      >
        <div data-component="bash-output">
          <div data-slot="bash-copy">
            <Tooltip
              value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              placement="top"
              gutter={4}
            >
              <IconButton
                icon={copied() ? "check" : "copy"}
                size="small"
                variant="secondary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCopy}
                aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              />
            </Tooltip>
          </div>
          <div data-slot="bash-scroll" data-scrollable>
            <pre data-slot="bash-pre">
              <code>{text()}</code>
            </pre>
          </div>
        </div>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.metadata?.filediff?.file || props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    const diffSource = createMemo(
      () => {
        const filediff = props.metadata?.filediff
        if (!filediff) return
        return {
          file: filediff.file || props.input.filePath || "",
          patch: typeof filediff.patch === "string" ? filediff.patch : undefined,
          before: typeof filediff.before === "string" ? filediff.before : undefined,
          after: typeof filediff.after === "string" ? filediff.after : undefined,
        }
      },
      undefined,
      {
        equals: (a, b) =>
          a?.file === b?.file && a?.patch === b?.patch && a?.before === b?.before && a?.after === b?.after,
      },
    )

    const fileCompProps = createMemo(() => {
      try {
        const source = diffSource()
        if (source) {
          const fileDiff = resolveFileDiff(source)
          if (fileDiff) return { fileDiff, hunkSeparators: fileDiff.isPartial ? "simple" : "line-info-basic" }
        }
      } catch {}

      return {
        before: {
          name: props.metadata?.filediff?.file || props.input.filePath,
          contents: props.metadata?.filediff?.before || props.input.oldString || "",
        },
        after: {
          name: props.metadata?.filediff?.file || props.input.filePath,
          contents: props.metadata?.filediff?.after || props.input.newString || "",
        },
      }
    })

    return (
      <div data-component="edit-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer={props.deferContent !== false}
          trigger={
            <div data-component="edit-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={i18n.t("ui.messagePart.title.edit")} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff} />
                </Show>
              </div>
            </div>
          }
        >
          <Show when={path()}>
            <ToolFileAccordion
              path={path()}
              actions={
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff!} />
                </Show>
              }
            >
              <div data-component="edit-content">
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  virtualize={props.virtualizeDiff}
                  onRendered={props.onContentRendered}
                  {...fileCompProps()}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    return (
      <div data-component="write-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer={props.deferContent !== false}
          trigger={
            <div data-component="write-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <TextShimmer text={i18n.t("ui.messagePart.title.write")} active={pending()} />
                  </span>
                  <Show when={!pending()}>
                    <span data-slot="message-part-title-filename">{filename()}</span>
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">{/* <DiffChanges diff={diff} /> */}</div>
            </div>
          }
        >
          <Show when={props.input.content && path()}>
            <ToolFileAccordion path={path()}>
              <div data-component="write-content">
                <Dynamic
                  component={fileComponent}
                  mode="text"
                  file={{
                    name: props.input.filePath,
                    contents: props.input.content,
                    cacheKey: checksum(props.input.content),
                  }}
                  overflow="scroll"
                  onRendered={props.onContentRendered}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})


ToolRegistry.register({
  name: "stm32config",
  render(props) {
    const i18n = useI18n()
    const metadata = () => props.metadata as Partial<Stm32ConfigToolDetails>
    const command = createMemo(() => metadata().command || props.input.command || "")
    const exitCode = createMemo<number | null>(() =>
      typeof metadata().exitCode === "number" ? (metadata().exitCode as number) : null,
    )
    const failed = createMemo(() => exitCode() !== null && exitCode() !== 0)

    return (
      <BasicTool {...props} icon="settings-gear" trigger={{ title: i18n.t("ui.tool.stm32config"), subtitle: command() }}>
        <Show when={exitCode() !== null}>
          <div data-component="tool-kv">
            <div data-slot="tool-kv-row" data-tone={failed() ? "warning" : undefined}>
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.exitCode")}</span>
              <span data-slot="tool-kv-value">{exitCode()}</span>
            </div>
          </div>
        </Show>
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

const FLASH_DESTRUCTIVE_ACTIONS = new Set(["download", "erase"])
const FLASH_ACTION_KEYS = {
  list: "ui.tool.flash.action.list",
  info: "ui.tool.flash.action.info",
  download: "ui.tool.flash.action.download",
  erase: "ui.tool.flash.action.erase",
  reset: "ui.tool.flash.action.reset",
} as const

ToolRegistry.register({
  name: "flash",
  render(props) {
    const i18n = useI18n()
    const metadata = () => props.metadata as Partial<FlashToolDetails>
    const action = createMemo(() => metadata().action || (props.input.action as string | undefined) || "")
    const chip = createMemo(() => metadata().chip || (props.input.chip as string | undefined) || "")
    const exitCode = createMemo<number | null>(() =>
      typeof metadata().exitCode === "number" ? (metadata().exitCode as number) : null,
    )
    const failed = createMemo(() => exitCode() !== null && exitCode() !== 0)
    const destructive = createMemo(() => FLASH_DESTRUCTIVE_ACTIONS.has(action()))
    const actionLabel = createMemo(() => {
      const value = action()
      const key = FLASH_ACTION_KEYS[value as keyof typeof FLASH_ACTION_KEYS]
      return key ? i18n.t(key) : value
    })
    const subtitle = createMemo(() => [actionLabel(), chip()].filter(Boolean).join(" · "))

    return (
      <div data-component="flash-tool" data-action={action()}>
        <BasicTool
          {...props}
          icon="download"
          trigger={{
            title: i18n.t("ui.tool.flash"),
            subtitle: subtitle(),
            action: (
              <Show when={destructive()}>
                <span data-component="tool-badge" data-tone="danger">
                  {actionLabel()}
                </span>
              </Show>
            ),
          }}
        >
          <div data-component="tool-kv">
            <Show when={chip()}>
              <div data-slot="tool-kv-row">
                <span data-slot="tool-kv-label">{i18n.t("ui.tool.flash.chip")}</span>
                <span data-slot="tool-kv-value">{chip()}</span>
              </div>
            </Show>
            <Show when={exitCode() !== null}>
              <div data-slot="tool-kv-row" data-tone={failed() ? "danger" : undefined}>
                <span data-slot="tool-kv-label">{i18n.t("ui.tool.exitCode")}</span>
                <span data-slot="tool-kv-value">{exitCode()}</span>
              </div>
            </Show>
          </div>
          <Show when={props.output}>
            <div data-component="tool-output" data-scrollable>
              <Markdown text={props.output!} />
            </div>
          </Show>
        </BasicTool>
      </div>
    )
  },
})

const LOG_ACTION_KEYS = {
  start: "ui.tool.log.action.start",
  read: "ui.tool.log.action.read",
  wait: "ui.tool.log.action.wait",
  status: "ui.tool.log.action.status",
  stop: "ui.tool.log.action.stop",
  ports: "ui.tool.log.action.ports",
} as const

ToolRegistry.register({
  name: "log",
  render(props) {
    const i18n = useI18n()
    const metadata = () => props.metadata as Partial<LogToolDetails>
    const action = createMemo(() => metadata().action || (props.input.action as string | undefined) || "")
    const file = createMemo(() => metadata().file || (props.input.file as string | undefined) || "")
    const running = createMemo(() => !!metadata().running)
    const dropped = createMemo(() => metadata().dropped ?? 0)
    const actionLabel = createMemo(() => {
      const value = action()
      const key = LOG_ACTION_KEYS[value as keyof typeof LOG_ACTION_KEYS]
      return key ? i18n.t(key) : value
    })
    const subtitle = createMemo(() => [actionLabel(), file() ? getFilename(file()) : ""].filter(Boolean).join(" · "))

    return (
      <BasicTool
        {...props}
        icon="status"
        trigger={{
          title: i18n.t("ui.tool.log"),
          subtitle: subtitle(),
          action: (
            <span data-component="tool-badge" data-tone={running() ? "positive" : undefined}>
              {running() ? i18n.t("ui.tool.log.running") : i18n.t("ui.tool.log.stopped")}
            </span>
          ),
        }}
      >
        <div data-component="tool-kv">
          <div data-slot="tool-kv-row">
            <span data-slot="tool-kv-label">{i18n.t("ui.tool.log.cursor")}</span>
            <span data-slot="tool-kv-value">{metadata().cursor ?? 0}</span>
          </div>
          <div data-slot="tool-kv-row">
            <span data-slot="tool-kv-label">{i18n.t("ui.tool.log.totalLines")}</span>
            <span data-slot="tool-kv-value">{metadata().totalLines ?? 0}</span>
          </div>
          <div data-slot="tool-kv-row" data-tone={dropped() > 0 ? "warning" : undefined}>
            <span data-slot="tool-kv-label">{i18n.t("ui.tool.log.dropped")}</span>
            <span data-slot="tool-kv-value">{dropped()}</span>
          </div>
          <Show when={action() === "wait" && typeof metadata().matched === "boolean"}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.log.matched")}</span>
              <span data-slot="tool-kv-value">
                {metadata().matched ? i18n.t("ui.tool.log.matched") : i18n.t("ui.tool.log.notMatched")}
              </span>
            </div>
          </Show>
        </div>
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

function ToolFileRow(props: { label: string; path: string }) {
  const [copied, setCopied] = createSignal(false)

  const handleCopy = async () => {
    if (await writeClipboard(props.path)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <button type="button" data-slot="tool-file-row" onClick={() => void handleCopy()}>
      <span data-slot="tool-file-row-label">{props.label}</span>
      <span data-slot="tool-file-row-path">
        <FileIcon node={{ path: props.path, type: "file" }} />
        <Show when={props.path.includes("/")}>
          <span data-slot="tool-file-row-dir">{`‪${getDirectory(props.path)}‬`}</span>
        </Show>
        <span data-slot="tool-file-row-name">{getFilename(props.path)}</span>
      </span>
      <span data-slot="tool-file-row-copy">
        <Icon name={copied() ? "check" : "copy"} size="small" />
      </span>
    </button>
  )
}

const NETLIST_MODE_KEYS = {
  map: "ui.tool.netlist.mode.map",
  board_ir: "ui.tool.netlist.mode.board_ir",
} as const

ToolRegistry.register({
  name: "netlist",
  render(props) {
    const i18n = useI18n()
    const metadata = () => props.metadata as Partial<NetlistToolDetails>
    const mode = createMemo(() => metadata().mode || (props.input.mode as string | undefined) || "")
    const part = createMemo(() => metadata().part || (props.input.part as string | undefined) || "")
    const modeLabel = createMemo(() => {
      const value = mode()
      const key = NETLIST_MODE_KEYS[value as keyof typeof NETLIST_MODE_KEYS]
      return key ? i18n.t(key) : value
    })
    const files = createMemo(() => metadata().files)
    const subtitle = createMemo(() => part() || modeLabel())

    return (
      <BasicTool {...props} icon="providers" trigger={{ title: i18n.t("ui.tool.netlist"), subtitle: subtitle() }}>
        <div data-component="tool-kv">
          <div data-slot="tool-kv-row">
            <span data-slot="tool-kv-label">{i18n.t("ui.tool.netlist")}</span>
            <span data-slot="tool-kv-value">{modeLabel()}</span>
          </div>
          <Show when={part()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.netlist.part")}</span>
              <span data-slot="tool-kv-value">{part()}</span>
            </div>
          </Show>
        </div>
        <Show when={files()}>
          {(value) => (
            <div data-component="tool-file-rows">
              <Show when={value().boardIr}>
                <ToolFileRow label={i18n.t("ui.tool.netlist.file.boardIr")} path={value().boardIr} />
              </Show>
              <Show when={value().stm32Map}>
                <ToolFileRow label={i18n.t("ui.tool.netlist.file.stm32Map")} path={value().stm32Map} />
              </Show>
              <Show when={value().cfgSeed}>
                <ToolFileRow label={i18n.t("ui.tool.netlist.file.cfgSeed")} path={value().cfgSeed} />
              </Show>
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})

const GDB_ACTION_KEYS = {
  start: "ui.tool.gdb.action.start",
  break: "ui.tool.gdb.action.break",
  exec: "ui.tool.gdb.action.exec",
  eval: "ui.tool.gdb.action.eval",
  status: "ui.tool.gdb.action.status",
  stop: "ui.tool.gdb.action.stop",
} as const

const GDB_STATE_KEYS = {
  halted: "ui.tool.gdb.state.halted",
  running: "ui.tool.gdb.state.running",
  exited: "ui.tool.gdb.state.exited",
  "connection-lost": "ui.tool.gdb.state.connection-lost",
  "no-session": "ui.tool.gdb.state.no-session",
} as const

const GDB_STATE_TONE: Record<string, "positive" | "warning" | "danger" | undefined> = {
  halted: "warning",
  running: "positive",
  exited: undefined,
  "connection-lost": "danger",
  "no-session": undefined,
}

ToolRegistry.register({
  name: "gdb",
  render(props) {
    const i18n = useI18n()
    const data = useData()
    const metadata = () => props.metadata as Partial<GdbToolDetails>
    const action = createMemo(() => metadata().action || (props.input.action as string | undefined) || "")
    const state = createMemo(() => metadata().state || "")
    const connection = createMemo(() => metadata().connection || "")
    const path = createMemo(() => metadata().path || "")
    const line = createMemo(() => metadata().firstChangedLine)
    const actionLabel = createMemo(() => {
      const value = action()
      const key = GDB_ACTION_KEYS[value as keyof typeof GDB_ACTION_KEYS]
      return key ? i18n.t(key) : value
    })
    const stateLabel = createMemo(() => {
      const value = state()
      const key = GDB_STATE_KEYS[value as keyof typeof GDB_STATE_KEYS]
      return key ? i18n.t(key) : value
    })
    const stateTone = createMemo(() => GDB_STATE_TONE[state()])
    const subtitle = createMemo(() => [actionLabel(), connection()].filter(Boolean).join(" · "))
    const locationLabel = createMemo(() => {
      const value = path()
      if (!value) return ""
      const name = getFilename(value)
      return line() ? `${name}:${line()}` : name
    })

    return (
      <BasicTool
        {...props}
        icon="debug"
        trigger={{
          title: i18n.t("ui.tool.gdb"),
          subtitle: subtitle(),
          action: (
            <Show when={stateLabel()}>
              <span data-component="tool-badge" data-tone={stateTone()}>
                {stateLabel()}
              </span>
            </Show>
          ),
        }}
      >
        <Show when={path()}>
          <button
            type="button"
            data-component="gdb-location"
            disabled={!data.openFile}
            onClick={(event) => {
              event.stopPropagation()
              data.openFile?.(path(), line())
            }}
          >
            <Icon name="open-file" size="small" />
            <span>
              {i18n.t("ui.tool.gdb.location")} {locationLabel()}
            </span>
          </button>
        </Show>
        <div data-component="tool-kv">
          <Show when={connection()}>
            <div data-slot="tool-kv-row">
              <span data-slot="tool-kv-label">{i18n.t("ui.tool.gdb.connection")}</span>
              <span data-slot="tool-kv-value">{connection()}</span>
            </div>
          </Show>
        </div>
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

const DATASHEET_ACTION_KEYS = {
  search: "ui.tool.datasheet.action.search",
  read_section: "ui.tool.datasheet.action.read_section",
  view_figure: "ui.tool.datasheet.action.view_figure",
} as const

function DatasheetHitRow(props: { hit: DatasheetSearchHit }) {
  return (
    <div data-slot="datasheet-hit">
      <div data-slot="datasheet-hit-head">
        <span data-slot="datasheet-hit-manual">{props.hit.manual_name}</span>
        <Show when={typeof props.hit.page === "number"}>
          <span data-slot="datasheet-hit-page">p.{props.hit.page}</span>
        </Show>
      </div>
      <Show when={props.hit.headings}>
        <span data-slot="datasheet-hit-headings">{props.hit.headings}</span>
      </Show>
    </div>
  )
}

ToolRegistry.register({
  name: "datasheet",
  render(props) {
    const i18n = useI18n()
    const dialog = useDialog()
    const metadata = () => props.metadata as Partial<DatasheetToolDetails>
    const action = createMemo(() => metadata().action || (props.input.action as string | undefined) || "")
    const chip = createMemo(() => metadata().chip || (props.input.chip as string | undefined) || "")
    const hits = createMemo(() => metadata().hits ?? [])
    const actionLabel = createMemo(() => {
      const value = action()
      const key = DATASHEET_ACTION_KEYS[value as keyof typeof DATASHEET_ACTION_KEYS]
      return key ? i18n.t(key) : value
    })
    const subtitle = createMemo(() => {
      if (action() === "read_section" && metadata().heading) return metadata().heading
      return [actionLabel(), chip()].filter(Boolean).join(" · ")
    })
    const attachments = createMemo(() => props.attachments ?? [])
    const linesLabel = createMemo(() => {
      const lines = metadata().lines
      if (!lines || lines.length === 0) return ""
      return lines.length > 1 ? `${lines[0]}-${lines[lines.length - 1]}` : `${lines[0]}`
    })

    const openImage = (url: string, alt?: string) => {
      dialog.show(() => <ImagePreview src={url} alt={alt} />)
    }

    return (
      <BasicTool {...props} icon="review" trigger={{ title: i18n.t("ui.tool.datasheet"), subtitle: subtitle() }}>
        <Switch>
          <Match when={action() === "search"}>
            <div data-component="tool-kv">
              <div data-slot="tool-kv-row">
                <span data-slot="tool-kv-label">{i18n.t("ui.tool.datasheet")}</span>
                <span data-slot="tool-kv-value">
                  {hits().length > 0
                    ? i18n.t(hits().length === 1 ? "ui.tool.datasheet.hits.one" : "ui.tool.datasheet.hits.other", {
                        count: hits().length,
                      })
                    : i18n.t("ui.tool.datasheet.hits.empty")}
                </span>
              </div>
            </div>
            <Show
              when={hits().length > 0}
              fallback={<div data-component="datasheet-empty">{i18n.t("ui.tool.datasheet.hits.empty")}</div>}
            >
              <div data-component="datasheet-hits">
                <For each={hits()}>{(hit) => <DatasheetHitRow hit={hit} />}</For>
              </div>
            </Show>
          </Match>
          <Match when={action() === "read_section"}>
            <div data-component="tool-kv">
              <Show when={metadata().heading}>
                <div data-slot="tool-kv-row">
                  <span data-slot="tool-kv-label">{i18n.t("ui.tool.datasheet.section")}</span>
                  <span data-slot="tool-kv-value">{metadata().heading}</span>
                </div>
              </Show>
              <Show when={linesLabel()}>
                <div data-slot="tool-kv-row">
                  <span data-slot="tool-kv-label">{i18n.t("ui.tool.datasheet.lines", { lines: linesLabel() })}</span>
                  <span data-slot="tool-kv-value" />
                </div>
              </Show>
              <Show when={typeof metadata().chars === "number"}>
                <div data-slot="tool-kv-row">
                  <span data-slot="tool-kv-label">{i18n.t("ui.tool.datasheet.chars", { count: metadata().chars ?? 0 })}</span>
                  <span data-slot="tool-kv-value" />
                </div>
              </Show>
              <Show when={typeof metadata().sections === "number"}>
                <div data-slot="tool-kv-row">
                  <span data-slot="tool-kv-label">
                    {i18n.t("ui.tool.datasheet.sections", { count: metadata().sections ?? 0 })}
                  </span>
                  <span data-slot="tool-kv-value" />
                </div>
              </Show>
              <Show when={metadata().truncated}>
                <div data-slot="tool-kv-row" data-tone="warning">
                  <span data-slot="tool-kv-label">{i18n.t("ui.tool.datasheet.truncated")}</span>
                  <span data-slot="tool-kv-value" />
                </div>
              </Show>
            </div>
          </Match>
          <Match when={action() === "view_figure"}>
            <For each={attachments()}>
              {(file) => (
                <div data-component="datasheet-figure">
                  <img
                    data-slot="datasheet-figure-image"
                    src={file.url}
                    alt={file.filename ?? metadata().heading ?? chip()}
                    onClick={(event) => {
                      event.stopPropagation()
                      openImage(file.url, file.filename)
                    }}
                  />
                  <Show when={typeof metadata().bytes === "number"}>
                    <span data-slot="datasheet-figure-caption">
                      {file.mime} · {metadata().bytes} B
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </Match>
        </Switch>
        <Show when={props.output}>
          <div data-component="tool-output" data-scrollable>
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})
