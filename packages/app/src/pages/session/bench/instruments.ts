/**
 * 仪器注册表 —— "调试档里有哪几台仪器、现在该露出哪几台"的唯一真源。
 *
 * 加一台仪器(将来的功率分析仪 / 上位机工具)= **往 `INSTRUMENTS` 加一条记录**,
 * 外加两条 i18n(en / zh)。排序、可见性、状态灯、懒加载都由这一条记录带出来,
 * 布局变体一个字都不用改。
 *
 * 这里刻意**不登记还不存在的仪器**:一条指向空组件的记录,在界面上和"这台仪器坏了"
 * 长得一模一样。
 *
 * 可见性 = 核心 ∪ 本会话用过 ∪ 磁盘上有数据 ∪ 用户钉住。为什么要这四条并起来:
 * - 核心:日志永远该在,它是嵌入式调试的默认视线。
 * - 用过:agent 这一轮碰过示波器,面板就该自己出现,不该让用户去找。
 * - 有数据:上一轮存下的波形,重开会话照样看得见(`la.captures` / `scope.captures` 读的是磁盘)。
 * - 钉住:用户明说"我要一直看着它"。
 * 调试器和波形仪器不是核心:打开日志不该把示波器一起顶到右栏。
 */
import { createRoot, createSignal, lazy, type Component, type JSX } from "solid-js"
import type { IconProps } from "@yoma-desktop/ui/icon"
import type { BenchStatus, InstrumentId } from "./bench-status"
import { gdbStateLabel, INSTRUMENT_IDS, logCaptureLabel } from "./bench-status"

/**
 * 出现的频次档,决定它在"+ 仪器"里的排序与将来的默认折叠策略。
 * - `core`:永远显示。
 * - `frequent`:碰过 / 有数据就显示。
 * - `occasional`:同上,但在挑选器里排后面。
 */
export type InstrumentTier = "core" | "frequent" | "occasional"

/**
 * **数据的形状** —— 决定这台仪器该往哪种容器里摆。
 *
 * - `text`:底部控制台。一行一行往下滚的文本流(日志,将来的上位机控制台)。它要的是**宽度**。
 * - `wave`:右栏。示波器、逻辑分析仪,以及调试器。调试器不是时序图,但源码视图要**高度**,
 *   所以跟波形放在同一侧。名字仍叫 `wave`:路由只认这个字符串,不要另起一个 surface。
 *
 * 不按这一档分家的布局(比如 foundation 那份全堆一列的 `BenchPanel`)忽略它即可。
 */
export type InstrumentSurface = "text" | "wave"

/** 灯的四档。与 bench.css 的 `[data-component="bench-led"][data-state=…]` 同一套词。 */
export type InstrumentState = "idle" | "active" | "attention" | "offline"

/** 磁盘上探到的东西。异步取,由面板灌进来 —— 注册表本身是同步纯函数。 */
export interface BenchDisk {
  /** `.yoma/logs` 下的 hw-*.log 份数。 */
  logFiles: number
  /** `la.captures` 的条数。 */
  laCaptures: number
  /** `scope.captures` 的条数。 */
  scopeCaptures: number
}

export const EMPTY_BENCH_DISK: BenchDisk = { logFiles: 0, laCaptures: 0, scopeCaptures: 0 }

export interface InstrumentContext {
  status: BenchStatus
  disk: BenchDisk
  pinned: ReadonlySet<InstrumentId>
}

/**
 * 紧凑装配的参数。`chrome` 是容器**没有**画自己页签行时递进来的那几颗按钮(最大化 / 关闭):
 * 仪器把它和自己的 `controls` 一起挂在自己最上面那一行,容器就不必为一台仪器再占一整行。
 *
 * **给的是一个画按钮的函数,不是画好的元素。** Solid 的 JSX 属性是 getter,读一次就新建一整棵按钮
 * (连同它们的 effect);仪器要先问"有没有 chrome"再决定怎么排,传元素的话光是问一句就多造一份。
 */
export interface CompactProps {
  chrome?: () => JSX.Element
}

export interface InstrumentDef {
  id: InstrumentId
  /** i18n 键(`session.bench.instrument.<id>`)。两份词典都得有,缺键渲染出的是 `undefined`。 */
  labelKey: string
  icon: IconProps["name"]
  tier: InstrumentTier
  /** 数据的形状。见 `InstrumentSurface`。 */
  surface: InstrumentSurface
  /** 懒加载:四台仪器里通常只有一两台在场,没必要让示波器的画布代码进首屏包。 */
  component: Component
  /**
   * 容器**自己带了名牌与工具条**(底部控制台的页签行就是)时渲染的正文。不给就退回 `component` ——
   * 代价只是名牌出现两遍,不是坏掉。
   */
  compact?: Component<CompactProps>
  /** 紧凑装配时挂到容器页签行右侧的控件(日志的过滤框 / 跟随开关)。 */
  controls?: Component
  /** 紧凑装配时名牌右侧那一行读数(`已停止 sh tools/uart-sim.sh`)。 */
  headline?(ctx: InstrumentContext, t: (key: string) => string): string | undefined
  /** 磁盘/会话里有没有它的东西 —— 决定"没人用过也该露出来"。 */
  hasData(ctx: InstrumentContext): boolean
  /** 灯。 */
  status(ctx: InstrumentContext): InstrumentState
}

const LogPanel = lazy(() => import("./log-panel").then((m) => ({ default: m.LogPanel })))
const LogCompact = lazy(() => import("./log-panel").then((m) => ({ default: m.LogCompact })))
const LogControls = lazy(() => import("./log-panel").then((m) => ({ default: m.LogControls })))
const GdbPanel = lazy(() => import("./gdb-panel").then((m) => ({ default: m.GdbPanel })))
// 这两台的面板早就在了(dock 的"调试"档一直在用),注册表只是把它们收编进同一套壳。
const ScopeBody = lazy(() => import("../debug/scope-body").then((m) => ({ default: m.ScopeBody })))
const LaBody = lazy(() => import("../debug/la-waveform").then((m) => ({ default: m.LaBody })))

/**
 * 登记顺序 = 露面顺序。日志在底部控制台。右栏按这条顺序排:
 * 调试器(源码要高度)→ 示波器 → 逻辑分析仪。
 */
export const INSTRUMENTS: readonly InstrumentDef[] = [
  {
    id: "log",
    labelKey: "session.bench.instrument.log",
    icon: "terminal",
    tier: "core",
    surface: "text",
    component: LogPanel,
    compact: LogCompact,
    controls: LogControls,
    // 页签行有一整行宽度,所以来源给全文(挤不下时 CSS 打省略号,鼠标停一下还看得到)——
    // 正因为这一行说全了,紧凑装配里的「来源」读数才被容器藏掉,不占第二行。
    //
    // 兜底那一句管的是**这次会话没碰过 log 工具、而工程里躺着上一次的日志**那种情形:
    // 面板照样放得出行(它读的是磁盘),状态条上却没有「日志」那一格(它只认 transcript),
    // 两边同屏时看起来像是日志凭空冒出来的。说一句"这是磁盘上的上一次采集"就没这个问题了。
    headline: (ctx, t) =>
      logCaptureLabel(ctx.status.log, t, { full: true }) ??
      (ctx.disk.logFiles > 0 ? t("session.bench.log.fromDisk") : undefined),
    hasData: (ctx) => ctx.disk.logFiles > 0 || !!ctx.status.log,
    status: (ctx) => {
      const log = ctx.status.log
      if (log?.capturing) return "active"
      if (typeof log?.exitCode === "number" && log.exitCode !== 0) return "attention"
      if (ctx.disk.logFiles > 0 || log) return "idle"
      return "offline"
    },
  },
  {
    id: "gdb",
    labelKey: "session.bench.instrument.gdb",
    icon: "debug",
    tier: "frequent",
    surface: "wave",
    component: GdbPanel,
    headline: (ctx, t) =>
      [gdbStateLabel(ctx.status.gdb, t), ctx.status.gdb?.location, ctx.status.gdb?.connection]
        .filter(Boolean)
        .join(" · "),
    // gdb 没有落盘证据可探(.yoma/gdb 里是会话转录,不是可回放的现场),所以只看 transcript。
    hasData: (ctx) => !!ctx.status.gdb,
    status: (ctx) => {
      const gdb = ctx.status.gdb
      if (!gdb || gdb.state === "none") return "offline"
      if (gdb.fault) return "attention"
      if (gdb.state === "running") return "active"
      if (gdb.state === "exited" || gdb.state === "connection-lost") return "offline"
      return "idle"
    },
  },
  {
    id: "scope",
    labelKey: "session.bench.instrument.scope",
    icon: "sliders",
    tier: "occasional",
    surface: "wave",
    component: ScopeBody,
    hasData: (ctx) => ctx.disk.scopeCaptures > 0 || !!ctx.status.scope,
    status: (ctx) => {
      if (ctx.status.busy.has("scope")) return "active"
      return ctx.disk.scopeCaptures > 0 || ctx.status.scope ? "idle" : "offline"
    },
  },
  {
    id: "la",
    labelKey: "session.bench.instrument.la",
    icon: "dot-grid",
    tier: "occasional",
    surface: "wave",
    component: LaBody,
    hasData: (ctx) => ctx.disk.laCaptures > 0 || !!ctx.status.la,
    status: (ctx) => {
      if (ctx.status.busy.has("la")) return "active"
      return ctx.disk.laCaptures > 0 || ctx.status.la ? "idle" : "offline"
    },
  },
]

export function instrumentById(id: string): InstrumentDef | undefined {
  return INSTRUMENTS.find((instrument) => instrument.id === id)
}

/** 现在该露出来的仪器,按登记顺序。 */
export function visibleInstruments(ctx: InstrumentContext): InstrumentDef[] {
  return INSTRUMENTS.filter((instrument) => isVisible(instrument, ctx))
}

/** 藏着的那些 —— "+ 仪器"里列的就是它们。 */
export function hiddenInstruments(ctx: InstrumentContext): InstrumentDef[] {
  return INSTRUMENTS.filter((instrument) => !isVisible(instrument, ctx))
}

/**
 * 该露出来的、且数据形状是 `surface` 的那些 —— 按数据形状分家的布局(v2-console:文本流在
 * 底部控制台,波形在右栏)用它。顺序仍是登记顺序。
 */
export function visibleOnSurface(surface: InstrumentSurface, ctx: InstrumentContext): InstrumentDef[] {
  return visibleInstruments(ctx).filter((instrument) => instrument.surface === surface)
}

/** 同上,藏着的那些("+ 仪器"按形状各列各的)。 */
export function hiddenOnSurface(surface: InstrumentSurface, ctx: InstrumentContext): InstrumentDef[] {
  return hiddenInstruments(ctx).filter((instrument) => instrument.surface === surface)
}

export function isVisible(instrument: InstrumentDef, ctx: InstrumentContext): boolean {
  if (instrument.tier === "core") return true
  if (ctx.pinned.has(instrument.id)) return true
  if (ctx.status.used.has(instrument.id)) return true
  return instrument.hasData(ctx)
}

// ---------------------------------------------------------------- 钉住的那些

/**
 * 用户钉住的仪器。
 *
 * **不走 app 的 `persisted()`**:那一套要 `usePlatform()`,只能在 provider 底下调,
 * 而这里要的是一个模块级单例(四种布局都要读同一份,且注册表的纯函数要同步拿到它)。
 * 所以直接落 localStorage,键遵循 `yoma.*` 的命名,读写一律 try/catch ——
 * 无痕窗口 / 清过站点数据时 `localStorage` 会抛,而钉不钉仪器不值得把右栏炸掉。
 */
const PIN_KEY = "yoma.bench.pins"

function readPins(): Set<InstrumentId> {
  try {
    const raw = globalThis.localStorage?.getItem(PIN_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    const known: readonly string[] = INSTRUMENT_IDS
    return new Set(parsed.filter((id): id is InstrumentId => typeof id === "string" && known.includes(id)))
  } catch {
    return new Set()
  }
}

function writePins(pins: ReadonlySet<InstrumentId>) {
  try {
    globalThis.localStorage?.setItem(PIN_KEY, JSON.stringify([...pins]))
  } catch {
    // 存不下就只在本次会话里生效,不报错。
  }
}

export const BENCH_PIN_KEY = PIN_KEY

/**
 * 钉住集合的响应式单例。模块级 `createRoot`(与 `debug` dock 的 ui 状态同一种形态),
 * 所以任何布局在任何位置读到的都是同一份。
 */
export const benchPins = createRoot(() => {
  const [pins, setPins] = createSignal<ReadonlySet<InstrumentId>>(readPins())
  const commit = (next: Set<InstrumentId>) => {
    writePins(next)
    setPins(next)
  }
  return {
    /** 当前钉住的集合(只读)。 */
    all: pins,
    has: (id: InstrumentId) => pins().has(id),
    pin(id: InstrumentId) {
      const next = new Set(pins())
      next.add(id)
      commit(next)
    },
    unpin(id: InstrumentId) {
      const next = new Set(pins())
      next.delete(id)
      commit(next)
    },
    toggle(id: InstrumentId) {
      if (pins().has(id)) this.unpin(id)
      else this.pin(id)
    },
    /** 测试用:回到"一个都没钉"。 */
    reset() {
      commit(new Set())
    },
  }
})

/** 供测试解析一份 localStorage 原文;非法内容一律当作"没钉过"。 */
export const PinsTesting = { readPins, writePins }
