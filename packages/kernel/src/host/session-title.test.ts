/**
 * 会话自动起名(host/session-title.ts + session-manager 的接线)。
 *
 * 前半是纯函数:模型原话怎么洗成标题、占位怎么取、起名请求长什么样、思考档怎么压。后半走完整的 SessionManager
 * (真 harness、真 JSONL,只有模型是 faux):起名请求与正文那一轮是并发的,谁先到 faux 不一定 —— 所以每一步都交给
 * 同一个路由,按系统提示词分辨"这是起名"还是"这是正文"。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai"

import { SessionManager, type SessionManagerOptions } from "./session-manager.ts"
import {
  cleanTitle,
  fallbackTitle,
  generateTitle,
  pickTitleModel,
  TITLE_MAX_CHARS,
  TITLE_SYSTEM_PROMPT,
  titleRequest,
} from "./session-title.ts"
import type { KernelEvent } from "../protocol.ts"
import { patient } from "../../test/patience.ts"

beforeAll(() => {
  // 同 host.test.ts:真 ~/.yoma/probe.lock 归用户。
  process.env.YOMA_PROBE_LOCK = path.join(tmpdir(), `yoma-probe-test-${process.pid}.lock`)
})

const cleanups: Array<() => Promise<void>> = []
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  // 先关会话(连带 JSONL 句柄),再删目录 —— Windows 上开着的文件删不掉。
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check: () => boolean, timeoutMs = 10_000, what = "条件"): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > patient(timeoutMs)) throw new Error(`等待超时:${what}`)
    await sleep(10)
  }
}

const text = (value: string) => fauxAssistantMessage([fauxText(value)])

function failed(errorMessage: string): AssistantMessage {
  return { ...text(""), content: [], stopReason: "error", errorMessage }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe("cleanTitle:模型原话 → 标题", () => {
  test.each([
    ["STM32 串口乱码排查", "STM32 串口乱码排查"],
    ["<think>用户在问串口……</think>\n\nSTM32 串口乱码排查", "STM32 串口乱码排查"],
    ["这里的思考没有开头标签</think>ESP32 深度睡眠无法唤醒", "ESP32 深度睡眠无法唤醒"],
    ["ESP32 深度睡眠无法唤醒\n<think>标题后面又补了一段思考</think>", "ESP32 深度睡眠无法唤醒"],
    ['**"串口乱码排查。"**', "串口乱码排查"],
    ["Title: Debugging I2C NACK at 0x68.", "Debugging I2C NACK at 0x68"],
    ["标题：OpenOCD 烧录报 init mode failed", "OpenOCD 烧录报 init mode failed"],
    ["Title:\n\n「ESP32-S3 深度睡眠」", "ESP32-S3 深度睡眠"],
    ["# 升级到 v1.2.3 之后烧录失败？", "升级到 v1.2.3 之后烧录失败"],
    ["  STM32   串口\t乱码  ", "STM32 串口 乱码"],
  ])("%j → %j", (raw, expected) => {
    expect(cleanTitle(raw)).toBe(expected)
  })

  test("一个字都不剩就是没起成", () => {
    expect(cleanTitle("")).toBeUndefined()
    expect(cleanTitle("  \n\n")).toBeUndefined()
    expect(cleanTitle("<think>只有思考</think>")).toBeUndefined()
    expect(cleanTitle('""')).toBeUndefined()
  })

  test(`超过 ${TITLE_MAX_CHARS} 个字截断并带省略号(按字数,不按字节)`, () => {
    const title = cleanTitle("串".repeat(80))!
    expect(Array.from(title)).toHaveLength(TITLE_MAX_CHARS)
    expect(title.endsWith("…")).toBe(true)
  })
})

describe("fallbackTitle:占位与退路", () => {
  test.each([
    ["帮我看看串口为什么乱码。我用的是 STM32F407,波特率 115200", "帮我看看串口为什么乱码"],
    ["Why does I2C fail? It returns NACK on 0x68.", "Why does I2C fail"],
    ["升级到 v1.2.3 之后烧录失败", "升级到 v1.2.3 之后烧录失败"],
    ["\n\n   第二行才有字   \n第三行", "第二行才有字"],
    ["你好", "你好"],
  ])("%j → %j", (source, expected) => {
    expect(fallbackTitle(source)).toBe(expected)
  })

  test("没有字就没有占位;太长的截断", () => {
    expect(fallbackTitle("")).toBeUndefined()
    expect(fallbackTitle(" \n\t\n")).toBeUndefined()
    const long = fallbackTitle("看".repeat(200))!
    expect(Array.from(long)).toHaveLength(TITLE_MAX_CHARS)
    expect(long.endsWith("…")).toBe(true)
  })
})

describe("起名请求", () => {
  test("系统提示词要求跟用户同一种语言;原文包在标签里,过长的截头留下", () => {
    expect(TITLE_SYSTEM_PROMPT).toContain("you MUST use the same language as the user message")
    const request = titleRequest("  STM32 串口乱码  ")
    expect(request.systemPrompt).toBe(TITLE_SYSTEM_PROMPT)
    const body = (request.messages[0]!.content as Array<{ text: string }>)[0]!.text
    expect(body).toContain("<user_message>\nSTM32 串口乱码\n</user_message>")

    const long = (titleRequest("头".repeat(10) + "尾".repeat(5000)).messages[0]!.content as Array<{ text: string }>)[0]!.text
    expect(long).toContain("头".repeat(10))
    expect(long.match(/尾/g)!.length).toBeLessThan(2000)
  })

  test("YOMA_TITLE_MODEL 钉的模型在注册表里才用,否则跟着会话", () => {
    const models = createModels()
    const faux = fauxProvider({ provider: "title-pick", models: [{ id: "big" }, { id: "small" }] })
    models.setProvider(faux.provider)
    const big = faux.getModel("big") as Model<string>
    expect(pickTitleModel(models, big, "title-pick/small").id).toBe("small")
    expect(pickTitleModel(models, big, "title-pick/nope").id).toBe("big")
    expect(pickTitleModel(models, big, "没有斜杠").id).toBe("big")
    expect(pickTitleModel(models, big, undefined).id).toBe("big")
  })

  test("思考能关就不传、封个输出上限;关不掉的给最低一档、不封上限", async () => {
    const seen: Array<SimpleStreamOptions | undefined> = []
    const models = createModels()
    const faux = fauxProvider({ provider: "title-think", models: [{ id: "switchable", reasoning: true }] })
    models.setProvider(faux.provider)
    faux.setResponses(
      Array.from({ length: 2 }, () => (_context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
        seen.push(options)
        return text("串口乱码排查")
      }),
    )
    const switchable = faux.getModel() as Model<string>
    // 思考是强制的模型(目录里 thinkingLevelMap.off 为 null,比如 claude-opus-5、kimi-k3)。
    const forced = { ...switchable, thinkingLevelMap: { off: null } } as Model<string>

    expect(await generateTitle({ models, model: switchable, text: "串口乱码" })).toBe("串口乱码排查")
    expect(await generateTitle({ models, model: forced, text: "串口乱码" })).toBe("串口乱码排查")
    expect(seen[0]?.reasoning).toBeUndefined()
    expect(seen[0]?.maxTokens).toBe(256)
    expect(seen[1]?.reasoning).toBe("minimal")
    expect(seen[1]?.maxTokens).toBeUndefined()
  })

  test("报错、没给出字都算失败(由调用方退回占位)", async () => {
    const models = createModels()
    const faux = fauxProvider({ provider: "title-fail", models: [{ id: "m" }] })
    models.setProvider(faux.provider)
    faux.setResponses([failed("503 Service Unavailable"), text("<think>想了半天</think>")])
    const model = faux.getModel() as Model<string>
    await expect(generateTitle({ models, model, text: "串口" })).rejects.toThrow("503")
    await expect(generateTitle({ models, model, text: "串口" })).rejects.toThrow("no usable text")
  })
})

// ---------------------------------------------------------------------------
// SessionManager 接线
// ---------------------------------------------------------------------------

type Step = (context: TranscriptContext, options: SimpleStreamOptions | undefined) => AssistantMessage | Promise<AssistantMessage>

let providerCount = 0

/**
 * 一份 faux、一个路由:系统提示词是起名那份就交给 `onTitle`,否则是正文那一轮,按顺序从 `replies` 里取。
 * 起名请求与正文并发,落到 faux 上的先后不定,所以不能按"第几次调用"写脚本。
 */
function setup(options: { autoTitle?: boolean; onTitle?: Step; replies?: string[] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "yoma-title-"))
  roots.push(root)
  const workspace = path.join(root, "工程目录")
  mkdirSync(workspace)
  const titleRequests: Array<{ context: TranscriptContext; options: SimpleStreamOptions | undefined }> = []
  const replies = [...(options.replies ?? [])]
  const route = async (context: TranscriptContext, streamOptions: SimpleStreamOptions | undefined) => {
    if (getCurrentSystemPrompt(context.messages) === TITLE_SYSTEM_PROMPT) {
      titleRequests.push({ context, options: streamOptions })
      return options.onTitle ? options.onTitle(context, streamOptions) : text("自动起的名字")
    }
    return text(replies.shift() ?? "好的")
  }
  const faux = fauxProvider({ provider: `title-${++providerCount}`, models: [{ id: "plain" }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(Array.from({ length: 200 }, () => route))
  const model = faux.getModel() as Model<string>
  const events: KernelEvent[] = []
  const sessionsRoot = path.join(root, "sessions")
  const open = (extra: Partial<SessionManagerOptions> = {}) => {
    const manager = new SessionManager({
      sessionsRoot,
      configDir: path.join(root, "config"),
      emit: (batch) => events.push(...batch),
      resolveModels: async () => ({ models, model }),
      inspectStm32Availability: async () => ({ available: false, reason: "test" }),
      subagents: { outputRoot: path.join(root, "tasks"), homeDir: root },
      ...(options.autoTitle === false ? {} : { autoTitle: true }),
      ...extra,
    })
    cleanups.push(() => manager.disposeAll())
    return manager
  }
  return { manager: open(), reopen: open, events, workspace, titleRequests }
}

/** 这个会话在事件流里被推过的标题,按时间顺序。 */
function titlesOf(events: KernelEvent[], sessionID: string): string[] {
  return events.flatMap((event) =>
    (event.type === "session.updated" || event.type === "session.created") && event.session.id === sessionID
      ? [event.session.title]
      : [],
  )
}

const idle = (manager: SessionManager, sessionID: string) => manager.status(sessionID).type === "idle"

describe("自动起名:SessionManager", () => {
  test("第一句话:先亮出它的开头,模型的标题到了再换上;写进会话,重启后列表里不打开也看得到", async () => {
    const gate = deferred()
    const { manager, reopen, events, workspace, titleRequests } = setup({
      onTitle: async () => {
        await gate.promise
        return text("STM32 USART1 乱码排查")
      },
      replies: ["先看看波特率"],
    })
    const session = await manager.create(workspace)
    // 没名字时是占位(工程目录名;Windows 上今天是整条路径,defaultTitle 只按 / 切)。
    expect(session.title).toContain("工程目录")

    await manager.prompt(session.id, { text: "STM32F407 的 USART1 打印全是乱码。波特率 115200" })
    // 占位在 prompt 返回之前就推出去了(起名还卡在闸门上)。
    expect(titlesOf(events, session.id).at(-1)).toBe("STM32F407 的 USART1 打印全是乱码")
    expect(manager.get(session.id).title).toBe("STM32F407 的 USART1 打印全是乱码")

    gate.resolve()
    await waitFor(() => manager.get(session.id).title === "STM32 USART1 乱码排查", 10_000, "标题换上")
    expect(titlesOf(events, session.id).at(-1)).toBe("STM32 USART1 乱码排查")
    await waitFor(() => idle(manager, session.id), 10_000, "正文这一轮跑完")

    // 起名请求只带第一句话原文,包在标签里。
    expect(titleRequests).toHaveLength(1)
    const body = JSON.stringify(titleRequests[0]!.context.messages.at(-1))
    expect(body).toContain("STM32F407 的 USART1 打印全是乱码。波特率 115200")
    expect(body).toContain("<user_message>")

    // 落盘了:新进程不打开会话,列表里就是这个名字(从前重启后是工程目录名,要点开才对)。
    await manager.disposeAll()
    const again = reopen()
    const listed = (await again.list(workspace)).find((item) => item.id === session.id)
    expect(listed?.title).toBe("STM32 USART1 乱码排查")
  })

  test("只起一次:第二句话不再起名", async () => {
    const { manager, workspace, titleRequests } = setup({ replies: ["一", "二"] })
    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "第一句" })
    await waitFor(() => manager.get(session.id).title === "自动起的名字" && idle(manager, session.id), 10_000, "起完名")
    await manager.prompt(session.id, { text: "第二句" })
    await waitFor(() => idle(manager, session.id), 10_000, "第二轮跑完")
    await sleep(100)
    expect(titleRequests).toHaveLength(1)
    expect(manager.get(session.id).title).toBe("自动起的名字")
  })

  test("起名期间用户改了名:用户的名字赢,在飞的请求被掐掉,重启后也还是它", async () => {
    const gate = deferred()
    let signal: AbortSignal | undefined
    const { manager, reopen, workspace } = setup({
      onTitle: async (_context, options) => {
        signal = options?.signal
        await gate.promise
        return text("自动起的名字")
      },
    })
    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "看看串口" })
    await waitFor(() => signal !== undefined, 10_000, "起名请求发出")
    await manager.rename(session.id, "我自己起的")
    expect(signal!.aborted).toBe(true)
    gate.resolve()
    await waitFor(() => idle(manager, session.id), 10_000, "正文跑完")
    await sleep(100)
    expect(manager.get(session.id).title).toBe("我自己起的")

    await manager.disposeAll()
    const listed = (await reopen().list(workspace)).find((item) => item.id === session.id)
    expect(listed?.title).toBe("我自己起的")
  })

  test("起名失败:把第一句话的开头定下来当名字(不报 kernel.error)", async () => {
    const { manager, reopen, events, workspace } = setup({ onTitle: () => failed("503 Service Unavailable") })
    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "ESP32-S3 进了 deep sleep 就唤醒不了。板子是 XIAO" })
    await waitFor(() => idle(manager, session.id), 10_000, "正文跑完")
    await waitFor(() => manager.get(session.id).title === "ESP32-S3 进了 deep sleep 就唤醒不了", 10_000, "退回占位")
    expect(events.filter((event) => event.type === "kernel.error")).toEqual([])

    await manager.disposeAll()
    const listed = (await reopen().list(workspace)).find((item) => item.id === session.id)
    expect(listed?.title).toBe("ESP32-S3 进了 deep sleep 就唤醒不了")
  })

  test("建会话时带了名字、宿主没开、YOMA_TITLE_MODEL=off:都不起", async () => {
    const named = setup()
    const session = await named.manager.create(named.workspace, "任务书的标题")
    await named.manager.prompt(session.id, { text: "开始" })
    await waitFor(() => idle(named.manager, session.id), 10_000, "跑完")

    const off = setup({ autoTitle: false })
    const plain = await off.manager.create(off.workspace)
    await off.manager.prompt(plain.id, { text: "开始" })
    await waitFor(() => idle(off.manager, plain.id), 10_000, "跑完")

    vi.stubEnv("YOMA_TITLE_MODEL", "off")
    const env = setup()
    const envSession = await env.manager.create(env.workspace)
    await env.manager.prompt(envSession.id, { text: "开始" })
    await waitFor(() => idle(env.manager, envSession.id), 10_000, "跑完")

    await sleep(100)
    expect(named.titleRequests).toHaveLength(0)
    expect(named.manager.get(session.id).title).toBe("任务书的标题")
    expect(off.titleRequests).toHaveLength(0)
    expect(off.manager.get(plain.id).title).toBe(plain.title)
    expect(env.titleRequests).toHaveLength(0)
    expect(env.manager.get(envSession.id).title).toBe(envSession.title)
  })

  test("接着聊的旧会话(已经有过消息、没有名字)不补起;只发图没打字的第一句也不起", async () => {
    const legacy = setup({ autoTitle: false, replies: ["旧的回复"] })
    const session = await legacy.manager.create(legacy.workspace)
    await legacy.manager.prompt(session.id, { text: "上线自动起名之前聊的" })
    await waitFor(() => idle(legacy.manager, session.id), 10_000, "跑完")
    await legacy.manager.disposeAll()

    const upgraded = legacy.reopen({ autoTitle: true })
    await upgraded.prompt(session.id, { text: "升级之后接着聊" })
    await waitFor(() => idle(upgraded, session.id), 10_000, "跑完")

    const blank = setup()
    const empty = await blank.manager.create(blank.workspace)
    await blank.manager.prompt(empty.id, { text: "   " })
    await waitFor(() => idle(blank.manager, empty.id), 10_000, "跑完")

    await sleep(100)
    expect(legacy.titleRequests).toHaveLength(0)
    expect(upgraded.get(session.id).title).toBe(session.title)
    expect(blank.titleRequests).toHaveLength(0)
    expect(blank.manager.get(empty.id).title).toBe(empty.title)
  })

  test("起名期间会话被删了:不再推它的 session.updated(否则界面会把删掉的会话加回列表)", async () => {
    const gate = deferred()
    let signal: AbortSignal | undefined
    const { manager, events, workspace } = setup({
      onTitle: async (_context, options) => {
        signal = options?.signal
        await gate.promise
        return text("不该出现的名字")
      },
    })
    const session = await manager.create(workspace)
    await manager.prompt(session.id, { text: "马上就删" })
    await waitFor(() => signal !== undefined, 10_000, "起名请求发出")
    await manager.delete(session.id)
    expect(signal!.aborted).toBe(true)
    gate.resolve()
    await sleep(200)
    const deletedAt = events.findIndex((event) => event.type === "session.deleted" && event.sessionID === session.id)
    expect(deletedAt).toBeGreaterThanOrEqual(0)
    const after = events.slice(deletedAt + 1)
    expect(after.some((event) => event.type === "session.updated" && event.session.id === session.id)).toBe(false)
    expect(titlesOf(events, session.id)).not.toContain("不该出现的名字")
  })
})
