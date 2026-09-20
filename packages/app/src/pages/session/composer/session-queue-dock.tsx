import { For, Show } from "solid-js"
import { DockTray } from "@yoma-desktop/ui/dock-surface"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { useLanguage } from "@/context/language"
import "./dock.css"

/**
 * "排队中"一栏:会话在忙时发的消息(照 CC)。内核把它们排进收件箱,在当前这一批工具跑完、下一次请求之前
 * 送给模型;在那之前它们不在 transcript 里,画在这儿。每条可以撤回来改(行尾的图标,或输入框里按 ↑ 一次撤回全部)。
 *
 * 数据是内核的 `session.queue` 事件(收件箱现状,整份替换),不是前端自己记的 —— 被取走的那一刻它就从这里
 * 消失、出现在 transcript 里真实的位置。
 */
export function SessionQueueDock(props: {
  items: { entryId: string; text: string; images: number }[]
  /** 正在撤回的条目:只禁用那几行,免得连点把第二次撤回打到一条已经撤走的上。 */
  retracting: readonly string[]
  onRetract: (entryId: string) => void
  /** 紧贴输入框(下面没有别的 dock)时才用负边距把底边嵌进输入框。 */
  attached: boolean
}) {
  const language = useLanguage()
  const firstLine = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line) ?? ""

  return (
    <DockTray
      data-component="session-queue-dock"
      attach={props.attached ? "bottom" : "none"}
      class={props.attached ? undefined : "mb-2"}
    >
      <div data-dock-body="" data-attached={props.attached ? "" : undefined}>
        <div data-dock-head="">
          <span data-slot="title">{language.t("session.queueDock.title", { count: props.items.length })}</span>
        </div>
        <div class="flex flex-col max-h-42 overflow-y-auto no-scrollbar">
          <For each={props.items}>
            {(item) => (
              <div data-dock-row="" data-slot="queue-item">
                <span data-slot="text">
                  {firstLine(item.text) || language.t("session.queueDock.imageOnly")}
                </span>
                <Show when={item.images > 0}>
                  <span data-slot="facts">{language.t("session.queueDock.images", { count: item.images })}</span>
                </Show>
                <div data-slot="row-actions">
                  <span data-tip={language.t("session.queueDock.retract")}>
                    <IconButton
                      icon="arrow-undo-down"
                      size="small"
                      variant="ghost"
                      disabled={props.retracting.includes(item.entryId)}
                      aria-label={language.t("session.queueDock.retract")}
                      onClick={() => props.onRetract(item.entryId)}
                    />
                  </span>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </DockTray>
  )
}
