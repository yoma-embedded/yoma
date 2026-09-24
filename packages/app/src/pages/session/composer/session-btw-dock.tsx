import { For, Show } from "solid-js"
import type { BtwView } from "@yoma-desktop/kernel"
import { DockTray } from "@yoma-desktop/ui/dock-surface"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { Markdown } from "@yoma-desktop/session-ui/markdown"
import { useLanguage } from "@/context/language"
import "./dock.css"

/**
 * /btw 顺便问一句的坞(docs/btw顺便问-设计方案-20260924.md §4.8)。
 *
 * 紧贴输入框(栈的最底下):答案离视线最近,确认条仍在最上面。答案边想边出字,不进对话历史;数据是内核的
 * `session.btw` 事件(整条快照),不是前端自己记的。关掉(× 或 Esc)= 还在答就取消请求。答完了可以复制,或者
 * **转成后台任务**(照 CC 的 fork):一个继承整段对话与这次问答、带全套工具的后台子 agent,出现在上面的子 agent 坞里。
 * 坞头右边三个都是图标按钮(复制 / 转成后台任务 / 关闭),名字在 aria-label 与悬停说明里。
 */
export function SessionBtwDock(props: {
  view: BtwView
  /** 正在转后台:按钮先禁用,免得连点派出两个。 */
  forking: boolean
  onDismiss: () => void
  onFork: () => void
  onCopy: () => void
  /** 紧贴输入框(下面没有别的 dock)时才用负边距把底边嵌进输入框。 */
  attached: boolean
}) {
  const language = useLanguage()
  const running = () => props.view.status === "thinking" || props.view.status === "answering"
  const done = () => props.view.status === "done"

  return (
    <DockTray
      data-component="session-btw-dock"
      attach={props.attached ? "bottom" : "none"}
      class={props.attached ? undefined : "mb-2"}
    >
      <div data-dock-body="" data-attached={props.attached ? "" : undefined}>
        <div data-dock-head="">
          <span data-slot="title">{language.t("session.btwDock.title")}</span>
          <span data-slot="summary" title={props.view.question}>
            {props.view.question}
          </span>
          <div data-slot="actions">
            <Show when={done() && props.view.text}>
              <span data-tip={language.t("session.btwDock.copy")}>
                <IconButton
                  icon="copy"
                  size="small"
                  variant="ghost"
                  aria-label={language.t("session.btwDock.copy")}
                  onClick={() => props.onCopy()}
                />
              </span>
            </Show>
            {/*
              转成后台任务:从这条顺便问另派一个后台 agent(CC 叫 fork),所以用 fork 图标 —— 不用 agent 卡片上"转后台"
              那颗 arrow-down-to-line:那是把一个在跑的 agent 挪到后台,这里是新派一个。图标说不全的交给悬停说明。
            */}
            <Show when={done()}>
              <span data-tip={language.t("session.btwDock.forkHint")}>
                <IconButton
                  icon="fork"
                  size="small"
                  variant="ghost"
                  disabled={props.forking}
                  aria-label={language.t("session.btwDock.fork")}
                  onClick={() => props.onFork()}
                />
              </span>
            </Show>
            <span data-tip={language.t("session.btwDock.close")}>
              <IconButton
                icon="close-small"
                size="small"
                variant="ghost"
                aria-label={language.t("session.btwDock.close")}
                onClick={() => props.onDismiss()}
              />
            </span>
          </div>
        </div>
        <div data-slot="btw-answer">
          <Show
            when={props.view.text}
            fallback={
              <Show when={running()}>
                <span data-slot="btw-status">
                  {props.view.status === "thinking"
                    ? language.t("session.btwDock.thinking")
                    : language.t("session.btwDock.answering")}
                </span>
              </Show>
            }
          >
            <Markdown text={props.view.text} cacheKey={props.view.id} streaming={running()} />
          </Show>
          <Show when={props.view.attemptedTool}>
            {(tool) => <p data-slot="btw-note">{language.t("session.btwDock.attemptedTool", { tool: tool() })}</p>}
          </Show>
          <Show when={props.view.status === "failed"}>
            <p data-slot="btw-error">
              {props.view.error
                ? language.t("session.btwDock.failed", { error: props.view.error })
                : language.t("session.btwDock.empty")}
            </p>
          </Show>
          <For each={props.view.notices ?? []}>{(notice) => <p data-slot="btw-note">{notice}</p>}</For>
        </div>
      </div>
    </DockTray>
  )
}
