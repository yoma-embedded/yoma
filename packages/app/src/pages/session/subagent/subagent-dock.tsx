/**
 * 输入框正上方那条固定的「子 agent」坞(用户 2026-09-20 定,CC 最新版同一个位置)。
 *
 * 子 agent **缺省在后台跑**:主 agent 派完就继续干活 / 答话,对话会一直往下长,而那张 agent 卡片会随之滚走 ——
 * 所以"现在有谁在跑"必须有一个不随对话变化的位置。坞只画**还没完事的**:排队中、在跑、以及跑完了但结论还在
 * 收件箱里排着(主 agent 还没汇报)。汇报完就从坞里去掉,结论在对话里那条通知行上 —— 坞不留旧账。
 *
 * 一个都没有时整条不渲染(不占位)。行数封顶,多的折成"还有 N 个";整坞可以折叠成一行。
 * 状态栏那一格是另一件事:它管**这个会话总共派过几个**,点开是全量任务面板。
 *
 * 外观与另外三个坞共用 `../composer/dock.css`(2026-09-20):从前这块整个挂着 `.ybench` ——
 * 那是右栏调试台的字号与文字色,灯也是仪器的 LED。坞是产品主交互,不该穿仪器的皮。
 */
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@yoma-desktop/ui/button"
import { DockTray } from "@yoma-desktop/ui/dock-surface"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { useLanguage } from "@/context/language"
import { taskElapsed, taskLook, type DockTask } from "./task-view"
import "../composer/dock.css"

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
      attach={props.attached ? "bottom" : "none"}
      class={props.attached ? undefined : "mb-2"}
    >
      <div data-dock-body="" data-attached={props.attached ? "" : undefined}>
        <div data-dock-head="">
          <span data-slot="title">{t("session.subagentDock.title")}</span>
          <span data-slot="summary">{summary()}</span>
          <div data-slot="actions">
            {/* 「全部停止」留文字:批量的破坏性操作,一颗图标说不清它停的是几个。 */}
            <Show when={active() > 1 && props.onStopAll}>
              {(stopAll) => (
                <Button size="small" variant="ghost" class="shrink-0" onClick={() => stopAll()()}>
                  {t("session.subagentDock.stopAll")}
                </Button>
              )}
            </Show>
            <IconButton
              icon="chevron-down"
              size="small"
              variant="ghost"
              class="shrink-0"
              style={{ transform: `rotate(${store.collapsed ? 180 : 0}deg)` }}
              aria-label={t(store.collapsed ? "session.subagentDock.expand" : "session.subagentDock.collapse")}
              onClick={toggle}
            />
          </div>
        </div>

        <Show when={!store.collapsed}>
          <div class="flex flex-col">
            <For each={rows()}>
              {(row) => (
                <div data-dock-row="" data-slot="subagent-row" data-look={taskLook(row.task)}>
                  <span
                    data-component="dock-dot"
                    data-state={row.reporting ? "completed" : taskLook(row.task)}
                    aria-hidden="true"
                  />
                  <span data-slot="dock-agent">{row.task.agent}</span>
                  <span data-slot="text" title={row.task.description}>
                    {row.task.description}
                  </span>
                  <span data-slot="facts" title={row.task.error ?? row.task.lastTool}>
                    {facts(t, row, now())}
                  </span>
                  <div data-slot="row-actions">
                    <Show when={props.onOpen}>
                      {(open) => (
                        <span data-tip={t("session.subagent.open")}>
                          <IconButton
                            icon="square-arrow-top-right"
                            size="small"
                            variant="ghost"
                            aria-label={t("session.subagent.open")}
                            onClick={() => open()(row.task.id)}
                          />
                        </span>
                      )}
                    </Show>
                    <Show when={!row.reporting && props.onStop}>
                      {(stop) => (
                        <span data-tip={t("session.subagent.stop")} data-tone="danger">
                          <IconButton
                            icon="stop"
                            size="small"
                            variant="ghost"
                            aria-label={t("session.subagent.stop")}
                            onClick={() => stop()(row.task.id)}
                          />
                        </span>
                      )}
                    </Show>
                  </div>
                </div>
              )}
            </For>
            <Show when={hidden() > 0}>
              <span class="pt-0.5 text-12-regular text-text-weak">
                {t("session.subagentDock.more", { count: hidden() })}
              </span>
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
