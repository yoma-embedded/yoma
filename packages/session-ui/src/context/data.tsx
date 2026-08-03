import type { Message, Session, Part, SessionStatus, ProviderInfo } from "@yoma-desktop/kernel"
import { createSimpleContext } from "@yoma-desktop/ui/context"

export type NormalizedProviderListResponse = {
  all: Map<string, ProviderInfo>
  default: {
    [key: string]: string
  }
  connected: Array<string>
}

type Data = {
  provider?: NormalizedProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
  part_text_accum_delta?: {
    [partID: string]: string
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

/** 跳转到本机文件的某一行(目前只有 gdb 停在有源码的位置时会用到)。 */
export type OpenFileFn = (path: string, line?: number) => void

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    onOpenFile?: OpenFileFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
      openFile: props.onOpenFile,
    }
  },
})
