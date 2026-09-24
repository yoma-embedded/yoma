import { Show, type JSX } from "solid-js"
import { SessionConfirmDock } from "@/pages/session/composer/session-confirm-dock"
import { SessionQueueDock } from "@/pages/session/composer/session-queue-dock"
import { SessionBtwDock } from "@/pages/session/composer/session-btw-dock"
import { SubagentDock } from "@/pages/session/subagent/subagent-dock"
import type { SessionComposerRegionController } from "./session-composer-region-controller"

export function SessionComposerRegion(props: {
  controller: SessionComposerRegionController
  promptInput: JSX.Element
}) {
  const controller = props.controller

  return (
    <div
      ref={controller.setDockRef}
      data-component="session-prompt-dock"
      classList={{
        "w-full shrink-0 flex flex-col justify-center items-center pb-3 pointer-events-none bg-v2-background-bg-base": true,
      }}
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": controller.centered(),
        }}
      >
        <div
          classList={{
            "relative z-[70]": true,
          }}
        >
          <Show when={controller.confirms()?.items.length}>
            <SessionConfirmDock
              items={controller.confirms()!.items}
              replying={controller.confirms()!.replying}
              onReply={controller.confirms()!.onReply}
              attached={!controller.subagents()?.items.length && !controller.queue()?.items.length && !controller.btw()}
            />
          </Show>
          {/* 子 agent 坞:缺省后台之后"现在有谁在跑"必须有个不随对话滚动的位置。 */}
          <Show when={controller.subagents()?.items.length}>
            <SubagentDock
              items={controller.subagents()!.items}
              onOpen={controller.subagents()!.onOpen}
              onStop={controller.subagents()!.onStop}
              onStopAll={controller.subagents()!.onStopAll}
              attached={!controller.queue()?.items.length && !controller.btw()}
            />
          </Show>
          <Show when={controller.queue()?.items.length}>
            <SessionQueueDock
              items={controller.queue()!.items}
              retracting={controller.queue()!.retracting}
              onRetract={controller.queue()!.onRetract}
              attached={!controller.btw()}
            />
          </Show>
          {/* /btw 顺便问一句:紧贴输入框,答案离视线最近。 */}
          <Show when={controller.btw()}>
            {(btw) => (
              <SessionBtwDock
                view={btw().view}
                forking={btw().forking}
                onDismiss={btw().onDismiss}
                onFork={btw().onFork}
                onCopy={btw().onCopy}
                attached
              />
            )}
          </Show>
          {props.promptInput}
        </div>
      </div>
    </div>
  )
}
