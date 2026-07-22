import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { DropdownMenu } from "@yoma-desktop/ui/dropdown-menu"
import { Icon } from "@yoma-desktop/ui/icon"
import { IconButton } from "@yoma-desktop/ui/icon-button"
import { Tooltip } from "@yoma-desktop/ui/tooltip"

import { Terminal } from "@/components/terminal"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { terminalTabLabel } from "@/pages/session/terminal-label"
import { focusTerminalById } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { debug as dock } from "@/pages/session/debug/debug-data"

type TranslateFn = (key: string, vars?: Record<string, string | number | boolean>) => string

/** 列表里的一行终端：点击切换，双击重命名，悬停出现关闭按钮 */
function TerminalListRow(props: { pty: LocalPTY; active: boolean; onSelect: () => void; onClose: () => void }) {
  const terminal = useTerminal()
  const language = useLanguage()
  const [store, setStore] = createStore({ editing: false, title: "", blurEnabled: false })
  let input: HTMLInputElement | undefined
  let blurFrame: number | undefined

  const label = () => {
    language.locale()
    return terminalTabLabel({
      title: props.pty.title,
      titleNumber: props.pty.titleNumber,
      t: language.t as TranslateFn,
    })
  }

  const edit = (e: Event) => {
    e.stopPropagation()
    e.preventDefault()
    setStore({ blurEnabled: false, title: props.pty.title, editing: true })
  }

  const save = () => {
    if (!store.blurEnabled) return
    const value = store.title.trim()
    if (value && value !== props.pty.title) {
      terminal.update({ id: props.pty.id, title: value })
    }
    setStore("editing", false)
  }

  const keydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      save()
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      setStore("editing", false)
    }
  }

  createEffect(() => {
    if (!store.editing || !input) return
    input.focus()
    input.select()
    if (blurFrame !== undefined) cancelAnimationFrame(blurFrame)
    blurFrame = requestAnimationFrame(() => {
      blurFrame = undefined
      setStore("blurEnabled", true)
    })
  })

  onCleanup(() => {
    if (blurFrame !== undefined) cancelAnimationFrame(blurFrame)
  })

  return (
    <div
      role="button"
      tabIndex={0}
      class="group relative h-7 shrink-0 px-2 rounded-md flex items-center gap-2 cursor-pointer select-none"
      classList={{
        "bg-background-stronger": props.active,
        "hover:bg-background-stronger": !props.active,
      }}
      aria-current={props.active ? "true" : undefined}
      onClick={() => props.onSelect()}
      onKeyDown={(e) => {
        // 只处理行本身的按键；嵌套的重命名输入框/关闭按钮的按键不拦（否则重命名打不出空格）
        if (e.target !== e.currentTarget) return
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        props.onSelect()
      }}
    >
      <Icon name="terminal" size="small" class="shrink-0 text-text-weak" />
      <span class="flex-1 min-w-0 truncate text-13-regular" onDblClick={edit} classList={{ invisible: store.editing }}>
        {label()}
      </span>
      <Show when={store.editing}>
        <div class="absolute inset-y-0 left-7 right-1 flex items-center z-10">
          <input
            ref={input}
            type="text"
            value={store.title}
            onInput={(e) => setStore("title", e.currentTarget.value)}
            onBlur={save}
            onKeyDown={keydown}
            onClick={(e) => e.stopPropagation()}
            class="w-full bg-transparent border-none outline-none text-13-regular"
          />
        </div>
      </Show>
      <IconButton
        icon="close-small"
        variant="ghost"
        class="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        classList={{ invisible: store.editing }}
        onClick={(e) => {
          e.stopPropagation()
          props.onClose()
        }}
        aria-label={language.t("terminal.close")}
      />
    </div>
  )
}

/** 右栏 cmd 模式：真实终端（复用 workspace PTY），头部列表按钮可展开终端列表栏 */
export function CmdPanel() {
  const terminal = useTerminal()
  const language = useLanguage()
  const sdk = useSDK()
  const { view } = useSessionLayout()

  const [store, setStore] = createStore({
    autoCreated: false,
    recovered: {} as Record<string, boolean>,
  })

  // 本机可用 shell（服务端 /pty/shells 检测）；拿不到时加号退化为直接新建默认终端
  const [shells, setShells] = createSignal<{ path: string; name: string; acceptable: boolean }[]>([])
  onMount(() => {
    sdk()
      .client.pty.shells(undefined, { throwOnError: false })
      .then((result) => {
        if (Array.isArray(result.data)) setShells(result.data)
      })
      .catch(() => {})
  })

  // 底部终端面板打开时同一 PTY 会被双挂载（两个 WebSocket 互抢尺寸），此时这里让位
  const bottomOpen = createMemo(() => view().terminal.opened())

  const active = createMemo(() => {
    const id = terminal.active()
    return terminal.all().find((pty) => pty.id === id)
  })

  // 首次就绪时若无终端则自建一个；标记与是否创建无关，否则挂载时已有终端的场景下，
  // 关掉最后一个会被这里立刻重建，空态永远显示不出来
  createEffect(() => {
    if (!terminal.ready() || store.autoCreated) return
    if (terminal.all().length === 0) terminal.new()
    setStore("autoCreated", true)
  })

  createEffect(
    on(
      () => [terminal.active(), bottomOpen(), terminal.ready()] as const,
      ([id, bottom, ready]) => {
        if (!id || bottom || !ready) return
        const frame = requestAnimationFrame(() => {
          if (terminal.active() !== id) return
          focusTerminalById(id)
        })
        onCleanup(() => cancelAnimationFrame(frame))
      },
    ),
  )

  const activeLabel = () => {
    language.locale()
    const pty = active()
    if (!pty) return language.t("terminal.title")
    return terminalTabLabel({ title: pty.title, titleNumber: pty.titleNumber, t: language.t as TranslateFn })
  }

  const select = (id: string) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    terminal.open(id)
    focusTerminalById(id)
  }

  const recoveryKey = (pty: LocalPTY) => String(pty.titleNumber || pty.title || pty.id)

  const recoverTerminal = (key: string, id: string, clone: (id: string) => Promise<void>) => {
    if (store.recovered[key]) return
    setStore("recovered", key, true)
    void clone(id)
  }

  const markTerminalConnected = (key: string, id: string, trim: (id: string) => void) => {
    setStore("recovered", key, false)
    trim(id)
  }

  return (
    <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* 头部：列表开关 + 活动终端标题 + 新建 */}
      <div class="h-9 shrink-0 flex items-center gap-2 px-1.5 border-b border-border-weaker-base">
        <Tooltip placement="bottom" value={language.t("terminal.list")}>
          <button
            type="button"
            class="h-6 min-w-7 px-1.5 rounded-md flex items-center justify-center shrink-0"
            classList={{
              "bg-background-stronger": dock.cmdList(),
              "text-text-weak hover:bg-background-stronger": !dock.cmdList(),
            }}
            onClick={() => dock.toggleCmdList()}
            aria-label={language.t("terminal.list")}
            aria-pressed={dock.cmdList() ? "true" : "false"}
          >
            <Icon name="bullet-list" size="small" />
          </button>
        </Tooltip>
        <div class="min-w-0 truncate text-14-regular">{activeLabel()}</div>
      </div>

      <div class="flex-1 min-h-0 flex">
        {/* 终端列表栏：计数 + 新建（弹泡选 shell）+ 终端行 */}
        <Show when={dock.cmdList()}>
          <div class="w-44 shrink-0 border-r border-border-weaker-base flex flex-col overflow-hidden">
            <div class="h-8 shrink-0 flex items-center gap-1 pl-3 pr-1.5">
              <div class="flex-1 min-w-0 truncate text-12-regular text-text-weak">
                {language.t(terminal.all().length === 1 ? "terminal.count.one" : "terminal.count.other", {
                  count: terminal.all().length,
                })}
              </div>
              <Show
                when={shells().length > 0}
                fallback={
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    class="size-6 rounded-md"
                    onClick={() => terminal.new()}
                    aria-label={language.t("command.terminal.new")}
                  />
                }
              >
                <DropdownMenu>
                  <DropdownMenu.Trigger
                    as={IconButton}
                    icon="plus-small"
                    variant="ghost"
                    class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                    aria-label={language.t("command.terminal.new")}
                  />
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content>
                      <For each={shells()}>
                        {(shell) => (
                          <DropdownMenu.Item
                            onSelect={() => terminal.new({ command: shell.path, title: shell.name })}
                          >
                            <Icon name="terminal" class="w-4 h-4 mr-2" />
                            {shell.name}
                          </DropdownMenu.Item>
                        )}
                      </For>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </Show>
            </div>
            <div class="flex-1 min-h-0 overflow-y-auto px-1.5 pb-1.5 flex flex-col gap-0.5">
              <For each={terminal.all()}>
                {(pty) => (
                  <TerminalListRow
                    pty={pty}
                    active={terminal.active() === pty.id}
                    onSelect={() => select(pty.id)}
                    onClose={() => void terminal.close(pty.id)}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* 终端内容 */}
        <div class="flex-1 min-w-0 relative">
          <Switch>
            <Match when={!terminal.ready()}>
              <div class="h-full flex items-center justify-center text-12-regular text-text-weak">
                {language.t("terminal.loading")}
              </div>
            </Match>
            <Match when={bottomOpen()}>
              <div class="h-full flex flex-col items-center justify-center gap-3 text-center px-4">
                <div class="text-12-regular text-text-weak">{language.t("terminal.openInBottomPanel")}</div>
                <button
                  type="button"
                  class="h-6 px-2 rounded-md text-12-regular text-text-weak hover:bg-background-stronger border border-border-weaker-base"
                  onClick={() => view().terminal.close()}
                >
                  {language.t("terminal.moveHere")}
                </button>
              </div>
            </Match>
            <Match when={active()}>
              <Show when={terminal.active()} keyed>
                {(id) => {
                  const ops = terminal.bind()
                  return (
                    <Show when={terminal.all().find((pty) => pty.id === id)}>
                      {(pty) => (
                        <div id={`terminal-wrapper-${id}`} class="absolute inset-0">
                          <Terminal
                            pty={pty()}
                            autoFocus
                            fontSize={13}
                            onConnect={() => markTerminalConnected(recoveryKey(pty()), id, ops.trim)}
                            onCleanup={ops.update}
                            onConnectError={() => recoverTerminal(recoveryKey(pty()), id, ops.clone)}
                          />
                        </div>
                      )}
                    </Show>
                  )
                }}
              </Show>
            </Match>
            <Match when={true}>
              <div class="h-full flex flex-col items-center justify-center gap-3 text-center px-4">
                <div class="text-12-regular text-text-weak">{language.t("terminal.title")}</div>
                <button
                  type="button"
                  class="h-6 px-2 rounded-md text-12-regular text-text-weak hover:bg-background-stronger border border-border-weaker-base"
                  onClick={() => terminal.new()}
                >
                  {language.t("command.terminal.new")}
                </button>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  )
}
