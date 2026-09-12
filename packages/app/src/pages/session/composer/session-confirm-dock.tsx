import { For } from "solid-js"
import type { ToolConfirmView } from "@yoma-desktop/kernel"
import { Button } from "@yoma-desktop/ui/button"
import { DockTray } from "@yoma-desktop/ui/dock-surface"
import { useLanguage } from "@/context/language"

/**
 * 工具确认条:模型想跑一个契约说"要先问"的工具(今天只有烧录),内核把它挂起,这里显示
 * "烧录 想执行:<那一行命令>",用户点允许才真跑。
 *
 * 两个刻意的不做:不绑 Enter / Esc(误触一下就是往板子里写东西);不自己拼命令行 ——
 * summary 是内核按契约拼好的,前端再拼一遍的后果是屏幕上的命令和真跑的不是一条。
 * 多条未决时按提问顺序堆叠,最早的在最上面(内核给的顺序)。
 */
export function SessionConfirmDock(props: {
  items: ToolConfirmView[]
  /** 正在回复的那条 id:只禁用那一行,免得双击把第二次回复打到一条已经结算的询问上。 */
  replying?: string
  onReply: (id: string, allow: boolean) => void
  /** 紧贴输入框(下面没有别的 dock)时才用负边距把底边嵌进输入框。 */
  attached: boolean
}) {
  const language = useLanguage()
  // 内核给的 label 是中文短名("烧录"),英文界面不能把它插进英文句子;按工具名查键,缺键回落到工具名。
  const toolName = (item: ToolConfirmView) => {
    const key = `session.confirmDock.tool.${item.tool}`
    const text = language.t(key)
    return text === key ? item.tool : text
  }

  return (
    <DockTray
      data-component="session-confirm-dock"
      style={
        props.attached
          ? { "margin-bottom": "-0.875rem", "border-bottom-left-radius": 0, "border-bottom-right-radius": 0 }
          : { "margin-bottom": "0.5rem" }
      }
    >
      <div class="px-3 pt-2 flex flex-col gap-1.5" classList={{ "pb-7": props.attached, "pb-2": !props.attached }}>
        <For each={props.items}>
          {(item) => (
            <div class="flex items-center gap-2 min-w-0 py-1">
              <span class="shrink-0 text-13-medium text-text-strong">
                {language.t("session.confirmDock.wants", { tool: toolName(item) })}
              </span>
              <span class="min-w-0 flex-1 truncate font-mono text-12-regular text-text-base" title={item.summary}>
                {item.summary}
              </span>
              <Button
                size="small"
                variant="secondary"
                class="shrink-0"
                disabled={props.replying === item.id}
                onClick={() => props.onReply(item.id, true)}
              >
                {language.t("session.confirmDock.allow")}
              </Button>
              <Button
                size="small"
                variant="ghost"
                class="shrink-0"
                disabled={props.replying === item.id}
                onClick={() => props.onReply(item.id, false)}
              >
                {language.t("session.confirmDock.deny")}
              </Button>
            </div>
          )}
        </For>
      </div>
    </DockTray>
  )
}
