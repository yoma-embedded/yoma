/**
 * 子 agent 会话页的顶部条,嵌在时间线自己的标题行里:左边「← 主会话」+ 类型,标题照常(= 任务描述),
 * 右边是任务的状态与「停止」。子会话页没有输入框 —— 子 agent 只听派它的主 agent,用户要插话走主会话
 * (照 CC;内核也拒收发给子会话的消息)。
 *
 * 状态来自任务视图(`task.updated` / `task.list`,会话页打开时种过):内核重启之后注册表是空的,
 * 这时只剩会话本身,状态那半边不出,停止键也不出 —— 没有东西可停。
 */
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useData } from "@yoma-desktop/session-ui/context"
import { Button } from "@yoma-desktop/ui/button"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { sessionTitle } from "@/utils/session-title"
import { TASK_LED, taskActive, taskElapsed, taskLook } from "./task-view"

/** 「← 主会话」与子 agent 的类型。 */
export function SubagentBack(props: { parentID: string; agent?: string }) {
  const language = useLanguage()
  const sync = useSync()
  const data = useData()
  const parentTitle = createMemo(
    () => sessionTitle(sync().session.get(props.parentID)?.title) ?? language.t("session.subagent.parent"),
  )

  return (
    <div data-component="subagent-back" class="shrink-0 flex items-center gap-1 min-w-0 max-w-[45%]">
      <Show when={data.navigateToSession}>
        {(navigate) => (
          <IconButton
            icon="arrow-left"
            size="normal"
            variant="ghost"
            aria-label={language.t("session.subagent.backTo", { title: parentTitle() })}
            title={language.t("session.subagent.backTo", { title: parentTitle() })}
            onClick={() => navigate()(props.parentID)}
          />
        )}
      </Show>
      <span class="min-w-0 truncate text-12-regular text-text-weak">{parentTitle()}</span>
      <span class="shrink-0 text-12-regular text-text-weak" aria-hidden="true">
        /
      </span>
      <Show when={props.agent}>
        <span class="shrink-0 rounded-[4px] px-1.5 py-0.5 font-mono text-12-regular text-text-base bg-v2-overlay-simple-overlay-hover">
          {props.agent}
        </span>
      </Show>
    </div>
  )
}

/** 任务状态(灯 + 状态 · 轮数 · 工具调用 · 耗时)与「停止」。 */
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
        <div data-component="subagent-status" class="ybench shrink-0 flex items-center gap-2">
          <span
            data-component="bench-chip"
            data-state={TASK_LED[taskLook(current())]}
            title={current().error ?? current().lastTool}
          >
            <span data-component="bench-led" data-state={TASK_LED[taskLook(current())]} />
            <span data-slot="label">{t(`session.subagent.state.${taskLook(current())}`)}</span>
            <span data-slot="value">
              {[
                t("session.subagent.turns", { count: current().turns }),
                t("session.subagent.toolUses", { count: current().usage.toolUses }),
                taskElapsed(current(), now()),
              ].join(" · ")}
            </span>
          </span>
          <Show when={taskActive(current()) && data.stopTask}>
            {(stop) => (
              <Button size="small" variant="ghost" onClick={() => stop()(props.sessionID)}>
                {t("session.subagent.stop")}
              </Button>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}
