/**
 * 子 agent 的两张卡(docs/子agent-设计方案-v0.4-20260918.md §7):
 *
 * - **agent 卡片**:一次 `agent` 工具调用。折叠态 `● 子 agent [Explore] 查时钟树   5 次工具调用 · 4.2 s`;
 *   展开态是任务书、结果(markdown)、运行数据,以及「打开子会话 / 转到后台 / 停止」三颗图标按钮。
 *   灯跟着**实时任务**走(Data 上下文的 `store.task`):后台派出的子 agent 在工具调用交回之后还在跑,
 *   只有那一份知道"现在"。
 * - **通知行**:后台子 agent 完成后回到主会话的那条通知(synthetic user 消息上的 `task` part)。一行状态 + 可展开的结果。
 *
 * **外壳是自己的**(2026-09-20 起,见 agent-tool.css 文件头):从前整套借硬件卡的仪器皮(hw-tool / bench),
 * 那身衣服是给示波器和逻辑分析仪做的。折叠行、展开分块、认不出回落通用卡这几条规矩照旧,
 * 折叠/动画/延迟挂载仍走通用的 `BasicTool` —— 换掉的只是皮。
 *
 * 三个按钮都由宿主给回调(Data 上下文),不给就一个像素都不渲染 —— 同「在面板中打开」的规矩。
 */
import { createMemo, Show, type JSX, type ParentProps } from "solid-js"
import type { TaskNotificationPart } from "@yoma-desktop/kernel"
import { Icon, type IconProps } from "@yoma-desktop/ui/icon"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { useI18n } from "@yoma-desktop/ui/context/i18n"
import { useData } from "../context"
import { describeAgent, type AgentCard, type AgentCardState } from "./agent-card"
import { BasicTool, GenericTool } from "./basic-tool"
import { formatCount, formatElapsed, shortPath } from "./hw-format"
import { Markdown } from "./markdown"
import type { MessagePartProps, ToolProps } from "./message-part"

/**
 * 收场的三种状态用真图标,在跑 / 排队 / 后台用一颗点(在跑的会呼吸)。
 * 从前这里是 `✓` / `✗` / `■` 三个字面字符拼在状态词前面 —— 那是打上去的,不是画上去的。
 */
const STATE_ICON: Partial<Record<AgentCardState, IconProps["name"]>> = {
  completed: "circle-check",
  failed: "circle-x",
  killed: "stop",
}

type Translate = ReturnType<typeof useI18n>["t"]

/** 进度那半句:`5 次工具调用 · 最近 grep · 4.2 s`。没有的项不出。 */
function progressText(t: Translate, card: Pick<AgentCard, "toolUses" | "lastTool" | "durationMs">): string {
  return [
    card.toolUses !== undefined ? t("ui.tool.agent.toolUses", { count: card.toolUses }) : undefined,
    card.lastTool ? t("ui.tool.agent.last", { tool: card.lastTool }) : undefined,
    formatElapsed(card.durationMs),
  ]
    .filter(Boolean)
    .join(" · ")
}

function stateWord(t: Translate, state: AgentCardState): string | undefined {
  switch (state) {
    case "pending":
      return t("ui.tool.agent.state.pending")
    case "background":
      return t("ui.tool.agent.state.background")
    case "completed":
      return t("ui.tool.agent.state.completed")
    case "failed":
      return t("ui.tool.agent.state.failed")
    case "killed":
      return t("ui.tool.agent.state.killed")
    default:
      return undefined
  }
}

function conclusionOf(t: Translate, card: AgentCard): string | undefined {
  if (card.state === "launching") return undefined
  const progress = progressText(t, card)
  if (card.state === "running") return progress || t("ui.tool.agent.state.running")
  const parts = [
    stateWord(t, card.state),
    card.state === "pending" || card.state === "background" ? undefined : progress,
  ]
  if (card.maxTurnsReached) parts.push(t("ui.tool.agent.maxTurns"))
  return parts.filter(Boolean).join(" · ")
}

interface AgentTrigger {
  state: AgentCardState
  /** agent 类型(`Explore` / `general-purpose`)。画成名牌,不是一段文字。 */
  agent: string
  /** 这一次派它干的事。挤不下时先截它 —— 结论才是这张卡片存在的理由。 */
  description?: string
  /** 一句结论,按状态着色。 */
  conclusion?: string
}

/** 折叠态那一行。 */
function AgentTriggerRow(props: { model: AgentTrigger; pending?: boolean }) {
  const i18n = useI18n()
  const state = () => (props.pending ? "launching" : props.model.state)
  const icon = () => STATE_ICON[state()]
  return (
    <div data-component="agent-trigger" data-state={state()}>
      <Show when={icon()} fallback={<span data-slot="dot" aria-hidden="true" />}>
        {(name) => (
          <span data-slot="state-icon" aria-hidden="true">
            <Icon name={name()} size="small" />
          </span>
        )}
      </Show>
      <span data-slot="label">{i18n.t("ui.tool.agent.label")}</span>
      <span data-slot="agent">{props.model.agent}</span>
      <Show when={props.model.description}>
        <span data-slot="task">{props.model.description}</span>
      </Show>
      <Show when={props.model.conclusion && !props.pending}>
        <span data-slot="facts">{props.model.conclusion}</span>
      </Show>
    </div>
  )
}

/** 展开态里的一块:小号大写的名牌 + 内容。没有发丝线 —— 那是仪器面板的刻度语言。 */
function AgentSection(props: ParentProps<{ title: string }>) {
  return (
    <section data-component="agent-section">
      <div data-slot="head">{props.title}</div>
      {props.children}
    </section>
  )
}

/** 键在上值在下的小格子。没有 leader 点线。 */
function AgentFact(props: { k: string; v: string; wide?: boolean; title?: string }) {
  return (
    <div data-component="agent-fact" data-wide={props.wide ? "" : undefined}>
      <span data-slot="k">{props.k}</span>
      <span data-slot="v" title={props.title ?? props.v}>
        {props.v}
      </span>
    </div>
  )
}

/** 一颗带说明气泡的图标按钮。气泡是纯 CSS 的(icon-tip.css),不跑 JS。 */
function AgentAction(props: {
  icon: IconProps["name"]
  label: string
  tone?: "danger"
  onClick: () => void
}) {
  return (
    <span data-tip={props.label} data-tone={props.tone}>
      <IconButton
        icon={props.icon}
        size="small"
        variant="ghost"
        aria-label={props.label}
        onClick={props.onClick}
      />
    </span>
  )
}

/**
 * 「打开子会话 / 转到后台 / 停止」。宿主没给的回调就没有那颗按钮;一个都没有就整行不出。
 * 从前是三个并排的文字按钮,一行占掉半张卡。
 */
function AgentActions(props: { taskID?: string; state: AgentCardState; background: boolean }) {
  const i18n = useI18n()
  const data = useData()
  const active = () => props.state === "pending" || props.state === "running"
  const open = () => (props.taskID && data.navigateToSession ? data.navigateToSession : undefined)
  const toBackground = () => (props.taskID && active() && !props.background ? data.backgroundTask : undefined)
  const stop = () => (props.taskID && active() ? data.stopTask : undefined)
  return (
    <Show when={open() || toBackground() || stop()}>
      <div data-component="agent-actions">
        <Show when={open()}>
          {(go) => (
            <AgentAction
              icon="square-arrow-top-right"
              label={i18n.t("ui.tool.agent.open")}
              onClick={() => go()(props.taskID!)}
            />
          )}
        </Show>
        <Show when={toBackground()}>
          {(move) => (
            <AgentAction
              icon="arrow-down-to-line"
              label={i18n.t("ui.tool.agent.background")}
              onClick={() => move()(props.taskID!)}
            />
          )}
        </Show>
        <Show when={stop()}>
          {(halt) => (
            <AgentAction
              icon="stop"
              tone="danger"
              label={i18n.t("ui.tool.agent.stop")}
              onClick={() => halt()(props.taskID!)}
            />
          )}
        </Show>
      </div>
    </Show>
  )
}

/** 一张 agent 卡。折叠/动画/延迟挂载走通用的 BasicTool,皮是自己的。 */
function AgentShell(props: ToolProps & { trigger: AgentTrigger; children?: JSX.Element }) {
  const pending = () => props.status === "pending"
  return (
    <BasicTool
      {...props}
      defer={props.deferContent}
      icon="mcp"
      trigger={<AgentTriggerRow model={props.trigger} pending={pending()} />}
    >
      <div data-component="agent-body">{props.children}</div>
    </BasicTool>
  )
}

export function AgentTool(props: ToolProps) {
  const i18n = useI18n()
  const data = useData()
  const live = () => {
    const id = props.metadata?.taskID
    return typeof id === "string" ? data.store.task?.[id] : undefined
  }
  const card = createMemo(() => describeAgent(props.input, props.metadata, props.output, props.status, live()))

  return (
    <Show when={card()} fallback={<GenericTool {...props} />}>
      {(hit) => (
        <AgentShell
          {...props}
          trigger={{
            state: hit().state,
            agent: hit().agent,
            description: hit().description,
            conclusion: conclusionOf(i18n.t, hit()),
          }}
        >
          <Show when={hit().prompt}>
            <AgentSection title={i18n.t("ui.tool.agent.prompt")}>
              <pre data-component="agent-prompt">{hit().prompt}</pre>
            </AgentSection>
          </Show>

          <Show
            when={hit().result}
            fallback={
              <Show
                when={
                  hit().emptyResult || hit().state === "background" || (hit().background && hit().state === "running")
                }
              >
                <div data-component="agent-note">
                  {hit().emptyResult
                    ? i18n.t("ui.tool.agent.noResult")
                    : hit().state === "background"
                      ? i18n.t("ui.tool.agent.detached")
                      : i18n.t("ui.tool.agent.inBackground")}
                </div>
              </Show>
            }
          >
            {(result) => (
              <AgentSection title={i18n.t("ui.tool.agent.result")}>
                <div data-component="agent-result">
                  <Markdown
                    text={result()}
                    cacheKey={`agent-result:${hit().taskID ?? hit().description}`}
                    streaming={false}
                  />
                </div>
              </AgentSection>
            )}
          </Show>

          <AgentSection title={i18n.t("ui.tool.agent.facts")}>
            <div data-component="agent-facts">
              <AgentFact k={i18n.t("ui.tool.agent.readout.agent")} v={hit().agent} />
              <Show when={hit().turns !== undefined}>
                <AgentFact k={i18n.t("ui.tool.agent.readout.turns")} v={formatCount(hit().turns!)} />
              </Show>
              <Show when={hit().toolUses !== undefined}>
                <AgentFact k={i18n.t("ui.tool.agent.readout.tools")} v={formatCount(hit().toolUses!)} />
              </Show>
              <Show when={hit().lastTool}>
                <AgentFact k={i18n.t("ui.tool.agent.readout.last")} v={hit().lastTool!} />
              </Show>
              <Show when={formatElapsed(hit().durationMs)}>
                {(elapsed) => <AgentFact k={i18n.t("ui.tool.agent.readout.elapsed")} v={elapsed()} />}
              </Show>
              <Show when={hit().totalTokens !== undefined}>
                <AgentFact k={i18n.t("ui.tool.agent.readout.tokens")} v={formatCount(hit().totalTokens!)} />
              </Show>
              <Show when={hit().outputFile}>
                <AgentFact
                  k={i18n.t("ui.tool.agent.readout.log")}
                  v={shortPath(hit().outputFile!, 3)}
                  title={hit().outputFile}
                  wide
                />
              </Show>
            </div>
          </AgentSection>

          <AgentActions taskID={hit().taskID} state={hit().state} background={hit().background} />
        </AgentShell>
      )}
    </Show>
  )
}

/**
 * 通知行:后台子 agent 完成后回到主会话的那条(synthetic user 消息上的 `task` part)。
 * 折叠态与 agent 卡片同一种长相,结论是完成 / 失败 / 已停止 + 用量;展开是结果全文与「打开子会话」。
 */
export function TaskNotificationDisplay(props: MessagePartProps) {
  const i18n = useI18n()
  const part = () => props.part as TaskNotificationPart
  const conclusion = createMemo(() => {
    const state = part().status
    const usage = part().usage
    const words = [
      stateWord(i18n.t, state),
      usage ? progressText(i18n.t, { toolUses: usage.toolUses, durationMs: usage.durationMs }) : undefined,
    ]
    return words.filter(Boolean).join(" · ")
  })
  return (
    <div data-component="task-notification" data-timeline-part-id={part().id} data-status={part().status}>
      <BasicTool
        icon="mcp"
        status="completed"
        defaultOpen={props.defaultOpen}
        // 展开状态交给时间线记(和工具卡一样):虚拟列表滚出去再回来不丢,会话内查找跳到结果里的命中时也打得开。
        open={props.onToolOpenChange ? (props.toolOpen ?? props.defaultOpen ?? false) : undefined}
        onOpenChange={props.onToolOpenChange}
        trigger={
          <AgentTriggerRow
            model={{
              state: part().status,
              agent: part().agent || i18n.t("ui.tool.agent.default"),
              description: part().description,
              conclusion: conclusion(),
            }}
          />
        }
      >
        <div data-component="agent-body">
          <Show when={part().result?.trim()} fallback={<div data-component="agent-note">{i18n.t("ui.tool.agent.noResult")}</div>}>
            {(result) => (
              <div data-component="agent-result">
                <Markdown text={result()} cacheKey={`task-note:${part().id}`} streaming={false} />
              </div>
            )}
          </Show>
          <AgentActions taskID={part().taskID || undefined} state={part().status} background />
        </div>
      </BasicTool>
    </div>
  )
}
