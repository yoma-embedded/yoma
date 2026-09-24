import { Component, createEffect, For, Match, Show, Switch } from "solid-js"
import { FileIcon } from "@yoma-desktop/ui/file-icon"
import { KeybindV2 } from "@yoma-desktop/ui/v2/keybind-v2"
import { isDirectoryPath, splitAtOptionLabel, type AtOption } from "./at-options"

export type { AtOption }

/** `/` 命令只剩前端内置的那些:内核没有自定义命令,也没有 MCP prompt / skill。 */
export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  /** 选中时往输入框写这段字(带参数的命令,如 `/btw `),而不是执行。 */
  insert?: string
}

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  commandKeybindParts: (id: string) => string[]
  t: (key: string) => string
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  return (
    <Show when={props.popover}>
      <div
        ref={(el) => {
          if (props.popover === "slash") props.setSlashPopoverRef(el)
        }}
        class="absolute inset-x-0 -top-2 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2"
        classList={{
          "z-[70] rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]": true,
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show
              when={props.atFlat.length > 0}
              fallback={
                <div class="px-2 py-1 text-v2-text-text-muted">{props.t("prompt.popover.emptyResults")}</div>
              }
            >
              {/*
                不截断:候选上限在 at-options 的 MAX_AT_OPTIONS 那里,截的是集合本身。
                从前这里是 `slice(0, 10)` 而方向键导航的是全量列表,第 11 项起选得中、看不见。
              */}
              <For each={props.atFlat}>
                {(item) => {
                  const key = props.atKey(item)

                  // 目录以 `/` 收尾。名字段带上那个尾巴,加上文件夹图标,一行里两处都能看出来是目录。
                  const isDirectory = isDirectoryPath(item.path)
                  const { directory, name } = splitAtOptionLabel(item.path)

                  let row: HTMLButtonElement | undefined
                  // 键盘走到框外的项时把它滚进来。`nearest` 让已经可见的项不动,于是鼠标 hover
                  // 改 active 时不会自己跳。
                  createEffect(() => {
                    if (props.atActive === key) row?.scrollIntoView({ block: "nearest" })
                  })

                  return (
                    <button
                      ref={(el) => (row = el)}
                      class="w-full flex items-center gap-x-2 px-2 py-0.5 scroll-my-2 rounded-[4px]"
                      classList={{
                        "bg-v2-overlay-simple-overlay-hover": props.atActive === key,
                      }}
                      onClick={() => props.onAtSelect(item)}
                      onPointerMove={() => props.setAtActive(key)}
                    >
                      <FileIcon
                        node={{
                          path: isDirectory ? item.path.slice(0, -1) : item.path,
                          type: isDirectory ? "directory" : "file",
                        }}
                        class="shrink-0 size-4"
                      />
                      <div
                        class="flex items-center min-w-0"
                        classList={{
                          "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                            true,
                        }}
                      >
                        <span class="whitespace-nowrap truncate min-w-0 text-v2-text-text-muted">
                          {directory}
                        </span>
                        <span class="whitespace-nowrap text-v2-text-text-base">
                          {name}
                        </span>
                      </div>
                      {/* 目录可以进去看看 —— 光标停在它上面时把这条路说出来,否则没人知道 Tab 有用。 */}
                      <Show when={isDirectory && props.atActive === key}>
                        <div class="ml-auto shrink-0 flex items-center gap-2">
                          <span class="text-[13px] tracking-[-0.04px] [font-weight:440] text-v2-text-text-muted">
                            {props.t("prompt.popover.enterDirectory")}
                          </span>
                          <KeybindV2 keys={["Tab"]} variant="neutral" />
                        </div>
                      </Show>
                    </button>
                  )
                }}
              </For>
            </Show>
          </Match>
          <Match when={props.popover === "slash"}>
            <Show
              when={props.slashFlat.length > 0}
              fallback={
                <div class="px-2 py-1 text-v2-text-text-muted">{props.t("prompt.popover.emptyCommands")}</div>
              }
            >
              <For each={props.slashFlat}>
                {(cmd) => {
                  const keybindParts = () => props.commandKeybindParts(cmd.id)
                  return (
                    <button
                      data-slash-id={cmd.id}
                      classList={{
                        "w-full flex items-center justify-between gap-4 px-2 py-1 rounded-[4px] scroll-my-2": true,
                        "bg-v2-overlay-simple-overlay-hover": props.slashActive === cmd.id,
                      }}
                      onClick={() => props.onSlashSelect(cmd)}
                      onPointerMove={() => props.setSlashActive(cmd.id)}
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <span
                          class="whitespace-nowrap"
                          classList={{
                            "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                              true,
                            "text-v2-text-text-base": true,
                          }}
                        >
                          /{cmd.trigger}
                        </span>
                        <Show when={cmd.description}>
                          <span
                            class="truncate"
                            classList={{
                              "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                                true,
                              "text-v2-text-text-muted": true,
                            }}
                          >
                            {cmd.description}
                          </span>
                        </Show>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={keybindParts().length > 0}>
                          <KeybindV2 keys={keybindParts()} variant="neutral" />
                        </Show>
                      </div>
                    </button>
                  )
                }}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
