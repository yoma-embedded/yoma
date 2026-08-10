import { type Accessor, createEffect, createResource } from "solid-js"
import type { PromptInputState } from "@/components/prompt-input"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"

export type SessionComposerFollowupDock = {
  items: { id: string; text: string }[]
  sending?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
}

/**
 * 组合区（排队追问 + 输入框）的容器控制器。
 *
 * 相对 opencode 删掉的:
 *  - todo dock 和它那套开合弹簧动画 —— my-pi 没有 todowrite;
 *  - revert dock —— my-pi 没有文件快照,回滚只能挪 leaf 指针,给不出"恢复到这条消息"
 *    的文件级语义,留一个会撒谎的按钮比没有按钮危险得多;
 *  - parentID / child / openParent —— 没有子会话。
 */
export function createSessionComposerRegionController(input: {
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  prompt: PromptInputState
  centered: Accessor<boolean>
  followup: Accessor<SessionComposerFollowupDock | undefined>
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
    followup: input.followup,
    setPromptRef: input.setPromptRef,
    setDockRef: input.setDockRef,
    handoffPrompt: () => getSessionHandoff(input.sessionKey())?.prompt,
    promptReady: () => input.prompt.ready() || promptReady(),
  }
}

export type SessionComposerRegionController = ReturnType<typeof createSessionComposerRegionController>
