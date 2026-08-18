/**
 * renderer 侧的内核客户端。
 *
 * 形状刻意抄 opencode SDK 的调用形态(`client.session.messages({...})`),这样
 * packages/app 里几百处调用点只需要改 import 说明符,不用改代码结构。
 *
 * 和 SDK 的差别只有两点,都是简化:
 *   - 没有 baseUrl / Basic auth / CORS —— 传输是进程内 MessagePort;
 *   - 分页游标在 body 里(`result.nextCursor`),不是响应头 `x-next-cursor`。
 */

import type {
  KernelEvent,
  KernelMethod,
  KernelParams,
  KernelResult,
  KernelTransport,
  MessagePage,
  PromptInput,
} from "./protocol.ts"
import type {
  FileDiff,
  FileEntry,
  ProviderInfo,
  Session,
  SessionStatus,
  ToolchainStatusView,
  VcsInfo,
} from "./types.ts"

export class KernelError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly remoteStack?: string,
    /** host 侧附带的结构化信息,比如 SessionNotFoundError。见 protocol.ts 的说明。 */
    readonly data?: Record<string, unknown>,
  ) {
    // cause.body 是前端 unwrapNamedError() 认的形状,顺着它走结构化错误才识别得出来。
    super(message, data ? { cause: { body: data, status: 404 } } : undefined)
    this.name = "KernelError"
  }
}

export interface KernelClient {
  readonly transport: KernelTransport
  call<M extends KernelMethod>(method: M, params: KernelParams<M>): Promise<KernelResult<M>>
  subscribe(handler: (events: KernelEvent[]) => void): () => void

  app: {
    info(): Promise<KernelResult<"app.info">>
    preflight(): Promise<KernelResult<"app.preflight">>
  }
  session: {
    list(params?: { directory?: string }): Promise<Session[]>
    get(sessionID: string): Promise<Session>
    create(params: { directory: string; title?: string }): Promise<Session>
    delete(sessionID: string): Promise<void>
    rename(sessionID: string, title: string): Promise<Session>
    status(sessionID: string): Promise<SessionStatus>
    messages(params: { sessionID: string; cursor?: string; limit?: number }): Promise<MessagePage>
    prompt(sessionID: string, input: PromptInput): Promise<{ messageID: string }>
    abort(sessionID: string): Promise<void>
    compact(sessionID: string): Promise<void>
    navigate(sessionID: string, messageID: string): Promise<{ editorText: string }>
    setModel(params: {
      sessionID: string
      providerID: string
      modelID: string
      thinking?: string
    }): Promise<Session>
  }
  model: {
    list(): Promise<ProviderInfo[]>
    setAuth(providerID: string, apiKey: string): Promise<ProviderInfo[]>
    removeAuth(providerID: string): Promise<ProviderInfo[]>
  }
  file: {
    list(directory: string, path?: string): Promise<FileEntry[]>
    read(path: string): Promise<KernelResult<"file.read">>
    search(directory: string, query: string, limit?: number): Promise<string[]>
  }
  vcs: {
    info(directory: string): Promise<VcsInfo>
    diff(directory: string): Promise<FileDiff[]>
  }
  toolchain: {
    status(params: { directory: string; fresh?: boolean }): Promise<ToolchainStatusView>
    set(params: { directory: string; id: string; path: string }): Promise<ToolchainStatusView>
  }
  project: {
    list(): Promise<KernelResult<"project.list">>
    add(directory: string): Promise<KernelResult<"project.add">>
    remove(directory: string): Promise<KernelResult<"project.remove">>
  }
}

export function createKernelClient(transport: KernelTransport): KernelClient {
  async function call<M extends KernelMethod>(method: M, params: KernelParams<M>): Promise<KernelResult<M>> {
    try {
      return (await transport.request(method, params)) as KernelResult<M>
    } catch (error) {
      if (error instanceof KernelError) throw error
      const err = error as { message?: string; stack?: string; data?: Record<string, unknown> }
      throw new KernelError(err?.message ?? String(error), method, err?.stack, err?.data)
    }
  }

  return {
    transport,
    call,
    subscribe: (handler) => transport.subscribe(handler),

    app: {
      info: () => call("app.info", undefined),
      preflight: () => call("app.preflight", undefined),
    },
    session: {
      list: (params) => call("session.list", { directory: params?.directory }),
      get: (sessionID) => call("session.get", { sessionID }),
      create: (params) => call("session.create", params),
      delete: (sessionID) => call("session.delete", { sessionID }),
      rename: (sessionID, title) => call("session.rename", { sessionID, title }),
      status: (sessionID) => call("session.status", { sessionID }),
      messages: (params) => call("session.messages", params),
      prompt: (sessionID, input) => call("session.prompt", { sessionID, input }),
      abort: (sessionID) => call("session.abort", { sessionID }),
      compact: (sessionID) => call("session.compact", { sessionID }),
      navigate: (sessionID, messageID) => call("session.navigate", { sessionID, messageID }),
      setModel: (params) => call("session.setModel", params),
    },
    model: {
      list: () => call("model.list", undefined),
      setAuth: (providerID, apiKey) => call("auth.set", { providerID, apiKey }),
      removeAuth: (providerID) => call("auth.remove", { providerID }),
    },
    file: {
      list: (directory, path) => call("file.list", { directory, path }),
      read: (path) => call("file.read", { path }),
      search: (directory, query, limit) => call("file.search", { directory, query, limit }),
    },
    vcs: {
      info: (directory) => call("vcs.info", { directory }),
      diff: (directory) => call("vcs.diff", { directory }),
    },
    toolchain: {
      status: (params) => call("toolchain.status", params),
      set: (params) => call("toolchain.set", params),
    },
    project: {
      list: () => call("project.list", undefined),
      add: (directory) => call("project.add", { directory }),
      remove: (directory) => call("project.remove", { directory }),
    },
  }
}

/**
 * 把一个双向消息端口(MessagePort / WebSocket / 任何有 postMessage+onmessage 的东西)
 * 包成 KernelTransport。renderer 和 dev 下的 WebSocket 走同一份实现。
 */
export interface KernelPortLike {
  postMessage(data: unknown): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void
  start?(): void
}

export function createPortTransport(port: KernelPortLike): KernelTransport {
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string }>()
  const subscribers = new Set<(events: KernelEvent[]) => void>()

  port.addEventListener("message", (event) => {
    const frame = event.data as
      | {
          kind: "response"
          id: number
          result?: unknown
          error?: { message: string; stack?: string; data?: Record<string, unknown> }
        }
      | { kind: "push"; events: KernelEvent[] }
      | undefined
    if (!frame) return
    if (frame.kind === "push") {
      for (const handler of subscribers) handler(frame.events)
      return
    }
    if (frame.kind === "response") {
      const entry = pending.get(frame.id)
      if (!entry) return
      pending.delete(frame.id)
      if (frame.error) {
        entry.reject(new KernelError(frame.error.message, entry.method, frame.error.stack, frame.error.data))
      } else {
        entry.resolve(frame.result)
      }
    }
  })
  port.start?.()

  return {
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method })
        port.postMessage({ kind: "request", id, method, params })
      })
    },
    subscribe(handler) {
      subscribers.add(handler)
      return () => subscribers.delete(handler)
    },
  }
}
