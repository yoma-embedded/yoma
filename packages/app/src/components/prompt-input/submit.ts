import type { Message, Session } from "@yoma-desktop/kernel"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@yoma-desktop/util/encode"
import { Binary } from "@yoma-desktop/util/binary"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, type Accessor } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  model: { providerID: string; modelID: string }
  /** thinking 档位(存档键沿用 variant 这个名字)。null/undefined = 不设。 */
  variant?: string | null
}

type FollowupSendInput = {
  client: DirectorySDK["client"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const { input: promptInput, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    model: { ...input.draft.model },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    // 把 UI 的模型选择**真正下发**给内核 —— prompt 协议不携带模型,不下发的话内核
    // 一直用自己的默认(~/.pi/agent/settings.json),UI 的选择只是乐观消息上的贴纸
    // (实测踩过:选 V4 Flash 实际跑的是 V4 Pro)。setModel 幂等、纯本地 IPC,
    // 放在每次发送前顺便覆盖排队后补发的场景。
    await input.client.session.setModel({
      sessionID: input.draft.sessionID,
      providerID: input.draft.model.providerID,
      modelID: input.draft.model.modelID,
      thinking: input.draft.variant ?? undefined,
    })
    await input.client.session.prompt(input.draft.sessionID, promptInput)
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    input.onAbort?.()

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    return sdk().client.session.abort(sessionID).catch(() => {})
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    serverSync().session.remember(info)
    const [, setStore] = serverSync().child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const currentModel = local.model.current()
    if (!currentModel) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    // 内核里一个会话就是一个 cwd —— 没有 worktree,也就没有"新会话开在别的目录"这件事。
    const sessionDirectory = sdk().directory
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const client = sdk().client

    let current = input.info()
    if (!current && isNewSession) {
      const created = await client.session.create({ directory: sessionDirectory }).catch((err) => {
        showToast({
          title: language.t("prompt.toast.sessionCreateFailed.title"),
          description: errorMessage(err),
        })
        return undefined
      })
      if (created) {
        seed(sessionDirectory, created)
        current = created
        if (shouldAutoAccept) permission.enableAutoAccept(created.id, sessionDirectory)
        local.session.promote(sessionDirectory, created.id)
        layout.handoff.setTabs(base64Encode(sessionDirectory), created.id)
        const draftID = search.draftId
        if (draftID) tabs.promoteDraft(draftID, { server: tabs.draft(draftID).server, sessionId: created.id })
        else navigate(`/${base64Encode(sessionDirectory)}/session/${created.id}`)
        submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: created.id }))
      }
    }
    if (!current) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }
    const session = current

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      model,
      variant: local.model.variant.current() ?? null,
    }

    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      input.onQueue?.(draft)
      clearContext(submission.target())
      clearInput()
      return
    }

    input.onSubmit?.()

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()

    void sendFollowupDraft({
      client,
      sync: sync(),
      serverSync: serverSync(),
      draft,
      messageID,
      optimisticBusy: true,
    }).catch((err) => {
      pending.delete(pendingKey(session.id))
      sync().set("session_status", session.id, { type: "idle" })
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
