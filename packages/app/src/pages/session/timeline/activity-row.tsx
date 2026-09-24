/**
 * 正在跑的那一轮底下那一行(`TimelineRow.Thinking`):此刻在干什么(`activity.ts`,照 pi-agent-desktop 的 phaseLabel)。
 * 模型正在往外发思考内容才说「思考中」(打开了「显示思考」时不在这里说 —— 思考块自己在闪);有工具在跑说「正在运行 …」;
 * 在等下一次请求出字说「等待模型」;工具在等确认条说「等待确认 …」;模型在写正文、在写调用参数时不出字。
 * 小号、最淡:它是状态,不是回复。
 *
 * 阶段来自内核时带着起点,后面跟已过时长(一秒一跳);思考时再跟已经想了多少字 —— 推理缺省不显示,只看一个「思考中」
 * 分不出它在想还是停了(docs/调试留痕-规划-20260924.md §2.2)。按 part 推断出来的阶段没有起点,不走表。
 */
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { TextReveal } from "@yoma-desktop/ui/text-reveal"
import { TextShimmer } from "@yoma-desktop/ui/text-shimmer"
import { useLanguage } from "@/context/language"
import { formatActivityElapsed, formatChars, type TurnActivity } from "./activity"
import "./activity-row.css"

export function TimelineActivityRow(props: {
  activity: TurnActivity | undefined
  reasoningHeading?: string
  showReasoningSummaries: boolean
  /** 这一轮正在流的那段推理有多少字(只在思考阶段读)。 */
  reasoningChars?: () => number
}) {
  const language = useLanguage()
  const label = createMemo(() => {
    const activity = props.activity
    if (!activity) return
    if (activity.kind === "thinking")
      return props.showReasoningSummaries ? undefined : language.t("ui.sessionTurn.status.thinking")
    if (activity.kind === "waiting") return language.t("ui.sessionTurn.status.waitingModel")
    if (activity.kind === "confirm") return language.t("ui.sessionTurn.status.waitingConfirm", { tool: activity.tool })
    const shown = activity.names.slice(0, 3).join(language.t("ui.sessionTurn.status.toolSeparator"))
    if (activity.names.length <= 3) return language.t("ui.sessionTurn.status.runningTools", { names: shown })
    return language.t("ui.sessionTurn.status.runningToolsMore", {
      names: shown,
      total: activity.names.length,
      more: activity.names.length - 3,
    })
  })

  return (
    <Show when={label()}>
      {(text) => (
        <div data-slot="session-turn-thinking" data-activity={props.activity?.kind}>
          <TextShimmer text={text()} />
          <Show when={props.activity?.since}>
            {(since) => (
              <ActivityDetail
                since={since()}
                thinking={props.activity?.kind === "thinking"}
                reasoningChars={props.reasoningChars}
              />
            )}
          </Show>
          <Show when={props.activity?.kind === "thinking"}>
            <TextReveal text={props.reasoningHeading} class="session-turn-thinking-heading" travel={25} duration={700} />
          </Show>
        </div>
      )}
    </Show>
  )
}

/** 已过时长(一秒一跳)与思考字数。只在阶段带起点时挂载,计时器跟着它起停。 */
function ActivityDetail(props: { since: number; thinking: boolean; reasoningChars?: () => number }) {
  const language = useLanguage()
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    // 换了阶段(since 变了)先对一次表,别让新阶段从上一秒的时刻起算
    void props.since
    setNow(Date.now())
  })
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))

  const chars = () => (props.thinking ? (props.reasoningChars?.() ?? 0) : 0)
  return (
    <span data-slot="session-turn-thinking-detail">
      {formatActivityElapsed(now() - props.since)}
      <Show when={chars() > 0}>
        {` · ${language.t("ui.sessionTurn.status.thoughtChars", { chars: formatChars(chars()) })}`}
      </Show>
    </span>
  )
}
