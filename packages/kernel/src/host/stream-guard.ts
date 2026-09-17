/**
 * 模型流的空闲看门狗。
 *
 * 2026-09-17 无头验证:DeepSeek 流了 7.6 万字符推理后连接静默断掉,进程里已经没有到 API 的连接,内核却等了
 * 15 分钟(手动杀掉)。三层都没管这件事:OpenAI SDK 的 timeout 到响应头为止(client.js 的 fetchWithTimeout 在
 * fetch 返回后就 clearTimeout),pi-ai 的 timeoutMs 直接映射到它;node 自带 fetch 的正文空闲超时实测约 45 分钟;
 * harness 没有"多久没字节"的概念。
 *
 * 修在传输层:pi-ai 的 `StreamOptions.fetch` 是文档写明的注入口(各 provider 都认),这里给它一个包了正文看门狗的
 * fetch —— 正文 idleMs 没有新字节就把流置错。错误文本带 "timeout",pi-ai 按 RETRYABLE_PROVIDER_ERROR_PATTERN 认成
 * 可重试,harness 走已有的重试策略(桌面端显示"模型重试恢复"),不是用户取消的语义。只管正文:响应头之前由 SDK
 * 自己的 timeout 管。不碰 vendored 代码;桌面端、bench、信箱都经 resolveModel 拿 Models,一起受益。
 */
import type { Models } from "@earendil-works/pi-ai"

/** 缺省 90 s:推理流的 token 间隔是毫秒级,服务端排队也在几秒内;超过一分半没字节的连接没有活过来的。 */
export const DEFAULT_STREAM_IDLE_MS = 90_000

export class StreamIdleError extends Error {
  readonly code = "STREAM_IDLE"
  constructor(readonly idleMs: number) {
    super(
      `model stream idle timeout: no bytes received for ${Math.round(idleMs / 1000)} s, the connection is presumed dead`,
    )
    this.name = "StreamIdleError"
  }
}

export interface StreamGuardOptions {
  /** 正文多久没新字节算断;≤ 0 关掉看门狗 */
  idleMs?: number
  /** 被包的 fetch,缺省 globalThis.fetch */
  fetch?: typeof globalThis.fetch
}

/** `YOMA_STREAM_IDLE_MS` 环境变量:改阈值或写 0 关掉(现场排查用)。 */
export function streamIdleMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.YOMA_STREAM_IDLE_MS
  if (raw === undefined || raw === "") return DEFAULT_STREAM_IDLE_MS
  const n = Number(raw)
  return Number.isFinite(n) ? n : DEFAULT_STREAM_IDLE_MS
}

/** 正文流:每等一个新块都计时,超时就取消底层 reader 并把流置错。 */
function watchBody(body: ReadableStream<Uint8Array>, idleMs: number): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let expired = false
      timer = setTimeout(() => {
        expired = true
        // cancel 让挂着的 read() 以 done 返回;下面按 expired 把它变成错误,而不是"流正常结束"
        void reader.cancel(new StreamIdleError(idleMs)).catch(() => undefined)
      }, idleMs)
      try {
        const { done, value } = await reader.read()
        if (expired) throw new StreamIdleError(idleMs)
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      } finally {
        clearTimeout(timer)
      }
    },
    cancel(reason) {
      clearTimeout(timer)
      return reader.cancel(reason)
    },
  })
}

/** 给响应正文加看门狗的 fetch。没有正文(HEAD / 204 / 304)或看门狗关着时原样返回。 */
export function guardedFetch(options: StreamGuardOptions = {}): typeof globalThis.fetch {
  const idleMs = options.idleMs ?? DEFAULT_STREAM_IDLE_MS
  const inner = options.fetch ?? globalThis.fetch
  if (!(idleMs > 0)) return inner
  return async (input, init) => {
    const response = await inner(input, init)
    if (!response.body || response.bodyUsed) return response
    const guarded = new Response(watchBody(response.body, idleMs), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    // Response 构造函数不接 url / redirected;SDK 的日志与错误信息会读它们
    Object.defineProperty(guarded, "url", { value: response.url, configurable: true })
    Object.defineProperty(guarded, "redirected", { value: response.redirected, configurable: true })
    return guarded
  }
}

type SimpleOptions = Parameters<Models["streamSimple"]>[2]

/**
 * 给 Models 的 streamSimple / completeSimple 默认注入看门狗 fetch;调用方自己传了 fetch 就不动。
 * 其余方法原样转发(绑定到原对象,ModelsImpl 的私有状态不受影响)。
 */
export function withStreamGuard<T extends Models>(models: T, options: StreamGuardOptions = {}): T {
  const fetch = guardedFetch(options)
  if (fetch === (options.fetch ?? globalThis.fetch)) return models
  const inject = (o: SimpleOptions): SimpleOptions => (o?.fetch ? o : { ...o, fetch })
  return new Proxy(models, {
    get(target, property) {
      if (property === "streamSimple")
        return (
          model: Parameters<Models["streamSimple"]>[0],
          context: Parameters<Models["streamSimple"]>[1],
          o?: SimpleOptions,
        ) => target.streamSimple(model, context, inject(o))
      if (property === "completeSimple")
        return (
          model: Parameters<Models["completeSimple"]>[0],
          context: Parameters<Models["completeSimple"]>[1],
          o?: SimpleOptions,
        ) => target.completeSimple(model, context, inject(o))
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
