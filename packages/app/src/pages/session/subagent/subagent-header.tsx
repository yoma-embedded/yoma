/**
 * 子 agent 会话页的顶部条,嵌在时间线自己的标题行里:左边「← 主会话」+ 类型,标题照常(= 任务描述),
 * 右边是任务的状态与「停止」。子会话页没有输入框 —— 子 agent 只听派它的主 agent,用户要插话走主会话
 * (照 CC;内核也拒收发给子会话的消息)。
 *
 * 状态来自任务视图(`task.updated` / `task.list`,会话页打开时种过):内核重启之后注册表是空的,
 * 这时只剩会话本身,状态那半边不出,停止键也不出 —— 没有东西可停。
 *
 * 外观与输入框上方那几个坞同解(`../composer/dock.css`,2026-09-20):状态是一颗点而不是仪器的 LED 片,
 * 类型是一枚名牌 —— 从前它和父会话标题之间靠一个打上去的 `/` 隔着。
 */
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useData } from "@yoma-desktop/session-ui/context"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { sessionTitle } from "@/utils/session-title"
import { taskActive, taskElapsed, taskLook } from "./task-view"
import "../composer/dock.css"

/** 「← 主会话」与子 agent 的类型。 */
export function SubagentBack(props: { parentID: string; agent?: string }) {
  const language = useLanguage()
  const sync = useSync()
  const data = useData()
  const parentTitle = createMemo(
    () => sessionTitle(sync().session.get(props.parentID)?.title) ?? language.t("session.subagent.parent"),
  )

  return (
    <div data-component="subagent-back" class="shrink-0 flex items-center gap-1.5 min-w-0 max-w-[45%]">
      <Show when={data.navigateToSession}>
        {(navigate) => (
          <span data-tip={language.t("session.subagent.backTo", { title: parentTitle() })}>
            <IconButton
              icon="arrow-left"
              size="small"
              variant="ghost"
              aria-label={language.t("session.subagent.backTo", { title: parentTitle() })}
              onClick={() => navigate()(props.parentID)}
            />
          </span>
        )}
      </Show>
      <span class="min-w-0 truncate text-12-regular text-text-weak">{parentTitle()}</span>
      <Show when={props.agent}>
        <span data-slot="dock-agent">{props.agent}</span>
      </Show>
    </div>
  )
}

/** 任务状态(点 + 状态 · 轮数 · 工具调用 · 耗时)与「停止」。 */
export function SubagentStatus(props: { sessionID: string }) {
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string | number>) =>
    language.t(key as Parameters<typeof language.t>[0], params)
  const sync = useSync()
  const data = useData()
  const task = createMemo(() => sync().data.task[props.sessionID])
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    const current = task()
    if (!current || !taskActive(current)) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={task()}>
      {(current) => (
        <div data-component="subagent-status" class="shrink-0 flex items-center gap-2">
          <span data-component="dock-dot" data-state={taskLook(current())} aria-hidden="true" />
          <span class="text-12-regular text-text-weak" title={current().error ?? current().lastTool}>
            {[
              t(`session.subagent.state.${taskLook(current())}`),
              t("session.subagent.turns", { count: current().turns }),
              t("session.subagent.toolUses", { count: current().usage.toolUses }),
              taskElapsed(current(), now()),
            ].join(" · ")}
          </span>
          <Show when={taskActive(current()) && data.stopTask}>
            {(stop) => (
              <span data-tip={t("session.subagent.stop")} data-tone="danger">
                <IconButton
                  icon="stop"
                  size="small"
                  variant="ghost"
                  aria-label={t("session.subagent.stop")}
                  onClick={() => stop()(props.sessionID)}
                />
              </span>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}
