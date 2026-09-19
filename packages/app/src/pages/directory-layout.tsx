import { DataProvider } from "@yoma-desktop/session-ui/context"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@yoma-desktop/util/encode"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, createResource, onCleanup, type ParentProps, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { LocalProvider } from "@/context/local"
import { SDKProvider } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { decode64 } from "@/utils/base64"
import { Schema } from "effect"
import { sessionHref } from "@/utils/session-href"
import { useServerSync } from "@/context/server-sync"
import { INSTRUMENT_IDS, type InstrumentId } from "@/pages/session/bench/bench-status"
import { revealInstrument, usedInstrumentContext } from "@/pages/session/console/reveal-instrument"
import { kernel } from "@/utils/kernel"
import { formatServerError } from "@/utils/server-errors"

/**
 * 时间线里的硬件卡片按「在面板中打开」时走这里 —— v2-console 把它翻成"按数据形状去对应的
 * 容器":日志 / 调试器打开底部控制台的那一页签,逻辑分析仪 / 示波器切右栏的那一台。
 * 规则一份不二(`reveal-instrument.ts`),与最底下状态栏点一格走的是同一条。
 *
 * 认不出来的名字一律无视(而不是抛):session-ui 那边的工具清单与 app 的注册表各有一份,
 * 两边漂移时该表现为"那个按钮没反应",不该是一个红屏。
 *
 * 第二个参数是那张卡片的 part。**这套布局用不上它**:右栏的 LA / 示波器面板各自管着自己的
 * "当前采集"(内部 store,没有外部可控入口),硬造一个入口不是这一刀该干的事 ——
 * 所以这里只切页签,选哪一次采集仍由面板自己的下拉决定。
 */
function openInstrument(id: string) {
  const known: readonly string[] = INSTRUMENT_IDS
  if (!known.includes(id)) return
  const instrument = id as InstrumentId
  revealInstrument(instrument, usedInstrumentContext(instrument))
}

export function DirectoryDataProvider(
  props: ParentProps<{
    directory: string | Accessor<string>
    draftID?: string
    /** 会话路由(/session/:id)下挂着:那里没有 /:dir 段可以归一化。 */
    sessionRoute?: boolean
  }>,
) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useSync()
  const serverSync = useServerSync()
  const directory = () => (typeof props.directory === "function" ? props.directory() : props.directory)
  const slug = createMemo(() => base64Encode(directory()))
  const href = (sessionID: string) => sessionHref(sessionID)
  const language = useLanguage()

  // 子 agent 任务的「停止」「转到后台」(agent 卡片与状态栏的任务面板共用这一份)。不等结果:状态变化随
  // task.updated 回来;否定的回答(stopped / moved 为 false)= 它刚好已经结束或已经在后台,按钮随下一条事件消失,
  // 不必提示。只有请求本身失败(内核断开)才弹一句。
  const taskAction = (run: (taskID: string) => Promise<unknown>) => (taskID: string) => {
    void run(taskID).catch((error: unknown) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(error, language.t),
      }),
    )
  }
  const stopTask = taskAction((taskID) => kernel.task.stop({ taskID }))
  const backgroundTask = taskAction((taskID) => kernel.task.background({ taskID }))

  createEffect(() => {
    // A draft lives at /new-session?draftId=… and has no directory segment to normalize.
    if (props.draftID || props.sessionRoute) return
    const next = sync().data.path.directory
    if (!next || next === directory()) return
    const path = location.pathname.slice(slug().length + 1)
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  createResource(
    () => params.id,
    (id) =>
      sync()
        .session.sync(id)
        .catch(() => {}),
  )

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return
    serverSync().session.pin(sessionID)
    onCleanup(() => serverSync().session.unpin(sessionID))
  })

  return (
    <Show when={directory()} keyed>
      {(directory) => (
        <DataProvider
          data={sync().data}
          directory={directory}
          onNavigateToSession={(sessionID: string) => navigate(href(sessionID))}
          onSessionHref={href}
          onOpenInstrument={openInstrument}
          onStopTask={stopTask}
          onBackgroundTask={backgroundTask}
        >
          <LocalProvider>{props.children}</LocalProvider>
        </DataProvider>
      )}
    </Show>
  )
}

export const ProjectDirString = Schema.String.pipe(Schema.brand("ProjectDirString"))
export type ProjectDirString = Schema.Schema.Type<typeof ProjectDirString>

export function decodeDirectory(dir: string): ProjectDirString | undefined {
  const decoded = decode64(dir)
  if (!decoded) return
  return ProjectDirString.make(decoded)
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  let invalid = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decodeDirectory(params.dir) ?? ""
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  return (
    <Show when={resolved()} keyed>
      {(resolved) => (
        <SDKProvider directory={resolved}>
          <DirectoryDataProvider directory={resolved}>{props.children}</DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}
