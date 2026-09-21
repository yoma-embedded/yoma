import { type Accessor, createEffect, createResource } from "solid-js"
import type { ToolConfirmView } from "@yoma-desktop/kernel"
import type { PromptInputState } from "@/components/prompt-input"
import type { DockTask } from "@/pages/session/subagent/task-view"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"

/** 工具确认条(烧录前先问一声):未决的询问 + 正在回复的那条 + 回复动作。 */
export type SessionComposerConfirmDock = {
  items: ToolConfirmView[]
  replying?: string
  onReply: (id: string, allow: boolean) => void
}

/** 固定的「子 agent」坞:还没完事的任务(排队中 / 在跑 / 待汇报)+ 打开、停止、全部停止。 */
export type SessionComposerSubagentDock = {
  items: DockTask[]
  onOpen: (taskID: string) => void
  onStop: (taskID: string) => void
  onStopAll: () => void
}

/** "排队中":会话忙时发的消息(内核收件箱里 user 的那几条)+ 正在撤回的 + 撤回动作。 */
export type SessionComposerQueueDock = {
  items: { entryId: string; text: string; images: number }[]
  retracting: readonly string[]
  onRetract: (entryId: string) => void
}

/**
 * 组合区(确认条 + 子 agent 坞 + 排队中 + 排队追问 + 输入框)的容器控制器。
 *
 * 相对 opencode 删掉的:
 *  - todo dock 和它那套开合弹簧动画 —— yoma 没有 todowrite;
 *  - revert dock —— yoma 没有文件快照,回滚只能挪 leaf 指针,给不出"恢复到这条消息"
 *    的文件级语义,留一个会撒谎的按钮比没有按钮危险得多;
 *  - parentID / child / openParent —— 子 agent 的会话不给输入框(只读 transcript + 顶部条),
 *    组合区在那里整个不挂,用不着这几样。
 */
export function createSessionComposerRegionController(input: {
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  prompt: PromptInputState
  centered: Accessor<boolean>
  confirms: Accessor<SessionComposerConfirmDock | undefined>
  subagents: Accessor<SessionComposerSubagentDock | undefined>
  queue: Accessor<SessionComposerQueueDock | undefined>
  setPromptRef: (el: HTMLDivElement) => void
  setDockRef: (el: HTMLDivElement) => void
}) {
  createEffect(() => {
    if (!input.prompt.ready()) return
    setSessionHandoff(input.sessionKey(), {
      prompt: input.prompt
        .current()
        .map((part) => {
          if (part.type === "file") return `[file:${part.path}]`
          if (part.type === "image") return `[image:${part.filename}]`
          return part.content
        })
        .join("")
        .trim(),
    })
  })

  const ready = Promise.resolve()
  const [promptReady] = createResource(
    () => input.prompt.ready.promise ?? ready,
    (promise) => promise.then(() => true),
  )

  return {
    centered: input.centered,
    confirms: input.confirms,
    subagents: input.subagents,
    queue: input.queue,
    setPromptRef: input.setPromptRef,
    setDockRef: input.setDockRef,
    handoffPrompt: () => getSessionHandoff(input.sessionKey())?.prompt,
    promptReady: () => input.prompt.ready() || promptReady(),
  }
}

export type SessionComposerRegionController = ReturnType<typeof createSessionComposerRegionController>
