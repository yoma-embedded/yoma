/**
 * renderer ↔ host 的线上协议。
 *
 * 传输是 Electron 的 MessagePort(renderer 直连 utilityProcess,不经 main 中转),
 * 但协议本身对传输无感知 —— 只要能 request/subscribe 就行,所以 dev 下也可以套一个
 * WebSocket 说同一套话。
 *
 * 两条刻意的设计:
 *
 * 1. **事件名保留 opencode 的**。`message.part.delta`、`session.status` 这些名字不变,
 *    于是 packages/app 的 event-reducer(有单测)基本原样存活。
 *
 * 2. **方法表是一张类型化的 map**。client 和 host 的 handler 表都从它派生,host 那边用
 *    `satisfies KernelHandlers` 对齐,漏实现一个方法就是编译错误,不是运行时 404。
 */

import type {
  FileDiff,
  FileEntry,
  Message,
  Part,
  PermissionRequest,
  PermissionResponse,
  PermissionRules,
  ProviderInfo,
  Session,
  SessionStatus,
  VcsInfo,
} from "./types.ts"

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** 一次拉取到的 transcript 分页。 */
export interface MessagePage {
  items: Array<{ info: Message; parts: Part[] }>
  /** 还有更早的历史时给出;没有就是到头了。放在 body 里而不是响应头 —— 我们没有 HTTP 了。 */
  nextCursor?: string
}

export interface PromptInput {
  text: string
  /** renderer 乐观插入用户消息时铸的 id。host 必须复用它,否则会重复渲染一条。 */
  messageID?: string
  /** 附件(图片/文件)。图片走 data: URL。 */
  files?: Array<{ mime: string; url: string; filename?: string }>
}

export interface KernelMethods {
  "app.info": {
    params: void
    result: { version: string; enginesDir: string | null; sessionsRoot: string; node: string }
  }

  "session.list": { params: { directory?: string }; result: Session[] }
  "session.get": { params: { sessionID: string }; result: Session }
  "session.create": { params: { directory: string; title?: string }; result: Session }
  "session.delete": { params: { sessionID: string }; result: void }
  "session.rename": { params: { sessionID: string; title: string }; result: Session }
  "session.status": { params: { sessionID: string }; result: SessionStatus }
  "session.messages": { params: { sessionID: string; cursor?: string; limit?: number }; result: MessagePage }
  /** 发起一轮。**立即返回**,结果全部走事件流 —— 一轮可能跑几分钟。 */
  "session.prompt": { params: { sessionID: string; input: PromptInput }; result: { messageID: string } }
  "session.abort": { params: { sessionID: string }; result: void }
  "session.compact": { params: { sessionID: string }; result: void }
  /**
   * 顶替 opencode 的 revert。my-pi 只能把会话树的 leaf 挪回某条消息(navigateTree),
   * **不还原文件** —— 所以 UI 上必须叫"改上一条重发",不能叫"回滚"。返回那条消息的
   * 原文,让 composer 填回输入框。
   */
  "session.navigate": { params: { sessionID: string; messageID: string }; result: { editorText: string } }
  "session.setModel": {
    params: { sessionID: string; providerID: string; modelID: string; thinking?: string }
    result: Session
  }

  "permission.respond": { params: { id: string; response: PermissionResponse }; result: void }
  "permission.rules": { params: void; result: PermissionRules }
  "permission.setRules": { params: { rules: PermissionRules }; result: PermissionRules }
  /**
   * 调试台任务活跃时锁硬件工具(flash/gdb 全拒,log 只拒 rtt 路)。探针租约是
   * **进程内**的,交互内核与调试台的 turn 子进程会真撞探针(实测 0xe00002c5)——
   * 跨进程互斥只能产品层做。这是硬锁不是提示;active:false 撤锁。不动 rules 表:
   * 用户配的规则不该被任务生命周期改写。
   */
  "mailbox.setActive": { params: { active: boolean; reason?: string }; result: { active: boolean } }

  "model.list": { params: void; result: ProviderInfo[] }
  "auth.set": { params: { providerID: string; apiKey: string }; result: ProviderInfo[] }
  "auth.remove": { params: { providerID: string }; result: ProviderInfo[] }

  "file.list": { params: { directory: string; path?: string }; result: FileEntry[] }
  "file.read": { params: { path: string }; result: { content: string; mime: string; truncated: boolean } }
  "file.search": { params: { directory: string; query: string; limit?: number }; result: string[] }

  "vcs.info": { params: { directory: string }; result: VcsInfo }
  "vcs.diff": { params: { directory: string }; result: FileDiff[] }

  "project.list": { params: void; result: Array<{ directory: string; lastOpened: number }> }
  "project.add": { params: { directory: string }; result: Array<{ directory: string; lastOpened: number }> }
  "project.remove": { params: { directory: string }; result: Array<{ directory: string; lastOpened: number }> }
}

export type KernelMethod = keyof KernelMethods
export type KernelParams<M extends KernelMethod> = KernelMethods[M]["params"]
export type KernelResult<M extends KernelMethod> = KernelMethods[M]["result"]

/** host 侧的实现表。用 `satisfies KernelHandlers` 保证一个都不漏。 */
export type KernelHandlers = {
  [M in KernelMethod]: (params: KernelParams<M>) => Promise<KernelResult<M>> | KernelResult<M>
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

/**
 * 事件名与 opencode 一致 —— 前端的 reducer 按这些字符串分支。
 *
 * **发射顺序是硬约束**,而且违反是静默的:
 *   - 父 `message.updated` 必须早于它的任何 part 事件(reducer 直接丢弃孤儿 part);
 *   - `message.part.updated` 必须早于该 part 的 `message.part.delta`(未知 part 的 delta 被丢弃)。
 * 投影器必须按这个顺序发,别指望 UI 会报错提醒你。
 */
export type KernelEvent =
  /** host 就绪或重连成功。前端收到就重新 bootstrap。 */
  | { type: "kernel.connected"; version: string }
  | { type: "kernel.error"; message: string; sessionID?: string }
  | { type: "session.created"; session: Session }
  | { type: "session.updated"; session: Session }
  | { type: "session.deleted"; sessionID: string }
  | { type: "session.status"; sessionID: string; status: SessionStatus }
  | { type: "message.updated"; message: Message }
  | { type: "message.removed"; sessionID: string; messageID: string }
  | { type: "message.part.updated"; part: Part }
  | { type: "message.part.removed"; sessionID: string; messageID: string; partID: string }
  /**
   * 流式增量。**累积快照必须是 delta 的严格前缀扩展** —— 前端只在"取回的 part.text 仍以
   * 记录的 delta base 开头"时才保留已经画出来的流式文本,否则会看到文本先截断再长回来。
   * 所以投影器两条路(live / replay)必须共用同一个函数,任何一边做了 trim/normalize
   * 都会破坏这个不变式。
   */
  | { type: "message.part.delta"; sessionID: string; messageID: string; partID: string; field: "text"; delta: string }
  | { type: "permission.asked"; request: PermissionRequest }
  | { type: "permission.replied"; id: string; response: PermissionResponse }
  | { type: "vcs.updated"; directory: string; info: VcsInfo }

export type KernelEventType = KernelEvent["type"]

/** 一批事件。host 每 ~16ms 合并推一次,而不是一条一个 IPC 往返。 */
export interface KernelPush {
  events: KernelEvent[]
}

// ---------------------------------------------------------------------------
// 传输
// ---------------------------------------------------------------------------

export interface KernelTransport {
  request(method: string, params: unknown): Promise<unknown>
  subscribe(handler: (events: KernelEvent[]) => void): () => void
}

/** 线上帧。故意做得又小又蠢 —— 调试时肉眼可读。 */
export type KernelFrame =
  | { kind: "request"; id: number; method: string; params: unknown }
  | {
      kind: "response"
      id: number
      result?: unknown
      /**
       * `data` 是刻意加的:跨进程之后错误只剩一个字符串,前端就没法区分
       * "会话不存在(把失效标签页删掉就行)"和"真出事了(该报致命错误)"。
       * 实测踩过 —— 打开一个上个版本残留的标签页会让整个 app 崩到错误页。
       */
      error?: { message: string; stack?: string; data?: Record<string, unknown> }
    }
  | { kind: "push"; events: KernelEvent[] }
