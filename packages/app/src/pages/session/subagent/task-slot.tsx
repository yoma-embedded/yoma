/**
 * 状态栏上的「子 agent」格,以及点开的任务面板 —— CC 的任务面板在这套界面里的位置。
 *
 * 这个会话派过子 agent 才出现(一格不亮的灯没有意思):`子 agent 2 在跑` / `子 agent 5 个`。
 * 点一下弹出面板(再点 / Esc / 点别处收起):每个任务一行,灯 + 类型 + 描述,下一行是状态、轮数、工具调用数、耗时;
 * 「打开」进子会话,「停止」只对还在跑的。两个动作走 session-ui 的 Data 上下文(与 agent 卡片同一份回调),
 * 这里不再写一遍 RPC。
 *
 * 面板走 Portal 挂在 body 上、自带 `.ybench`:理由同目标格(`console/target-slot.tsx` 文件头的两条坑)。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import type { TaskView } from "@yoma-desktop/kernel"
import { useData } from "@yoma-desktop/session-ui/context"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { anchorPopover, type PopoverAnchor } from "../console/target-slot"
import { sessionTasks, TASK_LED, taskActive, taskElapsed, taskLook } from "./task-view"
import "./task-slot.css"

/** 面板宽:一行要放下类型、描述与两个按钮。 */
export const TASK_PANEL_WIDTH = 380

export function TaskSlot() {
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string | number>) =>
    language.t(key as Parameters<typeof language.t>[0], params)
  const sync = useSync()
  const { params } = useSessionLayout()

  const tasks = createMemo(() => (params.id ? sessionTasks(sync().data.task, params.id) : []))
  const active = createMemo(() => tasks().filter(taskActive).length)

  const [open, setOpen] = createSignal(false)
  const [anchor, setAnchor] = createStore<PopoverAnchor>({ left: 0, bottom: 0 })
  const [now, setNow] = createSignal(Date.now())
  let slot: HTMLButtonElement | undefined
  let panel: HTMLDivElement | undefined

  // 任务都没了(会话删了、换了会话)就收起,别留一张空面板。
  createEffect(() => {
    if (tasks().length === 0) setOpen(false)
  })

  // 耗时要走:只在面板开着且有任务在跑时才起一个秒钟,收起就停。
  createEffect(() => {
    if (!open() || active() === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const place = () => {
    if (!slot || typeof window === "undefined") return
    setAnchor(
      anchorPopover(
        slot.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        TASK_PANEL_WIDTH,
      ),
    )
  }
  createEffect(() => {
    if (!open() || typeof window === "undefined") return
    place()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (slot?.contains(target) || panel?.contains(target)) return
      setOpen(false)
    }
    window.addEventListener("resize", place)
    window.addEventListener("keydown", onKey)
    window.addEventListener("pointerdown", onPointerDown)
    onCleanup(() => {
      window.removeEventListener("resize", place)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pointerdown", onPointerDown)
    })
  })

  const value = () =>
    active() > 0
      ? t("session.subagent.slot.active", { count: active() })
      : t("session.subagent.slot.total", { count: tasks().length })

  return (
    <Show when={tasks().length > 0}>
      <button
        type="button"
        ref={(element) => (slot = element)}
        data-component="subagent-task-slot"
        aria-expanded={open() ? "true" : "false"}
        aria-label={`${t("session.subagent.slot.label")} ${value()}`}
        title={t("session.subagent.panel.title")}
        onClick={() => setOpen((value) => !value)}
      >
        <span data-component="bench-led" data-state={active() > 0 ? "active" : "idle"} />
        <span data-slot="label">{t("session.subagent.slot.label")}</span>
        <span data-slot="value">{value()}</span>
      </button>

      <Show when={open()}>
        <Portal>
          <div
            ref={(element) => (panel = element)}
            class="ybench"
            data-component="subagent-task-panel"
            role="dialog"
            aria-label={t("session.subagent.panel.title")}
            style={{ left: `${anchor.left}px`, bottom: `${anchor.bottom}px`, width: `${TASK_PANEL_WIDTH}px` }}
          >
            <div data-slot="head">{t("session.subagent.panel.title")}</div>
            <ul data-slot="list">
              <For each={tasks()}>{(task) => <TaskRow task={task} now={now()} onDone={() => setOpen(false)} />}</For>
            </ul>
          </div>
        </Portal>
      </Show>
    </Show>
  )
}

function TaskRow(props: { task: TaskView; now: number; onDone: () => void }) {
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string | number>) =>
    language.t(key as Parameters<typeof language.t>[0], params)
  const data = useData()
  const look = () => taskLook(props.task)
  const facts = () =>
    [
      t(`session.subagent.state.${look()}`),
      t("session.subagent.turns", { count: props.task.turns }),
      t("session.subagent.toolUses", { count: props.task.usage.toolUses }),
      taskElapsed(props.task, props.now),
      props.task.maxTurnsReached ? t("session.subagent.maxTurns") : undefined,
    ]
      .filter(Boolean)
      .join(" · ")

  return (
    <li data-slot="task" data-look={look()}>
      <span data-component="bench-led" data-state={TASK_LED[look()]} />
      <div data-slot="body">
        <div data-slot="title">
          <span data-slot="agent">{props.task.agent}</span>
          <span data-slot="description" title={props.task.description}>
            {props.task.description}
          </span>
        </div>
        <div data-slot="facts" title={props.task.error ?? props.task.lastTool}>
          {facts()}
        </div>
      </div>
      <div data-slot="actions">
        <Show when={data.navigateToSession}>
          {(open) => (
            <button
              type="button"
              data-slot="action"
              onClick={() => {
                open()(props.task.id)
                props.onDone()
              }}
            >
              {t("session.subagent.open")}
            </button>
          )}
        </Show>
        <Show when={taskActive(props.task) && data.stopTask}>
          {(stop) => (
            <button type="button" data-slot="action" data-tone="stop" onClick={() => stop()(props.task.id)}>
              {t("session.subagent.stop")}
            </button>
          )}
        </Show>
      </div>
    </li>
  )
}
