/**
 * 状态弹层的内容。
 *
 * 原来有四个 tab:servers / mcp / lsp / plugins。后三个跟着内核一起没了 ——
 * my-pi 没有 MCP 客户端、没有 LSP 集成、也没有 opencode.json 的插件表。
 * 剩下的只有服务器健康,所以这里只留一个视图,不再是 Tabs。
 */

import { Button } from "@yoma-desktop/ui/button"
import { useDialog } from "@yoma-desktop/ui/context/dialog"
import { Icon } from "@yoma-desktop/ui/icon"
import { Tabs } from "@yoma-desktop/ui/tabs"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { type ServerHealth } from "@/utils/server-health"
import { useGlobal } from "@/context/global"

const listServersByHealth = (
  list: ServerConnection.Any[],
  active: ServerConnection.Key | undefined,
  status: Record<ServerConnection.Key, ServerHealth | undefined>,
) => {
  if (!list.length) return list
  const order = new Map(list.map((url, index) => [url, index] as const))
  const rank = (value?: ServerHealth) => {
    if (value?.healthy === true) return 0
    if (value?.healthy === false) return 2
    return 1
  }

  return list.slice().sort((a, b) => {
    if (ServerConnection.key(a) === active) return -1
    if (ServerConnection.key(b) === active) return 1
    const diff = rank(status[ServerConnection.key(a)]) - rank(status[ServerConnection.key(b)])
    if (diff !== 0) return diff
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

const useDefaultServerKey = (
  get: (() => string | Promise<string | null | undefined> | null | undefined) | undefined,
) => {
  const [state, setState] = createStore({
    key: undefined as ServerConnection.Key | undefined,
    tick: 0,
  })

  createEffect(() => {
    state.tick
    let dead = false
    const result = get?.()
    if (!result) {
      setState("key", undefined)
      onCleanup(() => {
        dead = true
      })
      return
    }

    if (result instanceof Promise) {
      void result.then((next) => {
        if (dead) return
        setState("key", next ?? undefined)
      })
      onCleanup(() => {
        dead = true
      })
      return
    }

    setState("key", ServerConnection.Key.make(result))
    onCleanup(() => {
      dead = true
    })
  })

  return {
    key: () => {
      return state.key
    },
    refresh: () => setState("tick", (value) => value + 1),
  }
}

type ServerStatusState = {
  servers: () => ServerStatusItem[]
  defaultKey: () => ServerConnection.Key | undefined
  ariaLabel: string
  serversLabel: string
  defaultLabel: string
  manageLabel: string
  onManage: () => void
}

type ServerStatusItem = {
  key: ServerConnection.Key
  conn: ServerConnection.Any
  health?: ServerHealth
  blocked: boolean
  active: boolean
  onSelect: () => void
}

export function StatusPopoverServerBody() {
  const global = useGlobal()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })

  const sortedServers = createMemo(() => listServersByHealth(global.servers.list(), server.key, global.servers.health))
  const defaultServer = useDefaultServerKey(platform.getDefaultServer)
  const serverItems = createMemo(() =>
    sortedServers().map((conn) => {
      const key = ServerConnection.key(conn)
      return {
        key,
        conn,
        health: global.servers.health[key],
        blocked: global.servers.health[key]?.healthy === false,
        active: !!server.current && key === ServerConnection.key(server.current),
        onSelect: () => {
          navigate("/")
          queueMicrotask(() => server.setActive(key))
        },
      }
    }),
  )

  return (
    <ServerStatusPopoverView
      state={{
        servers: serverItems,
        defaultKey: defaultServer.key,
        ariaLabel: language.t("status.popover.ariaLabel"),
        serversLabel: language.t("status.popover.tab.servers"),
        defaultLabel: language.t("common.default"),
        manageLabel: language.t("status.popover.action.manageServers"),
        onManage: () => {
          const run = ++dialogRun
          void import("./dialog-select-server").then((x) => {
            if (dialogDead || dialogRun !== run) return
            dialog.show(() => <x.DialogSelectServer />, defaultServer.refresh)
          })
        },
      }}
    />
  )
}

function ServerStatusPopoverView(props: { state: ServerStatusState }) {
  return (
    <div class="flex items-center gap-1 w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">
      <Tabs
        aria-label={props.state.ariaLabel}
        class="tabs bg-background-strong rounded-xl overflow-hidden"
        data-component="tabs"
        data-active="servers"
        defaultValue="servers"
        variant="alt"
      >
        <Tabs.List data-slot="tablist" class="bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10">
          <Tabs.Trigger value="servers" data-slot="tab" class="text-12-regular">
            {props.state.servers().length > 0 ? `${props.state.servers().length} ` : ""}
            {props.state.serversLabel}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="servers">
          <ServerStatusList state={props.state} />
        </Tabs.Content>
      </Tabs>
    </div>
  )
}

function ServerStatusList(props: { state: ServerStatusState }) {
  return (
    <div class="flex flex-col px-2 pb-2">
      <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
        <For each={props.state.servers()}>
          {(item) => {
            return (
              <button
                type="button"
                class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                classList={{
                  "hover:bg-surface-raised-base-hover": !item.blocked,
                  "cursor-not-allowed": item.blocked,
                }}
                aria-disabled={item.blocked}
                onClick={() => {
                  if (item.blocked) return
                  item.onSelect()
                }}
              >
                <ServerHealthIndicator health={item.health} />
                <ServerRow
                  conn={item.conn}
                  dimmed={item.blocked}
                  status={item.health}
                  class="flex items-center gap-2 w-full min-w-0"
                  nameClass="text-14-regular text-text-base truncate"
                  versionClass="text-12-regular text-text-weak truncate"
                  badge={
                    <Show when={item.key === props.state.defaultKey()}>
                      <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                        {props.state.defaultLabel}
                      </span>
                    </Show>
                  }
                >
                  <div class="flex-1" />
                  <Show when={item.active}>
                    <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                  </Show>
                </ServerRow>
              </button>
            )
          }}
        </For>

        <Button variant="secondary" class="mt-3 self-start h-8 px-3 py-1.5" onClick={props.state.onManage}>
          {props.state.manageLabel}
        </Button>
      </div>
    </div>
  )
}
