/**
 * 标题栏的状态指示灯。
 *
 * 原来这颗灯同时反映两件事:服务器健康 + MCP 客户端状态(黄=需要授权,红=连不上)。
 * my-pi 没有 MCP,于是只剩服务器健康 —— 三态变两态,目录作用域和服务器作用域也就
 * 没有区别了,`StatusPopoverV2` 的 `scope` 参数随之消失。
 */

import { Button } from "@yoma-desktop/ui/button"
import { Icon } from "@yoma-desktop/ui/icon"
import { IconButtonV2 } from "@yoma-desktop/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@yoma-desktop/ui/v2/icon"
import { Popover } from "@yoma-desktop/ui/popover"
import { Suspense, createMemo, createSignal, lazy, Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useGlobal } from "@/context/global"

const ServerBody = lazy(() => import("./status-popover-body").then((x) => ({ default: x.StatusPopoverServerBody })))

export function StatusPopover() {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const [shown, setShown] = createSignal(false)
  const health = () => global.servers.health[server.key]?.healthy

  return (
    <Popover
      open={shown()}
      onOpenChange={setShown}
      triggerAs={Button}
      triggerProps={{
        variant: "ghost",
        class: "titlebar-icon w-8 h-6 p-0 box-border",
        "aria-label": language.t("status.popover.trigger"),
        style: { scale: 1 },
      }}
      trigger={
        <div class="relative size-4">
          <div class="badge-mask-tight size-4 flex items-center justify-center">
            <Icon name={shown() ? "status-active" : "status"} size="small" />
          </div>
          <div
            classList={{
              "absolute -top-px -right-px size-1.5 rounded-full": true,
              "bg-icon-success-base": health() === true,
              "bg-icon-critical-base": health() === false,
              "bg-border-weak-base": health() === undefined,
            }}
          />
        </div>
      }
      class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl"
      gutter={4}
      placement="bottom-end"
      shift={-168}
    >
      <StatusPopoverBody shown={shown()}>
        <ServerBody />
      </StatusPopoverBody>
    </Popover>
  )
}

export function StatusPopoverV2() {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const [shown, setShown] = createSignal(false)
  const serverHealth = () => global.servers.health[server.key]?.healthy
  const state = createMemo<StatusPopoverState>(() => ({
    shown: shown(),
    serverHealth: serverHealth(),
    label: language.t("status.popover.trigger"),
    onOpenChange: setShown,
    body: () => (
      <StatusPopoverBody shown={shown()}>
        <ServerBody />
      </StatusPopoverBody>
    ),
  }))

  return <StatusPopoverView state={state()} />
}

type StatusPopoverState = {
  shown: boolean
  serverHealth: boolean | undefined
  label: string
  onOpenChange: (value: boolean) => void
  body: () => JSX.Element
}

function StatusPopoverBody(props: { shown: boolean; children: JSX.Element }) {
  return (
    <Show when={props.shown}>
      <Suspense
        fallback={<div class="w-[360px] h-14 rounded-xl bg-background-strong shadow-[var(--shadow-lg-border-base)]" />}
      >
        {props.children}
      </Suspense>
    </Show>
  )
}

function StatusPopoverView(props: { state: StatusPopoverState }) {
  const statusDotClass = () => ({
    "absolute rounded-full": true,
    "bg-icon-success-base": props.state.serverHealth === true,
    "bg-icon-critical-base": props.state.serverHealth === false,
    "bg-border-weak-base": props.state.serverHealth === undefined,
  })

  const popoverProps = {
    class:
      "[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl",
    gutter: 4,
    placement: "bottom-end" as const,
    shift: -168,
  }

  return (
    <Popover
      open={props.state.shown}
      onOpenChange={props.state.onOpenChange}
      triggerAs={IconButtonV2}
      triggerProps={{
        variant: "ghost-muted",
        size: "large",
        class: "!w-9 shrink-0",
        state: props.state.shown ? "pressed" : undefined,
        "aria-label": props.state.label,
      }}
      trigger={
        <div class="relative size-4">
          <IconV2 name={props.state.shown ? "status-active" : "status"} />
          <div
            classList={statusDotClass()}
            class="-top-1 -right-1 size-2 border border-[var(--v2-background-bg-deep)]"
          />
        </div>
      }
      {...popoverProps}
    >
      {props.state.body()}
    </Popover>
  )
}
