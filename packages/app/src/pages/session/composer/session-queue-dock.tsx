import { For, Show } from "solid-js"
import { Button } from "@yoma-desktop/ui/button"
import { DockTray } from "@yoma-desktop/ui/dock-surface"
import { useLanguage } from "@/context/language"

/**
 * "排队中"一栏:会话在忙时发的消息(照 CC)。内核把它们排进收件箱,在当前这一批工具跑完、下一次请求之前
 * 送给模型;在那之前它们不在 transcript 里,画在这儿。每条可以撤回来改(按钮,或输入框里按 ↑ 一次撤回全部)。
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
      style={
        props.attached
          ? { "margin-bottom": "-0.875rem", "border-bottom-left-radius": 0, "border-bottom-right-radius": 0 }
          : { "margin-bottom": "0.5rem" }
      }
    >
      <div class="px-3 pt-2 flex flex-col gap-1" classList={{ "pb-7": props.attached, "pb-2": !props.attached }}>
        <span class="text-12-medium text-text-weak">
          {language.t("session.queueDock.title", { count: props.items.length })}
        </span>
        <div class="flex flex-col gap-1 max-h-42 overflow-y-auto no-scrollbar">
          <For each={props.items}>
            {(item) => (
              <div data-slot="queue-item" class="flex items-center gap-2 min-w-0 py-0.5">
                <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">
                  {firstLine(item.text) || language.t("session.queueDock.imageOnly")}
                </span>
                <Show when={item.images > 0}>
                  <span class="shrink-0 text-12-regular text-text-weak">
                    {language.t("session.queueDock.images", { count: item.images })}
                  </span>
                </Show>
                <Button
                  size="small"
                  variant="ghost"
                  class="shrink-0"
                  disabled={props.retracting.includes(item.entryId)}
                  onClick={() => props.onRetract(item.entryId)}
                >
                  {language.t("session.queueDock.retract")}
                </Button>
              </div>
            )}
          </For>
        </div>
      </div>
    </DockTray>
  )
}
