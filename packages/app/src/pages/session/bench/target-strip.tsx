/**
 * 目标状态条 —— 一排带指示灯的状态片:烧录 · GDB · 日志 ·(用过才出现的 示波器 / LA)。
 *
 * **它不知道自己在哪**:横排在面板顶、塞进标题栏、竖排在右侧仪器轨、压在底部状态栏,
 * 都只是外层容器的事。所以这里没有定位、没有外边距,只有一个 flex 行
 * (`bench.css` 的 `[data-component="bench-target-strip"]`),外层要换方向自己覆盖就行。
 *
 * 状态显式当 prop 收,不自己去调 `useBenchStatus()` —— 布局里多处放状态条时
 * 不该各折一遍 transcript。
 */
import { createMemo, Index, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { BenchStatus, InstrumentId } from "./bench-status"
import { gdbEnded, gdbHeadline, logHeadline } from "./bench-status"
import { EvidenceDot } from "./evidence-dot"
import type { InstrumentState } from "./instruments"

/** 状态条上的一格。`id` 有值时这一格可点(交给 `onSelect`)。 */
export interface BenchChip {
  key: string
  id?: InstrumentId
  label: string
  value?: string
  /** 灯的档位。`ok` / `fail` 是烧录专用的两档,其余与仪器的四档同名。 */
  state: InstrumentState | "ok" | "fail"
  /**
   * 读数本身的语气,与灯分开。
   *
   * 灯说的是"这台仪器**现在**什么状况"(gdb 会话收了 = offline,灯灭),读数说的是
   * "它**留下了**什么"(`故障 foc.c:45`)。两件事写在同一格里,却不该同一个颜色:
   * 会话收了之后灯该灭,而那一行出事的代码是这次调试**唯一的结论**,灭了就等于把答案藏起来。
   */
  tone?: "fail" | "warn"
  /** 鼠标停住时的全文(命令行、故障原句、日志来源)。 */
  title?: string
}

/** 只给时分秒:状态条上不该出现日期,它说的是"刚刚"。 */
function hhmmss(at: number): string {
  return at ? new Date(at).toLocaleTimeString(undefined, { hour12: false }) : ""
}

/**
 * 从现状拼出要显示的格子。纯函数、没有 solid —— 布局要改顺序或取舍,照着改一份就行。
 *
 * 规矩:烧录 / GDB / 日志**碰过就一直在**(这块板子的三件常事);
 * 示波器与 LA **用过才出现**,免得状态条上永远挂着两盏不亮的灯。
 */
export function benchChips(status: BenchStatus, t: (key: string) => string): BenchChip[] {
  const chips: BenchChip[] = []

  const flash = status.flash
  if (flash) {
    const failValue = [flash.exitCode === null ? undefined : `exit ${flash.exitCode}`, hhmmss(flash.at)]
      .filter(Boolean)
      .join(" ")
    chips.push({
      key: "flash",
      label: t("session.bench.chip.flash"),
      value: flash.ok ? `✓ ${hhmmss(flash.at)}` : `✗ ${failValue}`,
      state: flash.ok ? "ok" : "fail",
      tone: flash.ok ? undefined : "fail",
      title: flash.error ?? flash.image ?? flash.command,
    })
  }

  const gdb = status.gdb
  if (gdb) {
    chips.push({
      key: "gdb",
      id: "gdb",
      label: t("session.bench.chip.gdb"),
      value: gdb.fault
        ? [gdbEnded(gdb) ? t("session.bench.gdb.state.ended") : undefined, t("session.bench.state.fault"), gdb.faultLocation ?? gdb.location]
            .filter(Boolean)
            .join(" ")
        : gdbHeadline(gdb),
      // 会话收了之后故障是"历史",不再是要人立刻去看的事:LED 回到离线,字还在。
      state: gdbEnded(gdb)
        ? "offline"
        : gdb.fault
        ? "attention"
        : gdb.state === "running"
          ? "active"
          : gdb.state === "exited" || gdb.state === "connection-lost" || gdb.state === "none"
            ? "offline"
            : "idle",
      // 故障那一行不跟着灯灭:会话收了它仍然是这次调试的结论。
      tone: gdb.fault ? "fail" : undefined,
      title: gdb.fault ?? gdb.connection,
    })
  }

  const log = status.log
  if (log) {
    chips.push({
      key: "log",
      id: "log",
      label: t("session.bench.chip.log"),
      value: [log.capturing ? t("session.bench.state.capturing") : t("session.bench.state.stopped"), logHeadline(log)]
        .filter(Boolean)
        .join(" "),
      state: log.capturing ? "active" : typeof log.exitCode === "number" && log.exitCode !== 0 ? "attention" : "idle",
      tone: typeof log.exitCode === "number" && log.exitCode !== 0 ? "warn" : undefined,
      title: log.source ?? log.file,
    })
  }

  if (status.used.has("scope") || status.scope) {
    chips.push({
      key: "scope",
      id: "scope",
      label: t("session.bench.chip.scope"),
      value: status.scope ? hhmmss(status.scope.at) : undefined,
      state: status.busy.has("scope") ? "active" : status.scope ? "idle" : "offline",
      title: status.scope?.id,
    })
  }
  if (status.used.has("la") || status.la) {
    chips.push({
      key: "la",
      id: "la",
      label: t("session.bench.chip.la"),
      value: status.la ? hhmmss(status.la.at) : undefined,
      state: status.busy.has("la") ? "active" : status.la ? "idle" : "offline",
      title: status.la?.id,
    })
  }

  return chips
}

export function TargetStrip(props: {
  status: BenchStatus
  /** 点某一格时把对应的仪器交出去(滚到它、开抽屉、切标签页 —— 由布局决定)。 */
  onSelect?: (id: InstrumentId) => void
  /** 一格都没有时显示的提示;不给就整条不渲染。 */
  emptyHint?: string
  /**
   * 把这几格的灯提到 `attention`。
   *
   * 布局知道一些状态条不知道的事 —— v2-console 里是"控制台收着的这段时间里日志又来了几条
   * error"。那不是 `BenchStatus` 的一部分(它只认 transcript),但它正是状态栏该替用户记着的事。
   * `fail` 不被覆盖:红比黄要紧。
   */
  attention?: ReadonlySet<InstrumentId>
  /**
   * 这几格上加一个「有我还没看过的新证据」的提示点(`bench/evidence.ts`)。
   *
   * 与 `attention` 是两件事:黄灯说的是**出了事**,提示点说的是**有新东西你还没看**。
   * 同一格两样都成立时谁让谁由布局决定 —— 状态栏让给黄灯,见 `console/session-status-bar.tsx`。
   */
  unseen?: ReadonlySet<InstrumentId>
}) {
  const language = useLanguage()
  const t = (key: string) => language.t(key as Parameters<typeof language.t>[0])
  // memo:这个函数在一次渲染里被读三次(Show / Index / 内层 Show),而 benchChips 每次
  // 都造一批新对象 —— 不 memo 的话状态一变全部状态片重建,正被键盘聚焦的那颗会丢焦点。
  const chips = createMemo(() => {
    const list = benchChips(props.status, t)
    const raise = props.attention
    if (!raise?.size) return list
    return list.map((chip) =>
      chip.id && raise.has(chip.id) && chip.state !== "fail" ? { ...chip, state: "attention" as const } : chip,
    )
  })

  return (
    <Show when={chips().length > 0 || props.emptyHint}>
      <div data-component="bench-target-strip" role="status" aria-label={t("session.bench.strip.label")}>
        <Index each={chips()}>
          {(chip) => (
            <ChipView
              chip={chip()}
              onSelect={props.onSelect}
              unseen={!!chip().id && !!props.unseen?.has(chip().id!)}
            />
          )}
        </Index>
        <Show when={chips().length === 0 && props.emptyHint}>
          <span data-component="bench-chip" data-state="offline">
            <span data-component="bench-led" data-state="offline" />
            <span data-slot="label">{props.emptyHint}</span>
          </span>
        </Show>
      </div>
    </Show>
  )
}

/** 可点与不可点是两种标签(button / span),内容一样 —— 抽出来免得写两遍。 */
function ChipView(props: { chip: BenchChip; onSelect?: (id: InstrumentId) => void; unseen?: boolean }) {
  const selectable = () => !!props.chip.id && !!props.onSelect
  const body = () => (
    <>
      <span data-component="bench-led" data-state={props.chip.state} />
      <span data-slot="label">{props.chip.label}</span>
      <Show when={props.chip.value}>
        <span data-slot="value">{props.chip.value}</span>
      </Show>
      {/* 提示点排在读数后面:先说这格是什么、现在怎样,再说"还有新的没看"。 */}
      <EvidenceDot when={props.unseen} />
    </>
  )
  return (
    <Show
      when={selectable()}
      fallback={
        <span
          data-component="bench-chip"
          data-state={props.chip.state}
          data-tone={props.chip.tone}
          title={props.chip.title}
        >
          {body()}
        </span>
      }
    >
      <button
        type="button"
        data-component="bench-chip"
        data-state={props.chip.state}
        data-tone={props.chip.tone}
        data-instrument={props.chip.id}
        title={props.chip.title}
        onClick={() => {
          const id = props.chip.id
          if (id) props.onSelect?.(id)
        }}
      >
        {body()}
      </button>
    </Show>
  )
}
