import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const DIRECTORY = "/repo/main"

const createdSessions: string[] = []
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
const sentPrompts: Array<{ sessionID: string; text: string; setModelCallsBefore: number }> = []
const setModelCalls: Array<{ sessionID: string; providerID: string; modelID: string; thinking?: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: { model: { providerID: string; modelID: string } }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []

let params: { id?: string } = {}
let search: { draftId?: string } = {}

const promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const prompt = {
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  reset: () => undefined,
  set: () => undefined,
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
      return { messageID: "message-1" }
    },
    abort: async () => undefined,
  },
}

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@yoma-desktop/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: () => 0,
  }))

  mock.module("@yoma-desktop/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
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

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
    }),
  }))

  mock.module("@/context/server", () => ({
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      draft: () => ({ server: "project-server" }),
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
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

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: {},
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { model: { providerID: string; modelID: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
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

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdSessions.length = 0
  enabledAutoAccept.length = 0
  sentPrompts.length = 0
  setModelCalls.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  syncedDirectories.length = 0
  params = {}
  search = {}
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

const baseInput = () => ({
  prompt,
  imageAttachments: () => [],
  commentCount: () => 0,
  autoAccept: () => false,
  mode: () => "normal" as const,
  working: () => false,
  editor: () => undefined,
  queueScroll: () => undefined,
  promptLength: (value: Prompt) =>
    value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
  addToHistory: () => undefined,
  resetHistoryNavigation: () => undefined,
  setMode: () => undefined,
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

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({ ...baseInput(), autoAccept: () => true, info: () => undefined })

    await submit.handleSubmit(event())

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: DIRECTORY }])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({ ...baseInput(), info: () => undefined })

    await submit.handleSubmit(event())

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
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
})
