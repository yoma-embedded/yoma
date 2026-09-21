import { For } from "solid-js"
import type { ToolConfirmView } from "@yoma-desktop/kernel"
import { Button } from "@yoma-desktop/ui/button"
import { DockTray } from "@yoma-desktop/ui/dock-surface"
import { useLanguage } from "@/context/language"
import "./dock.css"

/**
 * 工具确认条:模型想跑一个契约说"要先问"的工具(烧录,以及 bash / PowerShell 里命令位站着
 * openocd / JLink 之类探针程序的那一次),内核把它挂起,这里显示"烧录 想执行:<命令>",
 * 用户点允许才真跑。
 *
 * 三个刻意的不做:不绑 Enter / Esc(误触一下就是往板子里写东西);不自己拼命令行 ——
 * summary 是内核按契约拼好的,前端再拼一遍的后果是屏幕上的命令和真跑的不是一条;
 * **不截断命令**:一条 140 字的 openocd 命令用 truncate 只剩前 60 字,mass_erase 藏在省略号后面
 * 用户就点了允许(2026-09-13 猎漏确认),所以整段换行显示,超高时在框内滚动。
 * 多条未决时按提问顺序堆叠,最早的在最上面(内核给的顺序)。
 *
 * 第四个刻意的不做(2026-09-20):**「允许 / 拒绝」不图标化**。旁边几个坞的行内操作都改成了图标,
 * 这两颗没跟着改 —— 按错的代价是往板子里写东西,而图标是要猜的。大厂在破坏性主操作上同样留字。
 *
 * 前台子 agent 的询问冒到主会话这里来(`item.agent`):写明是哪个子 agent 在问 —— 用户看着的是主会话,
 * 不说的话这条烧录像是主 agent 自己要跑的。后台子 agent 不问,内核直接挡掉(没人看着它)。
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
      attach={props.attached ? "bottom" : "none"}
      class={props.attached ? undefined : "mb-2"}
    >
      <div data-dock-body="" data-attached={props.attached ? "" : undefined}>
        <For each={props.items}>
          {(item) => (
            <div data-dock-row="" data-align="start">
              <span data-slot="label">
                {item.agent
                  ? language.t("session.confirmDock.agentWants", { agent: item.agent, tool: toolName(item) })
                  : language.t("session.confirmDock.wants", { tool: toolName(item) })}
              </span>
              <span data-slot="confirm-summary">{item.summary}</span>
              <div data-slot="row-buttons">
                <Button
                  size="small"
                  variant="secondary"
                  disabled={props.replying === item.id}
                  onClick={() => props.onReply(item.id, true)}
                >
                  {language.t("session.confirmDock.allow")}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={props.replying === item.id}
                  onClick={() => props.onReply(item.id, false)}
                >
                  {language.t("session.confirmDock.deny")}
                </Button>
              </div>
            </div>
          )}
        </For>
      </div>
    </DockTray>
  )
}
