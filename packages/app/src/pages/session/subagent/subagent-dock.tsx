/**
 * 输入框正上方那条固定的「子 agent」坞(用户 2026-09-20 定,CC 最新版同一个位置)。
 *
 * 子 agent **缺省在后台跑**:主 agent 派完就继续干活 / 答话,对话会一直往下长,而那张 agent 卡片会随之滚走 ——
 * 所以"现在有谁在跑"必须有一个不随对话变化的位置。坞只画**还没完事的**:排队中、在跑、以及跑完了但结论还在
 * 收件箱里排着(主 agent 还没汇报)。汇报完就从坞里去掉,结论在对话里那条通知行上 —— 坞不留旧账。
 *
 * 一个都没有时整条不渲染(不占位)。行数封顶,多的折成"还有 N 个";整坞可以折叠成一行。
 * 状态栏那一格是另一件事:它管**这个会话总共派过几个**,点开是全量任务面板。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@yoma-desktop/ui/button"
import { DockTray } from "@yoma-desktop/ui/dock-surface"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { useLanguage } from "@/context/language"
import { TASK_LED, taskElapsed, taskLook, type DockTask } from "./task-view"

/** 最多画几行。再多就折成"还有 N 个" —— 并发闸缺省 10,十行会把输入框顶到屏幕外。 */
export const DOCK_MAX_ROWS = 3

export function SubagentDock(props: {
  items: DockTask[]
  onOpen?: (taskID: string) => void
  onStop?: (taskID: string) => void
  /** 在跑的有两个以上时,坞头多一个「全部停止」。 */
  onStopAll?: () => void
  /** 紧贴输入框(下面没有别的 dock)时才用负边距把底边嵌进输入框。 */
  attached: boolean
}) {
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string | number>) =>
    language.t(key as Parameters<typeof language.t>[0], params)
  const [store, setStore] = createStore({ collapsed: false })
  const [now, setNow] = createSignal(Date.now())

  const active = createMemo(() => props.items.filter((item) => !item.reporting).length)
  const rows = createMemo(() => props.items.slice(0, DOCK_MAX_ROWS))
  const hidden = createMemo(() => Math.max(0, props.items.length - DOCK_MAX_ROWS))

  // 耗时一秒一跳。有东西在跑才起钟,汇报中的那几行时间已经定了。
  createEffect(() => {
    if (active() === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const summary = () =>
    active() > 0
      ? t("session.subagentDock.running", { count: active() })
      : t("session.subagentDock.reportingCount", { count: props.items.length })

  const toggle = () => setStore("collapsed", (value) => !value)

  return (
    <DockTray
      data-component="subagent-dock"
      style={
        props.attached
          ? { "margin-bottom": "-0.875rem", "border-bottom-left-radius": 0, "border-bottom-right-radius": 0 }
          : { "margin-bottom": "0.5rem" }
      }
    >
      <div class="ybench px-3 pt-2 flex flex-col gap-1" classList={{ "pb-7": props.attached, "pb-2": !props.attached }}>
        <div class="flex items-center gap-2 min-w-0">
          <span class="shrink-0 text-12-medium text-text-strong">{t("session.subagentDock.title")}</span>
          <span class="min-w-0 flex-1 truncate text-12-regular text-text-weak">{summary()}</span>
          <Show when={active() > 1 && props.onStopAll}>
            {(stopAll) => (
              <Button size="small" variant="ghost" class="shrink-0" onClick={() => stopAll()()}>
                {t("session.subagentDock.stopAll")}
              </Button>
            )}
          </Show>
          <IconButton
            icon="chevron-down"
            size="normal"
            variant="ghost"
            class="shrink-0"
            style={{ transform: `rotate(${store.collapsed ? 180 : 0}deg)` }}
            aria-label={t(store.collapsed ? "session.subagentDock.expand" : "session.subagentDock.collapse")}
            onClick={toggle}
          />
        </div>

        <Show when={!store.collapsed}>
          <div class="flex flex-col gap-1">
            <For each={rows()}>
              {(row) => (
                <div data-slot="subagent-row" data-look={taskLook(row.task)} class="flex items-center gap-2 min-w-0">
                  <span data-component="bench-led" data-state={row.reporting ? "ok" : TASK_LED[taskLook(row.task)]} />
                  <span class="shrink-0 font-mono text-12-regular text-text-weak">{row.task.agent}</span>
                  <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong" title={row.task.description}>
                    {row.task.description}
                  </span>
                  <span
                    data-slot="facts"
                    class="shrink-0 font-mono text-12-regular text-text-weak"
                    title={row.task.error ?? row.task.lastTool}
                  >
                    {facts(t, row, now())}
                  </span>
                  <Show when={props.onOpen}>
                    {(open) => (
                      <Button size="small" variant="ghost" class="shrink-0" onClick={() => open()(row.task.id)}>
                        {t("session.subagent.open")}
                      </Button>
                    )}
                  </Show>
                  <Show when={!row.reporting && props.onStop}>
                    {(stop) => (
                      <Button size="small" variant="ghost" class="shrink-0" onClick={() => stop()(row.task.id)}>
                        {t("session.subagent.stop")}
                      </Button>
                    )}
                  </Show>
                </div>
              )}
            </For>
            <Show when={hidden() > 0}>
              <span class="text-12-regular text-text-weak">{t("session.subagentDock.more", { count: hidden() })}</span>
            </Show>
          </div>
        </Show>
      </div>
    </DockTray>
  )
}

/** 一行右边那串读数:跑完待汇报的说"等主 agent 汇报",在跑的说状态 · 工具调用数 · 耗时。 */
function facts(t: (key: string, params?: Record<string, string | number>) => string, row: DockTask, now: number) {
  if (row.reporting) return t("session.subagentDock.reporting")
  return [
    t(`session.subagent.state.${taskLook(row.task)}`),
    t("session.subagent.toolUses", { count: row.task.usage.toolUses }),
    taskElapsed(row.task, now),
    row.task.maxTurnsReached ? t("session.subagent.maxTurns") : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
}
