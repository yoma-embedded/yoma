/**
 * 目标卡 —— 板子的"前面板"。状态条(`target-strip.tsx`)是一行会长短变化的状态片;
 * 这张卡是**固定三行**的读数板:烧录 · GDB · 日志,哪一行还没发生过就是一条暗着的 `—`。
 *
 * 为什么固定三行:一台仪器的前面板不会因为某个通道没接线就少一个标签。这三件事是这块板子的
 * 常事,它们**在不在**本身就是信息 —— "日志那一格是空的"和"日志那一格根本不存在"不是一回事。
 * 会不会动的那几台(示波器 / 逻辑分析仪 / 将来的功耗)不在这里,它们在状态条上按需出现。
 *
 * **它不知道自己在哪**:没有定位、没有外边距,只有一块自带边框的 flex 列。布局把它摆在
 * 右栏顶、标题栏下、状态栏上方的浮层里都成立。状态与身份都当 prop 收,不自己折 transcript。
 *
 * 移植自 `ui/v3-bench` 的同名文件(那儿它钉在右侧工作台最顶上)。
 */
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { BenchStatus, InstrumentId } from "./bench-status"
import { basename, gdbEnded, gdbHeadline, logHeadline } from "./bench-status"
import type { InstrumentState } from "./instruments"
import { targetSpec, type TargetIdentity } from "./target-identity"
import "./target-card.css"

export interface TargetRow {
  key: "flash" | "gdb" | "log"
  /** 有值时这一行可点(交给 `onSelect`);烧录不是仪器,所以它永远没有。 */
  id?: InstrumentId
  label: string
  /** 没发生过时是 undefined —— 由组件画成一条暗的 `—`。 */
  value?: string
  state: InstrumentState | "ok" | "fail"
  title?: string
}

/** 只给时分秒:前面板说的是"刚刚",不是哪一天。 */
function hhmmss(at: number): string {
  return at ? new Date(at).toLocaleTimeString(undefined, { hour12: false }) : ""
}

/**
 * 磁盘上的旧证据。只用来兜"这次会话没碰过,可上一轮留下的东西还在"这一格 ——
 * 不给它点灯(那不是现状),只让它别显示成"什么都没有"。
 */
export interface TargetDiskHint {
  logFiles?: number
}

/** 纯函数,固定三行。布局要换顺序或取舍,照着改一份就行。 */
export function targetRows(
  status: BenchStatus,
  t: (key: string, params?: Record<string, string | number>) => string,
  disk?: TargetDiskHint,
): TargetRow[] {
  const flash = status.flash
  const gdb = status.gdb
  const log = status.log

  const flashRow: TargetRow = {
    key: "flash",
    label: t("session.bench.chip.flash"),
    state: flash ? (flash.ok ? "ok" : "fail") : "offline",
    title: flash?.error ?? flash?.command,
  }
  if (flash) {
    const image = flash.image ? basename(flash.image) : undefined
    const fail = [flash.exitCode === null ? undefined : `exit ${flash.exitCode}`, hhmmss(flash.at)]
      .filter(Boolean)
      .join(" ")
    flashRow.value = flash.ok ? [`✓ ${hhmmss(flash.at)}`, image].filter(Boolean).join("  ") : `✗ ${fail}`
  }

  const gdbRow: TargetRow = {
    key: "gdb",
    id: "gdb",
    label: t("session.bench.chip.gdb"),
    title: gdb?.fault ?? gdb?.connection,
    // 会话收了之后故障是"历史",不再是要人立刻去看的事:灯回到离线,字还在。
    state: !gdb
      ? "offline"
      : gdbEnded(gdb)
        ? "offline"
        : gdb.fault
          ? "attention"
          : gdb.state === "running"
            ? "active"
            : gdb.state === "exited" || gdb.state === "connection-lost" || gdb.state === "none"
              ? "offline"
              : "idle",
  }
  if (gdb) {
    gdbRow.value = gdb.fault
      ? [
          gdbEnded(gdb) ? t("session.bench.gdb.state.ended") : undefined,
          t("session.bench.state.fault"),
          gdb.faultLocation ?? gdb.location,
        ]
          .filter(Boolean)
          .join(" ")
      : gdbHeadline(gdb)
  }

  const logRow: TargetRow = {
    key: "log",
    id: "log",
    label: t("session.bench.chip.log"),
    title: log?.source ?? log?.file,
    state: !log
      ? "offline"
      : log.capturing
        ? "active"
        : typeof log.exitCode === "number" && log.exitCode !== 0
          ? "attention"
          : "idle",
  }
  if (log) {
    logRow.value = [
      log.capturing ? t("session.bench.state.capturing") : t("session.bench.state.stopped"),
      logHeadline(log),
    ]
      .filter(Boolean)
      .join(" ")
  } else if (disk?.logFiles) {
    // 这次会话没采过,但工程里躺着上一轮的日志 —— 控制台正显示着它,前面板不能说"什么都没有"。
    logRow.value = t("session.bench.target.logOnDisk", { count: disk.logFiles })
  }

  return [flashRow, gdbRow, logRow]
}

export function TargetCard(props: {
  status: BenchStatus
  identity: TargetIdentity
  /** 磁盘上的旧证据,给"这次会话没碰过"的格子兜一句。 */
  disk?: TargetDiskHint
  /** 点某一行时把对应的仪器交出去(开控制台 / 切右栏 —— 由布局决定)。 */
  onSelect?: (id: InstrumentId) => void
}) {
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string | number>) =>
    language.t(key as Parameters<typeof language.t>[0], params)
  const rows = () => targetRows(props.status, t, props.disk)
  /** `stm32f4x · Cortex-M4 r0p0 · STLINK V3J13M4` —— 有几样说几样,没有就整段不画。 */
  const spec = () => targetSpec(props.identity)
  const specTitle = () =>
    props.identity.sources.length > 0
      ? t("session.bench.target.specSource", { source: props.identity.sources.join(" / ") })
      : undefined

  return (
    <section data-component="bench-target-card" aria-label={t("session.bench.target.label")}>
      {/* 铭牌两行:上面是名字(右端留给 `via` 那枚小药丸),下面是芯片 · 内核 · 探针。
          `via` 不跟在铭牌后面,是因为铭牌那一行本来就顶满 320px 的卡宽,而名字这一行空着大半 ——
          而且"这是 qemu 不是真板子"值得待在第一行。 */}
      <div data-slot="head">
        <div data-slot="title">
          <span data-slot="name" title={props.identity.project}>
            {props.identity.project}
          </span>
          <Show when={props.identity.via}>{(via) => <span data-slot="via">via {via()}</span>}</Show>
        </div>
        <Show
          when={spec()}
          fallback={
            <span data-slot="hint">
              {props.status.flash || props.status.gdb || props.status.log
                ? t("session.bench.target.unknown")
                : t("session.bench.strip.empty")}
            </span>
          }
        >
          {(text) => (
            <span data-slot="spec" title={specTitle()}>
              {text()}
            </span>
          )}
        </Show>
      </div>

      <div data-slot="rows">
        <For each={rows()}>{(row) => <TargetRowView row={row} onSelect={props.onSelect} />}</For>
      </div>
    </section>
  )
}

/** 可点与不可点是两种标签(button / div),内容一样 —— 抽出来免得写两遍。 */
function TargetRowView(props: { row: TargetRow; onSelect?: (id: InstrumentId) => void }) {
  const selectable = () => !!props.row.id && !!props.row.value && !!props.onSelect
  const body = () => (
    <>
      <span data-slot="key">
        <span data-component="bench-led" data-state={props.row.state} />
        {props.row.label}
      </span>
      <span data-slot="dots" />
      <span data-slot="val" data-empty={props.row.value ? undefined : "true"}>
        {props.row.value ?? "—"}
      </span>
    </>
  )
  return (
    <Show
      when={selectable()}
      fallback={
        <div data-component="bench-readout" data-row={props.row.key} title={props.row.title}>
          {body()}
        </div>
      }
    >
      <button
        type="button"
        data-component="bench-readout"
        data-row={props.row.key}
        data-instrument={props.row.id}
        title={props.row.title}
        onClick={() => {
          const id = props.row.id
          if (id) props.onSelect?.(id)
        }}
      >
        {body()}
      </button>
    </Show>
  )
}
