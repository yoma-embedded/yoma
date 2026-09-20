import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { DockTray } from "@yoma-desktop/ui/dock-surface"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { useLanguage } from "@/context/language"
import "./dock.css"

/**
 * 「追问」坞:模型给的几条接着问的建议。整条可折叠,折起来时坞头右边带第一条的预览。
 * 它永远在这一摞的最底下,所以底边一律嵌进输入框。
 */
export function SessionFollowupDock(props: {
  items: { id: string; text: string }[]
  sending?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: false,
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const total = createMemo(() => props.items.length)
  const label = createMemo(() =>
    language.t(total() === 1 ? "session.followupDock.summary.one" : "session.followupDock.summary.other", {
      count: total(),
    }),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <DockTray data-component="session-followup-dock" attach="bottom">
      <div data-dock-body="" data-attached="">
        <div
          data-dock-head=""
          class="cursor-default"
          role="button"
          tabIndex={0}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            toggle()
          }}
        >
          <span data-slot="title">{label()}</span>
          <Show when={store.collapsed && preview()}>
            <span data-slot="summary">{preview()}</span>
          </Show>
          <div data-slot="actions">
            <IconButton
              data-collapsed={store.collapsed ? "true" : "false"}
              icon="chevron-down"
              size="small"
              variant="ghost"
              style={{ transform: `rotate(${store.collapsed ? 180 : 0}deg)` }}
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.stopPropagation()
                toggle()
              }}
              aria-label={
                store.collapsed ? language.t("session.followupDock.expand") : language.t("session.followupDock.collapse")
              }
            />
          </div>
        </div>

        <Show when={!store.collapsed}>
          <div class="flex flex-col max-h-42 overflow-y-auto no-scrollbar">
            <For each={props.items}>
              {(item) => (
                <div data-dock-row="">
                  <span data-slot="text">{item.text}</span>
                  <div data-slot="row-actions">
                    <span data-tip={language.t("session.followupDock.sendNow")}>
                      <IconButton
                        icon="arrow-up"
                        size="small"
                        variant="ghost"
                        disabled={!!props.sending}
                        aria-label={language.t("session.followupDock.sendNow")}
                        onClick={() => props.onSend(item.id)}
                      />
                    </span>
                    <span data-tip={language.t("session.followupDock.edit")}>
                      <IconButton
                        icon="edit"
                        size="small"
                        variant="ghost"
                        disabled={!!props.sending}
                        aria-label={language.t("session.followupDock.edit")}
                        onClick={() => props.onEdit(item.id)}
                      />
                    </span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </DockTray>
  )
}
