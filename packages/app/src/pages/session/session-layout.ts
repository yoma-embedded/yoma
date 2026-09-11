import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { SessionRouteKey, SessionStateKey } from "@/utils/scoped-key"
import { useSDK } from "@/context/sdk"
import { base64Encode } from "@yoma-desktop/util/encode"

export const useSessionKey = () => {
  const params = useParams()
  const sdk = useSDK()
  const directory = createMemo(() => base64Encode(sdk().directory))
  const workspaceKey = createMemo(() => SessionStateKey.from(SessionRouteKey.fromRoute(directory())))
  const sessionKey = createMemo(() => SessionStateKey.from(SessionRouteKey.fromRoute(directory(), params.id)))
  return { params, sessionKey, workspaceKey }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, sessionKey, workspaceKey } = useSessionKey()
  return {
    params,
    sessionKey,
    workspaceKey,
    tabs: createMemo(() => layout.tabs(sessionKey)),
    view: createMemo(() => layout.view(sessionKey)),
  }
}
