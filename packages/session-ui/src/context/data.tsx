import type { Message, Session, Part, SessionStatus, ProviderInfo, TaskView, ToolPart } from "@yoma-desktop/kernel"
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
  /**
   * 子 agent 任务的实时状态,按任务 id(= 子会话 id)。宿主从 `task.updated` 事件与 `task.list` 折出来;
   * 没有这一份时 agent 卡片只剩工具交回那一刻的快照(后台派出的任务就只能说"已转到后台")。
   */
  task?: {
    [taskID: string]: TaskView
  }
}

/** 对一个子 agent 任务做点什么(停止 / 转后台)。 */
export type TaskActionFn = (taskID: string) => void

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

/** 跳转到本机文件的某一行(目前只有 gdb 停在有源码的位置时会用到)。 */
export type OpenFileFn = (path: string, line?: number) => void

/**
 * 有仪器面板的那几个工具。名字就是仪器 id —— app 的 `bench/instruments.ts` 与这里用的是
 * 同一套词,加一台仪器时两边各加一条字符串,没有第三处。
 *
 * **flash 不在里面**:它是一个动作不是一台仪器,没有面板可打开。
 */
export type InstrumentTool = "log" | "gdb" | "la" | "scope"

/**
 * 「把这张卡片的仪器在面板里打开」。宿主决定"打开"意味着什么 —— 底部控制台的一页签、
 * 右栏的一台、一个抽屉都行。`part` 原样递过去:宿主可以从它的 `state.metadata` 里认出
 * 这一次采集(la / scope 的 `captureId` / `dir`),而 session-ui 不必知道那些字段。
 *
 * **宿主不给这个回调时,卡片上那个按钮一个像素都不渲染。** session-ui 不知道也不该知道
 * 现在跑的是哪一套布局:有的布局里"打开面板"这件事根本不存在。
 */
export type OpenInstrumentFn = (instrument: InstrumentTool, part: ToolPart) => void

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
    onOpenFile?: OpenFileFn
    onOpenInstrument?: OpenInstrumentFn
    /** agent 卡片上的「停止」。不给就不渲染那个按钮。 */
    onStopTask?: TaskActionFn
    /** agent 卡片上的「转到后台」(只对前台在跑的任务)。不给就不渲染那个按钮。 */
    onBackgroundTask?: TaskActionFn
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
      // getter:宿主可以在挂载之后才把它接上,而卡片上的按钮要跟着出现/消失。
      get openInstrument() {
        return props.onOpenInstrument
      },
      get stopTask() {
        return props.onStopTask
      },
      get backgroundTask() {
        return props.onBackgroundTask
      },
    }
  },
})
