import { Component, For, Match, Show, Switch } from "solid-js"
import { FileIcon } from "@yoma-desktop/ui/file-icon"
import { KeybindV2 } from "@yoma-desktop/ui/v2/keybind-v2"
import { getDirectory, getFilename } from "@yoma-desktop/util/path"

/**
 * `@` 提及只剩文件。
 *
 * 删掉的三种 —— agent(内核只有一个系统提示词,没有 persona)、resource(没有 MCP)、
 * reference(没有 config 里的 reference 注册表)。
 */
export type AtOption = { type: "file"; path: string; display: string; recent?: boolean }

/** `/` 命令只剩前端内置的那些:内核没有自定义命令,也没有 MCP prompt / skill。 */
export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
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
  commandKeybind: (id: string) => string | undefined
  commandKeybindParts: (id: string) => string[]
  newLayoutDesigns: boolean
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
          "z-[70] rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]": props.newLayoutDesigns,
          "rounded-[12px] bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)]":
            !props.newLayoutDesigns,
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show
              when={props.atFlat.length > 0}
              fallback={
                <div
                  class="px-2 py-1"
                  classList={{
                    "text-v2-text-text-muted": props.newLayoutDesigns,
                    "text-text-weak": !props.newLayoutDesigns,
                  }}
                >
                  {props.t("prompt.popover.emptyResults")}
                </div>
              }
            >
              <For each={props.atFlat.slice(0, 10)}>
                {(item) => {
                  const key = props.atKey(item)

                  const isDirectory = item.path.endsWith("/")
                  const directory = isDirectory ? item.path : getDirectory(item.path)
                  const filename = isDirectory ? "" : getFilename(item.path)

                  return (
                    <button
                      class="w-full flex items-center gap-x-2 px-2 py-0.5"
                      classList={{
                        "rounded-[4px]": props.newLayoutDesigns,
                        "rounded-md": !props.newLayoutDesigns,
                        "bg-v2-overlay-simple-overlay-hover": props.newLayoutDesigns && props.atActive === key,
                        "bg-surface-raised-base-hover": !props.newLayoutDesigns && props.atActive === key,
                      }}
                      onClick={() => props.onAtSelect(item)}
                      onPointerMove={() => props.setAtActive(key)}
                    >
                      <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-4" />
                      <div
                        class="flex items-center min-w-0"
                        classList={{
                          "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                            props.newLayoutDesigns,
                          "text-14-regular": !props.newLayoutDesigns,
                        }}
                      >
                        <span
                          class="whitespace-nowrap truncate min-w-0"
                          classList={{
                            "text-v2-text-text-muted": props.newLayoutDesigns,
                            "text-text-weak": !props.newLayoutDesigns,
                          }}
                        >
                          {directory}
                        </span>
                        <Show when={!isDirectory}>
                          <span
                            class="whitespace-nowrap"
                            classList={{
                              "text-v2-text-text-base": props.newLayoutDesigns,
                              "text-text-strong": !props.newLayoutDesigns,
                            }}
                          >
                            {filename}
                          </span>
                        </Show>
                      </div>
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
                <div
                  class="px-2 py-1"
                  classList={{
                    "text-v2-text-text-muted": props.newLayoutDesigns,
                    "text-text-weak": !props.newLayoutDesigns,
                  }}
                >
                  {props.t("prompt.popover.emptyCommands")}
                </div>
              }
            >
              <For each={props.slashFlat}>
                {(cmd) => {
                  const keybind = () => props.commandKeybind(cmd.id)
                  const keybindParts = () => props.commandKeybindParts(cmd.id)
                  return (
                    <button
                      data-slash-id={cmd.id}
                      classList={{
                        "w-full flex items-center justify-between gap-4 px-2 py-1": true,
                        "rounded-[4px] scroll-my-2": props.newLayoutDesigns,
                        "rounded-md": !props.newLayoutDesigns,
                        "bg-v2-overlay-simple-overlay-hover": props.newLayoutDesigns && props.slashActive === cmd.id,
                        "bg-surface-raised-base-hover": !props.newLayoutDesigns && props.slashActive === cmd.id,
                      }}
                      onClick={() => props.onSlashSelect(cmd)}
                      onPointerMove={() => props.setSlashActive(cmd.id)}
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <span
                          class="whitespace-nowrap"
                          classList={{
                            "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                              props.newLayoutDesigns,
                            "text-v2-text-text-base": props.newLayoutDesigns,
                            "text-14-regular": !props.newLayoutDesigns,
                            "text-text-strong": !props.newLayoutDesigns,
                          }}
                        >
                          /{cmd.trigger}
                        </span>
                        <Show when={cmd.description}>
                          <span
                            class="truncate"
                            classList={{
                              "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                                props.newLayoutDesigns,
                              "text-v2-text-text-muted": props.newLayoutDesigns,
                              "text-14-regular": !props.newLayoutDesigns,
                              "text-text-weak": !props.newLayoutDesigns,
                            }}
                          >
                            {cmd.description}
                          </span>
                        </Show>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={props.newLayoutDesigns ? keybindParts().length > 0 : keybind()}>
                          <Show
                            when={props.newLayoutDesigns}
                            fallback={<span class="text-12-regular text-text-subtle">{keybind()}</span>}
                          >
                            <KeybindV2 keys={keybindParts()} variant="neutral" />
                          </Show>
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
