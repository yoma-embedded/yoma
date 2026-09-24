import {
  createEffect,
  createMemo,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  type Accessor,
  type JSX,
} from "solid-js"
import { animate, type AnimationPlaybackControls } from "motion"
import { useI18n } from "@yoma-desktop/ui/context/i18n"
import { createStore } from "solid-js/store"
import { Collapsible } from "@yoma-desktop/ui/collapsible"
import type { IconProps } from "@yoma-desktop/ui/icon"
import { TextShimmer } from "@yoma-desktop/ui/text-shimmer"
import type { ToolProps } from "./message-part"
import { formatToolDuration, toolElapsed, useSecondTicker } from "./tool-duration"
import { toolArguments, toolCommand, toolSummary } from "./tool-summary"

export type TriggerTitle = {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  args?: string[]
  argsClass?: string
  action?: JSX.Element
}

const isTriggerTitle = (val: any): val is TriggerTitle => {
  return (
    typeof val === "object" && val !== null && "title" in val && (typeof Node === "undefined" || !(val instanceof Node))
  )
}

export interface BasicToolProps {
  icon: IconProps["name"]
  trigger: TriggerTitle | JSX.Element | ((open: Accessor<boolean>) => JSX.Element)
  children?: JSX.Element
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  forceOpen?: boolean
  defer?: boolean
  locked?: boolean
  animated?: boolean
  onSubtitleClick?: () => void
  onTriggerClick?: JSX.EventHandlerUnion<HTMLElement, MouseEvent>
  triggerHref?: string
  clickable?: boolean
  /** 紧凑工具行的皮(`data-tool-row`,通用卡用;硬件卡与 agent 卡不传,样子不变)。 */
  row?: boolean
  /** 紧凑行按状态着色(`data-tone`):ok / error / interrupted / running / pending。 */
  tone?: string
  /**
   * pending / running 时照样画副标题与 action。缺省藏起来(参数还没拼完时没东西可看);通用卡要显示:
   * 命令在模型写完这个调用时就完整了,而一条跑几十秒的命令从头到尾只剩一个工具名,看着就像卡住了。
   */
  revealWhilePending?: boolean
}

const SPRING = { type: "spring" as const, visualDuration: 0.35, bounce: 0 }
const deferredMounts: Array<{ active: boolean; fn: () => void }> = []
let deferredFrame: number | undefined

function flushDeferredMounts() {
  while (deferredMounts.length > 0) {
    // Timeline tools are mounted top-to-bottom, but the viewport starts at the latest turn.
    // Pop from the end so heavy default-open bodies near the bottom become interactive first.
    const item = deferredMounts.pop()!
    if (item.active) {
      deferredFrame = deferredMounts.length > 0 ? requestAnimationFrame(flushDeferredMounts) : undefined
      item.fn()
      return
    }
  }
  deferredFrame = undefined
}

function scheduleDeferredFlush() {
  if (deferredFrame !== undefined) return
  deferredFrame = requestAnimationFrame(() => {
    deferredFrame = requestAnimationFrame(flushDeferredMounts)
  })
}

function scheduleDeferredMount(fn: () => void) {
  const item = { active: true, fn }
  deferredMounts.push(item)
  scheduleDeferredFlush()
  return () => {
    item.active = false
  }
}

function scheduleFrameMount(fn: () => void) {
  const frame = requestAnimationFrame(fn)
  return () => cancelAnimationFrame(frame)
}

export function BasicTool(props: BasicToolProps) {
  const [state, setState] = createStore({
    open: props.defaultOpen ?? false,
    ready: !props.defer && (props.defaultOpen ?? false),
  })
  const open = () => props.open ?? state.open
  const ready = () => state.ready
  const pending = () => props.status === "pending" || props.status === "running"
  const hasChildren = () => (props.defer ? "children" in props : props.children)
  const dynamicTrigger = typeof props.trigger === "function" ? props.trigger(open) : undefined

  let cancelReady: (() => void) | undefined

  const cancel = () => {
    cancelReady?.()
    cancelReady = undefined
  }

  const scheduleReady = (initial = false) => {
    cancel()
    cancelReady = (initial ? scheduleDeferredMount : scheduleFrameMount)(() => {
      cancelReady = undefined
      if (!open()) return
      setState("ready", true)
    })
  }

  onCleanup(cancel)

  onMount(() => {
    if (props.defer && open()) scheduleReady(true)
  })

  const setOpen = (value: boolean) => {
    if (props.open === undefined) setState("open", value)
    props.onOpenChange?.(value)
  }

  createEffect(() => {
    if (!props.forceOpen) return
    if (open()) return
    setOpen(true)
  })

  createEffect(
    on(
      open,
      (value) => {
        if (!props.defer) return
        if (!value) {
          cancel()
          setState("ready", false)
          return
        }

        scheduleReady()
      },
      { defer: true },
    ),
  )

  // Animated height for collapsible open/close
  let contentRef: HTMLDivElement | undefined
  let heightAnim: AnimationPlaybackControls | undefined
  const initialOpen = open()

  createEffect(
    on(
      open,
      (isOpen) => {
        if (!props.animated || !contentRef) return
        heightAnim?.stop()
        if (isOpen) {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "auto" }, SPRING)
          void heightAnim.finished.then(() => {
            if (!contentRef || !open()) return
            contentRef.style.overflow = "visible"
            contentRef.style.height = "auto"
          })
        } else {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "0px" }, SPRING)
        }
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    heightAnim?.stop()
  })

  // running 态可以展开:走进度通道的工具(bash / flash / powershell)边跑边有输出,用户要看烧录器
  // 此刻打到第几段。pending 仍锁着 —— 参数还没拼完,没有任何东西可看。
  const handleOpenChange = (value: boolean) => {
    if (props.status === "pending") return
    if (props.locked && !value) return
    setOpen(value)
  }

  const trigger = () => (
    <div
      data-component="tool-trigger"
      data-clickable={props.clickable ? "true" : undefined}
      data-hide-details={props.hideDetails ? "true" : undefined}
    >
      <div data-slot="basic-tool-tool-trigger-content">
        <div data-slot="basic-tool-tool-info">
          <Switch>
            <Match when={dynamicTrigger !== undefined}>{dynamicTrigger}</Match>
            <Match when={isTriggerTitle(props.trigger) && props.trigger}>
              {(title) => (
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span
                      data-slot="basic-tool-tool-title"
                      classList={{
                        [title().titleClass ?? ""]: !!title().titleClass,
                      }}
                    >
                      <TextShimmer text={title().title} active={pending()} />
                    </span>
                    <Show when={!pending() || props.revealWhilePending}>
                      <Show when={title().subtitle}>
                        <span
                          data-slot="basic-tool-tool-subtitle"
                          classList={{
                            [title().subtitleClass ?? ""]: !!title().subtitleClass,
                            clickable: !!props.onSubtitleClick,
                          }}
                          onClick={(e) => {
                            if (props.onSubtitleClick) {
                              e.stopPropagation()
                              props.onSubtitleClick()
                            }
                          }}
                        >
                          {title().subtitle}
                        </span>
                      </Show>
                      <Show when={title().args?.length}>
                        <For each={title().args}>
                          {(arg) => (
                            <span
                              data-slot="basic-tool-tool-arg"
                              classList={{
                                [title().argsClass ?? ""]: !!title().argsClass,
                              }}
                            >
                              {arg}
                            </span>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </div>
                  <Show when={(!pending() || props.revealWhilePending) && title().action}>
                    <span data-slot="basic-tool-tool-action">{title().action}</span>
                  </Show>
                </div>
              )}
            </Match>
            <Match when={true}>{props.trigger as JSX.Element}</Match>
          </Switch>
        </div>
      </div>
      <Show when={hasChildren() && !props.hideDetails && !props.locked && props.status !== "pending"}>
        <Collapsible.Arrow />
      </Show>
    </div>
  )

  return (
    <Collapsible
      open={open()}
      onOpenChange={handleOpenChange}
      class="tool-collapsible"
      data-tool-row={props.row ? "" : undefined}
      data-tone={props.row ? props.tone : undefined}
    >
      <Show
        when={props.triggerHref}
        fallback={
          <Collapsible.Trigger
            data-hide-details={props.hideDetails ? "true" : undefined}
            onClick={props.onTriggerClick}
          >
            {trigger()}
          </Collapsible.Trigger>
        }
      >
        {(href) => (
          <Collapsible.Trigger
            as="a"
            href={href()}
            data-hide-details={props.hideDetails ? "true" : undefined}
            onClick={props.onTriggerClick}
          >
            {trigger()}
          </Collapsible.Trigger>
        )}
      </Show>
      <Show when={props.animated && hasChildren() && !props.hideDetails}>
        <div
          ref={contentRef}
          data-slot="collapsible-content"
          data-animated
          style={{
            height: initialOpen ? "auto" : "0px",
            overflow: initialOpen ? "visible" : "hidden",
          }}
        >
          <Show when={!props.defer || ready()}>{props.children}</Show>
        </div>
      </Show>
      <Show when={!props.animated && hasChildren() && !props.hideDetails}>
        <Collapsible.Content>
          <Show when={!props.defer || ready()}>{props.children}</Show>
        </Collapsible.Content>
      </Show>
    </Collapsible>
  )
}

/** 紧凑行按状态着色。`interrupted` 不是内核的状态:这一轮已经结束、它还没结果(见 `ToolPartDisplay`)。 */
function toolTone(status: string | undefined) {
  if (status === "completed") return "ok"
  if (status === "error") return "error"
  if (status === "interrupted") return "interrupted"
  if (status === "running") return "running"
  return "pending"
}

/** 跑着的那一格:共享秒表每秒走一次。 */
function RunningElapsed(props: { start?: number }) {
  const now = useSecondTicker()
  const text = () => formatToolDuration(toolElapsed({ start: props.start }, now()) ?? Number.NaN)
  return (
    <Show when={text()}>
      <span data-slot="tool-row-duration">{text()}</span>
    </Show>
  )
}

/** 紧凑行右边那一格:耗时(跑着的每秒走一格),或者「未完成」。 */
function ToolRowMeta(props: { status?: string; time?: { start?: number; end?: number } }) {
  const i18n = useI18n()
  const finished = () => formatToolDuration(toolElapsed(props.time, Date.now()) ?? Number.NaN)
  return (
    <Switch>
      <Match when={props.status === "interrupted"}>
        <span data-slot="tool-row-flag">{i18n.t("ui.basicTool.interrupted")}</span>
      </Match>
      <Match when={props.status === "running"}>
        <RunningElapsed start={props.time?.start} />
      </Match>
      <Match when={(props.status === "completed" || props.status === "error") && finished()}>
        <span data-slot="tool-row-duration">{finished()}</span>
      </Match>
    </Switch>
  )
}

/**
 * 展开之后:先是完整参数(命令类整段,别的逐条列顶层参数),再是输出,失败时是报错全文。顺序与会话内查找的
 * 「可搜的字」一致(工具名 → 参数 → 输出 / 报错),查得到的字展开后都画得出来。
 */
function ToolRowBody(props: {
  tool: string
  input: Record<string, unknown>
  output: string
  error: string
  status?: string
}) {
  const i18n = useI18n()
  const command = createMemo(() => toolCommand(props.tool, props.input))
  const args = createMemo(() =>
    toolArguments(props.input).filter((arg) => command() === undefined || arg.key !== "command"),
  )
  return (
    <div data-component="tool-row-body">
      <Show when={command()}>{(value) => <pre data-slot="tool-row-command">{value()}</pre>}</Show>
      <Show when={args().length > 0}>
        <div data-slot="tool-row-args" data-scrollable>
          <For each={args()}>
            {(arg) => (
              <div data-slot="tool-row-arg">
                <span data-slot="tool-row-arg-key">{arg.key}</span>
                <span data-slot="tool-row-arg-value">{arg.value}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.output}>
        <div data-component="tool-output" data-scrollable>
          <pre>{props.output}</pre>
        </div>
      </Show>
      <Show when={props.error}>
        <pre data-slot="tool-row-error" data-scrollable>
          {props.error}
        </pre>
      </Show>
      <Show when={props.status === "interrupted"}>
        <div data-slot="tool-row-note">{i18n.t("ui.basicTool.interruptedNote")}</div>
      </Show>
    </div>
  )
}

/**
 * 通用卡 = 一行紧凑的工具行(照 pi-agent-desktop 的样子):工具名 + 摘要 + 右边的耗时,按状态着色。
 * 没有专用卡的工具都走它(bash / read / edit / write / grep / find / ls / powershell / datasheet …),**失败的也走它**
 * (从前失败的走 `ToolErrorCard`,标题是「Shell」、副标题是报错切出来的一段,命令整个看不见)。
 * 硬件卡在 details 认不出时也会回落到这里。
 */
export function GenericTool(props: ToolProps) {
  const output = () => (typeof props.output === "string" ? props.output : "")
  const error = () => (typeof props.error === "string" ? props.error.replace(/^Error:\s*/, "").trim() : "")
  const summary = createMemo(() => toolSummary(props.tool, props.input))
  // 只建一份:标题对象每次读都是新的,action 若写在里面,每读一次就多建一个组件。
  const meta = <ToolRowMeta status={props.status} time={props.time} />

  return (
    <BasicTool
      {...props}
      // 永远延迟挂载展开态:不 defer 的话 BasicTool 判断「有没有内容」时要读 children,而 children 是个 getter,
      // 每读一次就多建一份没人看的 ToolRowBody(连同整段输出),输出每涨一次就重建一次。收着的行一份都不建。
      defer
      icon="mcp"
      row
      tone={toolTone(props.status)}
      revealWhilePending
      trigger={{
        title: props.tool,
        subtitle: summary() || undefined,
        action: meta,
      }}
    >
      <ToolRowBody tool={props.tool} input={props.input} output={output()} error={error()} status={props.status} />
    </BasicTool>
  )
}
