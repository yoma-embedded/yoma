/**
 * 子 agent 的两张卡(docs/子agent-设计方案-v0.4-20260918.md §7):
 *
 * - **agent 卡片**:一次 `agent` 工具调用。折叠态 `● 子 agent Explore · 查时钟树 · 5 次工具调用 · 最近 grep · 4.2 s`;
 *   展开态是任务书、结果(markdown)、读数,以及「打开子会话 / 转到后台 / 停止」。灯跟着**实时任务**走
 *   (Data 上下文的 `store.task`):后台派出的子 agent 在工具调用交回之后还在跑,只有那一份知道"现在"。
 * - **通知行**:后台子 agent 完成后回到主会话的那条通知(synthetic user 消息上的 `task` part)。一行状态 + 可展开的结果。
 *
 * 与硬件卡同一套外壳与原语(hw-tool.tsx / bench.css):折叠态一行、展开态每块有上限、认不出就回落通用卡。
 * 三个按钮都由宿主给回调(Data 上下文),不给就一个像素都不渲染 —— 同「在面板中打开」的规矩。
 */
import { createMemo, Show } from "solid-js"
import type { TaskNotificationPart } from "@yoma-desktop/kernel"
import { Button } from "@yoma-desktop/ui/button"
import { useI18n } from "@yoma-desktop/ui/context/i18n"
import { useData } from "../context"
import { describeAgent, type AgentCard, type AgentCardState } from "./agent-card"
import { BasicTool, GenericTool } from "./basic-tool"
import { formatCount, formatElapsed, shortPath } from "./hw-format"
import { HwMono, HwNote, HwReadout, HwReadouts, HwSection, HwTool, HwTriggerRow, type HwState } from "./hw-tool"
import { Markdown } from "./markdown"
import type { MessagePartProps, ToolProps } from "./message-part"

const LED: Record<AgentCardState, HwState> = {
  launching: "active",
  pending: "idle",
  running: "active",
  background: "idle",
  completed: "ok",
  failed: "fail",
  killed: "warn",
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
      return `✓ ${t("ui.tool.agent.state.completed")}`
    case "failed":
      return `✗ ${t("ui.tool.agent.state.failed")}`
    case "killed":
      return `■ ${t("ui.tool.agent.state.killed")}`
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

/** 「打开子会话 / 转到后台 / 停止」。宿主没给的回调就没有那个按钮;一个都没有就整行不出。 */
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
            <Button size="small" variant="secondary" icon="square-arrow-top-right" onClick={() => go()(props.taskID!)}>
              {i18n.t("ui.tool.agent.open")}
            </Button>
          )}
        </Show>
        <Show when={toBackground()}>
          {(move) => (
            <Button size="small" variant="ghost" onClick={() => move()(props.taskID!)}>
              {i18n.t("ui.tool.agent.background")}
            </Button>
          )}
        </Show>
        <Show when={stop()}>
          {(halt) => (
            <Button size="small" variant="ghost" onClick={() => halt()(props.taskID!)}>
              {i18n.t("ui.tool.agent.stop")}
            </Button>
          )}
        </Show>
      </div>
    </Show>
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
        <HwTool
          {...props}
          trigger={{
            state: LED[hit().state],
            label: i18n.t("ui.tool.agent.label"),
            action: hit().description ? `${hit().agent} · ${hit().description}` : hit().agent,
            conclusion: conclusionOf(i18n.t, hit()),
          }}
        >
          <Show when={hit().prompt}>
            <HwSection title={i18n.t("ui.tool.agent.prompt")}>
              <HwMono text={hit().prompt} wrap />
            </HwSection>
          </Show>

          <Show
            when={hit().result}
            fallback={
              <Show
                when={
                  hit().emptyResult || hit().state === "background" || (hit().background && hit().state === "running")
                }
              >
                <HwNote>
                  {hit().emptyResult
                    ? i18n.t("ui.tool.agent.noResult")
                    : hit().state === "background"
                      ? i18n.t("ui.tool.agent.detached")
                      : i18n.t("ui.tool.agent.inBackground")}
                </HwNote>
              </Show>
            }
          >
            {(result) => (
              <HwSection title={i18n.t("ui.tool.agent.result")}>
                <div data-component="agent-result">
                  <Markdown
                    text={result()}
                    cacheKey={`agent-result:${hit().taskID ?? hit().description}`}
                    streaming={false}
                  />
                </div>
              </HwSection>
            )}
          </Show>

          <HwSection title={i18n.t("ui.tool.hw.readout")}>
            <HwReadouts>
              <HwReadout k={i18n.t("ui.tool.agent.readout.agent")} v={hit().agent} />
              <Show when={hit().turns !== undefined}>
                <HwReadout k={i18n.t("ui.tool.agent.readout.turns")} v={formatCount(hit().turns!)} />
              </Show>
              <Show when={hit().toolUses !== undefined}>
                <HwReadout k={i18n.t("ui.tool.agent.readout.tools")} v={formatCount(hit().toolUses!)} />
              </Show>
              <Show when={hit().lastTool}>
                <HwReadout k={i18n.t("ui.tool.agent.readout.last")} v={hit().lastTool!} />
              </Show>
              <Show when={formatElapsed(hit().durationMs)}>
                {(elapsed) => <HwReadout k={i18n.t("ui.tool.agent.readout.elapsed")} v={elapsed()} />}
              </Show>
              <Show when={hit().totalTokens !== undefined}>
                <HwReadout k={i18n.t("ui.tool.agent.readout.tokens")} v={formatCount(hit().totalTokens!)} />
              </Show>
              <Show when={hit().outputFile}>
                <HwReadout
                  k={i18n.t("ui.tool.agent.readout.log")}
                  v={shortPath(hit().outputFile!, 3)}
                  title={hit().outputFile}
                  wide
                />
              </Show>
            </HwReadouts>
          </HwSection>

          <AgentActions taskID={hit().taskID} state={hit().state} background={hit().background} />
        </HwTool>
      )}
    </Show>
  )
}

const NOTE_LED: Record<TaskNotificationPart["status"], HwState> = { completed: "ok", failed: "fail", killed: "warn" }

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
        trigger={
          <HwTriggerRow
            model={{
              state: NOTE_LED[part().status],
              label: i18n.t("ui.tool.agent.label"),
              action: part().agent ? `${part().agent} · ${part().description}` : part().description,
              conclusion: conclusion(),
            }}
          />
        }
      >
        <div data-component="hw-body">
          <Show when={part().result?.trim()} fallback={<HwNote>{i18n.t("ui.tool.agent.noResult")}</HwNote>}>
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
