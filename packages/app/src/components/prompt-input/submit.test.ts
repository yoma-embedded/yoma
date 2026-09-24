import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const DIRECTORY = "/repo/main"

const createdSessions: string[] = []
const sentPrompts: Array<{ sessionID: string; text: string; setModelCallsBefore: number }> = []
const setModelCalls: Array<{ sessionID: string; providerID: string; modelID: string; thinking?: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: { id: string; model: { providerID: string; modelID: string } }
}> = []
const optimisticSeeded: boolean[] = []
const optimisticRemoved: string[] = []
const promptSets: Array<{ prompt: Prompt; cursor?: number }> = []
/** 下一次 session.abort 交回的排队用户消息。 */
let abortReturns: Array<{ text: string; files?: Array<{ mime: string; url: string }> }> = []
/** 下一次 prompt 由"内核"回 `queued: true`(会话正忙,排进收件箱)。 */
let queueNext = false
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; sessionId: string }> = []

let params: { id?: string } = {}
let search: { draftId?: string } = {}

/** /btw 发到内核的问题;`btwRejects` 非空时这一次 session.btw 抛它。 */
const btwSent: Array<{ sessionID: string; text: string }> = []
let btwRejects: unknown
/** 授权提示的替身:预检问过哪类执行、要不要拦;认出来的授权错误。 */
const licenseChecks: string[] = []
let licenseBlocks = false
const licenseNotified: unknown[] = []
const toastTitles: string[] = []
const histories: Prompt[] = []
let resets = 0

const textPrompt = (content: string): Prompt => [{ type: "text", content, start: 0, end: content.length }]
let promptValue: Prompt = textPrompt("ls")
const prompt = {
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  reset: () => {
    resets += 1
  },
  set: (value: Prompt, cursor?: number) => {
    promptSets.push({ prompt: value, cursor })
  },
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => prompt,
}

/**
 * 内核客户端的形状:`session.create({directory})` 直接返回 Session(不再是 `{data}`),
 * `session.prompt(sessionID, input)` 是位置参数。没有 worktree、没有 shell、没有 command。
 */
const kernelClient = {
  session: {
    create: async ({ directory }: { directory: string }) => {
      createdSessions.push(directory)
      return {
        id: `session-${createdSessions.length}`,
        directory,
        title: `New session ${createdSessions.length}`,
        time: { created: 0, updated: 0 },
      }
    },
    // 发送前必须先 setModel:prompt 协议不带模型,不下发的话内核用自己的默认,
    // UI 的选择就只是乐观消息上的贴纸。这里记录调用顺序供断言。
    setModel: async (params: { sessionID: string; providerID: string; modelID: string; thinking?: string }) => {
      setModelCalls.push(params)
      return { id: params.sessionID }
    },
    prompt: async (sessionID: string, input: { text: string }) => {
      sentPrompts.push({ sessionID, text: input.text, setModelCallsBefore: setModelCalls.length })
      return queueNext ? { messageID: "message-1", queued: true } : { messageID: "message-1" }
    },
    abort: async () => (abortReturns.length ? { returned: abortReturns } : {}),
    btw: async (sessionID: string, input: { text: string }) => {
      if (btwRejects) throw btwRejects
      btwSent.push({ sessionID, text: input.text })
      return { btwID: "btw-1" }
    },
  },
}

beforeAll(async () => {
  vi.doMock("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  vi.doMock("@yoma-desktop/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: (options: { title?: string } | string) => {
      toastTitles.push(typeof options === "string" ? options : (options.title ?? ""))
      return 0
    },
  }))

  vi.doMock("@/licensing/license-notice", () => ({
    createLicenseNotice: () => ({
      blockedBeforeSend: async (execution: string) => {
        licenseChecks.push(execution)
        return licenseBlocks
      },
      notifyIfLicense: (error: unknown) => {
        const data = (error as { data?: { _tag?: string } } | undefined)?.data
        if (data?._tag !== "LicenseRequiredError") return false
        licenseNotified.push(data)
        return true
      },
    }),
  }))

  vi.doMock("@yoma-desktop/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  vi.doMock("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: {
          current: () => "high",
        },
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  vi.doMock("@/context/drafts", () => ({
    useDrafts: () => ({
      promote: (draftID: string, sessionId: string) => {
        promotedDrafts.push({ draftID, sessionId })
      },
    }),
  }))

  vi.doMock("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  vi.doMock("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  vi.doMock("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: DIRECTORY,
        client: kernelClient,
        url: "kernel://local",
        createClient() {
          return kernelClient
        },
      }
      return () => sdk
    },
  }))

  vi.doMock("@/context/sync", () => ({
    useSync: () => () => ({
      data: {},
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { id: string; model: { providerID: string; modelID: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: (value: { messageID: string }) => {
            optimisticRemoved.push(value.messageID)
          },
        },
      },
      set: () => undefined,
    }),
  }))

  vi.doMock("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        remember: () => undefined,
        set: () => undefined,
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  vi.doMock("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  vi.doMock("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdSessions.length = 0
  sentPrompts.length = 0
  setModelCalls.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  optimisticRemoved.length = 0
  promptSets.length = 0
  abortReturns = []
  queueNext = false
  promoted.length = 0
  promotedDrafts.length = 0
  syncedDirectories.length = 0
  params = {}
  search = {}
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
  btwSent.length = 0
  btwRejects = undefined
  licenseChecks.length = 0
  licenseBlocks = false
  licenseNotified.length = 0
  toastTitles.length = 0
  histories.length = 0
  resets = 0
  promptValue = textPrompt("ls")
})

const baseInput = () => ({
  prompt,
  imageAttachments: () => [],
  commentCount: () => 0,
  working: () => false,
  editor: () => undefined,
  queueScroll: () => undefined,
  promptLength: (value: Prompt) =>
    value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
  addToHistory: (value: Prompt) => {
    histories.push(value)
  },
  resetHistoryNavigation: () => undefined,
  setPopover: () => undefined,
  onSubmit: () => undefined,
})

const event = () => ({ preventDefault: () => undefined }) as unknown as Event

/** 让 fire-and-forget 的 promise 链跑完。 */
async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe("prompt submit", () => {
  test("creates the new session in the sdk directory", async () => {
    const submit = createPromptSubmit({ ...baseInput(), info: () => undefined })

    await submit.handleSubmit(event())
    // handleSubmit 里发 prompt 那步是 fire-and-forget(void sendFollowupDraft(...)),
    // 它内部还有一段 await 链。不 flush 微任务就会在 prompt 真正发出前断言。
    await flushMicrotasks()

    expect(createdSessions).toEqual([DIRECTORY])
    expect(promoted).toEqual([{ directory: DIRECTORY, sessionID: "session-1" }])
    expect(sentPrompts).toEqual([{ sessionID: "session-1", text: "ls", setModelCallsBefore: 1 }])
  })

  test("promotes the draft onto the session it just created", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({ ...baseInput(), info: () => undefined })

    await submit.handleSubmit(event())

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", sessionId: "session-1" }])
  })

  test("carries the selected model on optimistic prompts", async () => {
    params = { id: "session-1" }
    const submit = createPromptSubmit({ ...baseInput(), info: () => ({ id: "session-1" }) })

    await submit.handleSubmit(event())

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: { model: { providerID: "provider", modelID: "model" } },
    })
  })

  test("发送前把选中的模型真正下发内核(setModel 先于 prompt)", async () => {
    // 回归钉:曾经 draft.model 只喂乐观 UI,内核一直跑自己的默认模型 ——
    // 选 V4 Flash 实际是 V4 Pro,"选择模型如同虚设"。
    params = { id: "session-1" }
    const submit = createPromptSubmit({ ...baseInput(), info: () => ({ id: "session-1" }) })

    await submit.handleSubmit(event())
    await flushMicrotasks()

    expect(setModelCalls).toEqual([
      { sessionID: "session-1", providerID: "provider", modelID: "model", thinking: "high" },
    ])
    expect(sentPrompts).toHaveLength(1)
    // prompt 发出时 setModel 必须已经完成
    expect(sentPrompts[0]!.setModelCallsBefore).toBe(1)
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({ ...baseInput(), info: () => undefined })

    await submit.handleSubmit(event())

    expect(storedSessions[DIRECTORY]?.map((item) => item.id)).toEqual(["session-1"])
    expect(optimisticSeeded).toEqual([true])
  })

  test("会话正忙、内核排队(queued):乐观插入的那条撤掉", async () => {
    // 照 CC:忙时发的消息进收件箱,被这一轮取走时才随事件落在 transcript 里的真实位置(内核铸新 id)。
    // 乐观那条留着的话,它先挂在末尾、取走时再出现一次 —— 同一句话两条。
    params = { id: "session-1" }
    queueNext = true
    const submit = createPromptSubmit({ ...baseInput(), info: () => ({ id: "session-1" }) })

    await submit.handleSubmit(event())
    await flushMicrotasks()

    expect(sentPrompts).toHaveLength(1)
    expect(optimistic).toHaveLength(1)
    expect(optimisticRemoved).toEqual([optimistic[0]!.message.id])
  })

  test("没排队时乐观那条留着(内核按原文认领它的 id)", async () => {
    params = { id: "session-1" }
    const submit = createPromptSubmit({ ...baseInput(), info: () => ({ id: "session-1" }) })

    await submit.handleSubmit(event())
    await flushMicrotasks()

    expect(sentPrompts).toHaveLength(1)
    expect(optimisticRemoved).toEqual([])
  })

  test("按停止:内核交回的排队消息退回输入框(排队的原文在前)", async () => {
    // 缺省后台之后这条更要紧:停止时收件箱里常躺着东西,不接住就静默消失。
    params = { id: "session-1" }
    abortReturns = [{ text: "排着的那句" }]
    const submit = createPromptSubmit({ ...baseInput(), info: () => ({ id: "session-1" }) })

    await submit.abort()

    expect(promptSets).toHaveLength(1)
    expect(promptSets[0]!.prompt[0]).toMatchObject({ type: "text", content: `排着的那句\nls` })
    expect(promptSets[0]!.cursor).toBe("排着的那句".length)
  })

  test("按停止:没有交回的东西就不碰输入框", async () => {
    params = { id: "session-1" }
    const submit = createPromptSubmit({ ...baseInput(), info: () => ({ id: "session-1" }) })

    await submit.abort()

    expect(promptSets).toEqual([])
  })
})

describe("/btw 与授权", () => {
  test("预检说会被拒:不发、不清输入框、不记历史,问的是 session.btw", async () => {
    params = { id: "session-1" }
    promptValue = textPrompt("/btw 这个寄存器是干嘛的")
    licenseBlocks = true
    const submit = createPromptSubmit({ ...baseInput(), info: () => ({ id: "session-1" }) })

    await submit.handleSubmit(event())

    expect(licenseChecks).toEqual(["session.btw"])
    expect(btwSent).toEqual([])
    expect(resets).toBe(0)
    expect(histories).toEqual([])
    expect(toastTitles).not.toContain("prompt.toast.btw.failed")
  })

  test("预检放行时照常发", async () => {
    params = { id: "session-1" }
    promptValue = textPrompt("/btw 这个寄存器是干嘛的")
    const submit = createPromptSubmit({ ...baseInput(), info: () => ({ id: "session-1" }) })

    await submit.handleSubmit(event())

    expect(licenseChecks).toEqual(["session.btw"])
    expect(btwSent).toEqual([{ sessionID: "session-1", text: "这个寄存器是干嘛的" }])
    expect(resets).toBe(1)
  })

  test("内核以授权为由拒了:出授权提示而不是「/btw 失败」,输入框还原", async () => {
    // 预检不是防线(读状态失败、刚好在这一刻到期):内核拒了的那条路也得说对话。
    params = { id: "session-1" }
    promptValue = textPrompt("/btw 这个寄存器是干嘛的")
    btwRejects = { message: "尚未激活", data: { _tag: "LicenseRequiredError", state: "missing", execution: "session.btw" } }
    const submit = createPromptSubmit({ ...baseInput(), info: () => ({ id: "session-1" }) })

    await submit.handleSubmit(event())

    expect(licenseNotified).toEqual([{ _tag: "LicenseRequiredError", state: "missing", execution: "session.btw" }])
    expect(toastTitles).not.toContain("prompt.toast.btw.failed")
    expect(promptSets).toHaveLength(1)
  })

  test("别的失败照旧是「/btw 失败」", async () => {
    params = { id: "session-1" }
    promptValue = textPrompt("/btw 这个寄存器是干嘛的")
    btwRejects = new Error("会话已经关闭")
    const submit = createPromptSubmit({ ...baseInput(), info: () => ({ id: "session-1" }) })

    await submit.handleSubmit(event())

    expect(licenseNotified).toEqual([])
    expect(toastTitles).toContain("prompt.toast.btw.failed")
    expect(promptSets).toHaveLength(1)
  })
})
