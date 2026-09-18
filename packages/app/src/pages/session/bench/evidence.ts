/**
 * 「有我还没看过的新证据」—— 提示点背后的那一份状态。**与布局无关**。
 *
 * 从 `ui/v1-rail` 的 `rail-state.ts` 借来的一半:那边它和"轨上现在亮哪一格"住在一起,
 * 这里只留证据这一半,于是底部控制台、右栏页签、状态栏三处都用得上。
 *
 * 形态与 `benchPins`(instruments.ts)、`consoleUI`(console-state.ts)一致:**模块级单例**。
 * 理由同那两份 —— 状态栏、控制台、右栏都要读同一份,而其中几处(纯函数的可见性判定)
 * 拿不到 provider。落盘直接走 localStorage 的 `yoma.*` 键,读写一律 try/catch:
 * 无痕窗口里 `localStorage` 会抛,而"这台仪器有没有新东西"不值得把会话页炸掉。
 *
 * **提示点靠指纹,不靠计数器。** "有新数据"= 这台仪器此刻的证据指纹 ≠ 我上次看它时记下的那个。
 * 指纹是纯函数(`instrumentSignature`),所以:
 * - 会话切换、app 重开之后照样成立(指纹存着,不依赖运行期的事件流);
 * - agent 反复调同一个工具但没产出新证据时不会假报(指纹没变);
 * - 面板开着的时候不标点 —— 你正看着它,那不叫"新"。
 *
 * 它与"还没看过的 error 数"(`consoleUI.seenErrors`)是两件事,不是一件:那一套说的是
 * **日志里出了事**(黄灯 + 条数),这一套说的是**有新东西你还没看**(安静的一个点)。
 * 同一格上两样都成立时由布局决定谁让谁(状态栏让给黄灯,见 `session-status-bar.tsx`)。
 */
import { createRoot, createSignal } from "solid-js"
import type { InstrumentId } from "./bench-status"
import { INSTRUMENT_IDS } from "./bench-status"
import { visibleInstruments, type InstrumentContext } from "./instruments"

const SEEN_KEY = "yoma.bench.seen"

/** 记多少条。一条大约 40 字节,120 条覆盖几十次会话切换,超了从最早写的那条开始丢。 */
const SEEN_MAX = 120

export const BENCH_SEEN_KEY = SEEN_KEY

/**
 * `seen` 的键:`<会话 id>::<仪器 id>`。
 *
 * **按会话记,不按仪器记。** 指纹里有一半来自 transcript(这次对话里 agent 碰过什么),
 * 换一个没用过逻辑分析仪的会话时那一半会缩水 —— 只按仪器记的话,这看起来就像"它有新东西",
 * 于是每切一次会话就凭空亮一排点。而"有我还没看过的新证据"本来问的就是**这次对话**里的事。
 *
 * 会话 id 缺席(理论上不会,提示点只在会话页里)时退化成全局一条。
 */
export function seenKey(session: string | undefined, id: InstrumentId): string {
  return `${session ?? ""}::${id}`
}

function isInstrumentId(value: unknown): value is InstrumentId {
  return typeof value === "string" && (INSTRUMENT_IDS as readonly string[]).includes(value)
}

/** 读一份落盘的 seen 表。任何一条不认识就丢掉那一条,绝不抛。 */
export function parseSeen(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const seen: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // 键必须是 `<会话>::<认识的仪器>`;别的形状(将来换了键的格式、手改过的存档)直接丢掉,不迁移。
      const at = key.lastIndexOf("::")
      if (at < 0 || !isInstrumentId(key.slice(at + 2)) || typeof value !== "string") continue
      seen[key] = value
    }
    return seen
  } catch {
    return {}
  }
}

function read(): Record<string, string> {
  try {
    return parseSeen(globalThis.localStorage?.getItem(SEEN_KEY))
  } catch {
    return {}
  }
}

function write(value: Record<string, string>) {
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify(value))
  } catch {
    // 存不下就只在本次会话里生效。
  }
}

/**
 * 一台仪器此刻的"证据指纹"。
 *
 * 只由**会不会让人想再看一眼**的东西组成:日志换了文件 / 多了行,gdb 换了 epoch / 多停了一次 /
 * 换了故障,示波器与 LA 换了采集 id 或磁盘上多了一份。刻意**不**含 `busy` —— 那是灯的事,
 * 灯自己会脉冲;把它算进指纹会让每次工具开跑都点一次提示点。
 */
export function instrumentSignature(id: InstrumentId, ctx: InstrumentContext): string {
  const { status, disk } = ctx
  switch (id) {
    case "log": {
      const log = status.log
      return `${disk.logFiles}|${log?.file ?? ""}|${log?.totalLines ?? 0}|${log?.capturing ? 1 : 0}`
    }
    case "gdb": {
      const gdb = status.gdb
      if (!gdb) return "none"
      return `${gdb.epoch}|${gdb.stops.length}|${gdb.state}|${gdb.fault ?? ""}`
    }
    case "scope":
      return `${disk.scopeCaptures}|${status.scope?.id ?? ""}|${status.scope?.at ?? 0}`
    case "la":
      return `${disk.laCaptures}|${status.la?.id ?? ""}|${status.la?.at ?? 0}`
  }
}

/**
 * 指纹里有没有实质内容。`log` 的指纹永远是四段,四段全是零/空就等于"这台仪器什么都没有" ——
 * 那时候标一个提示点是在骗人。
 */
export function hasEvidence(signature: string): boolean {
  if (signature === "none") return false
  return signature.split("|").some((field) => field !== "" && field !== "0")
}

/** 看过的那些指纹。响应式单例:任何布局在任何位置读到的都是同一份。 */
export const benchSeen = createRoot(() => {
  const [seen, setSeen] = createSignal<Record<string, string>>(read())

  return {
    /** 这一对(会话 × 仪器)有没有"我还没看过的新证据"。 */
    unseen(key: string, signature: string): boolean {
      const mark = seen()[key]
      // 从来没看过 + 手上已经有东西了 = 新。`"none"` / 全零的指纹说明它压根没证据,不点。
      if (mark === undefined) return hasEvidence(signature)
      return mark !== signature
    },
    /** 看过了。面板开着时每拍都会调,所以要先比一次再写,别每 100ms 打一次 localStorage。 */
    record(key: string, signature: string) {
      const current = seen()
      if (current[key] === signature) return
      const next = { ...current, [key]: signature }
      // 插入序 = 记录序(JS 对象保留字符串键的插入顺序),超了从最早那条开始丢。
      const keys = Object.keys(next)
      for (const stale of keys.slice(0, Math.max(0, keys.length - SEEN_MAX))) delete next[stale]
      setSeen(next)
      write(next)
    },
    /** 测试与截图工装用:回到"什么都没看过"。 */
    reset() {
      setSeen({})
      write({})
    },
  }
})

/** 这台仪器在**这次会话**里有没有我还没看过的新证据。 */
export function hasUnseen(id: InstrumentId, ctx: InstrumentContext, session: string | undefined): boolean {
  return benchSeen.unseen(seenKey(session, id), instrumentSignature(id, ctx))
}

/** 看过了 —— 面板 / 页签开着的那一刻起,它此刻的证据就不算"新"了。 */
export function markSeen(id: InstrumentId, ctx: InstrumentContext, session: string | undefined) {
  benchSeen.record(seenKey(session, id), instrumentSignature(id, ctx))
}

/**
 * 此刻该点提示点的那些仪器。
 *
 * 两道闸门:
 * 1. **只看该露面的那些** —— 藏着的仪器没有任何地方画得下这个点(而且藏着就等于没有证据)。
 * 2. **开着的那台不点** —— 面板已经在屏幕上了,新证据直接就看见了,再点一个点是噪声。
 *    "哪几台开着"是布局的事,由调用方传进来(v2 见 `console/evidence-view.ts`)。
 */
export function unseenInstruments(
  ctx: InstrumentContext,
  session: string | undefined,
  open?: ReadonlySet<InstrumentId>,
): Set<InstrumentId> {
  const out = new Set<InstrumentId>()
  for (const instrument of visibleInstruments(ctx)) {
    if (open?.has(instrument.id)) continue
    if (hasUnseen(instrument.id, ctx, session)) out.add(instrument.id)
  }
  return out
}
