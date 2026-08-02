import { Show, type JSX } from "solid-js"
import { useSettings } from "@/context/settings"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import type { SessionComposerRegionController } from "./session-composer-region-controller"

export function SessionComposerRegion(props: {
  controller: SessionComposerRegionController
  promptInput: JSX.Element
}) {
  const controller = props.controller
  const settings = useSettings()

  return (
    <div
      ref={controller.setDockRef}
      data-component="session-prompt-dock"
      classList={{
        "w-full shrink-0 flex flex-col justify-center items-center pb-3 pointer-events-none": true,
        "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
        "bg-background-stronger": !settings.general.newLayoutDesigns(),
      }}
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": controller.centered(),
        }}
      >
        <Show when={controller.state.permissionRequest()} keyed>
          {(request) => (
            <div>
              <SessionPermissionDock
                request={request}
                responding={controller.state.permissionResponding()}
                onDecide={(response) => {
                  controller.onResponseSubmit()
                  controller.state.decide(response)
                }}
              />
            </div>
          )}
        </Show>

        <Show when={controller.showComposer()}>
          <div
            classList={{
              "relative z-[70]": true,
            }}
          >
            <Show when={controller.followup()?.items.length}>
              <SessionFollowupDock
                items={controller.followup()!.items}
                sending={controller.followup()!.sending}
                onSend={controller.followup()!.onSend}
                onEdit={controller.followup()!.onEdit}
              />
            </Show>
            <Show when={!controller.state.blocked()}>{props.promptInput}</Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
