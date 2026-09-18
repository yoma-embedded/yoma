/**
 * gdb 卡片 —— 全场最值钱的那条证据。
 *
 * 折叠态:`● 调试器 exec continue · BusFault PRECISERR · foc_zero_isense() foc.c:45`。
 * 展开态:故障块(类型 / 标志位 / 出事地址 / 出事的那一行 / 异常帧用的哪个栈)、调用栈
 * (帧号等宽对齐)、show 表达式的值、断点回执。解析不出来的部分原样等宽显示。
 *
 * `file:line` **能点**的前提是宿主给了 `onOpenFile`(session-ui 的 Data 上下文那一位)。
 * 桌面端今天还没接上,所以这里是条件式的:接上了就是按钮,没接就是一段可选的等宽文字。
 */
import { createMemo, For, Show } from "solid-js"
import { GDB_CONTRACT } from "@yoma-desktop/kernel/tools/gdb/contract"
import { useI18n } from "@yoma-desktop/ui/context/i18n"
import { GenericTool } from "./basic-tool"
import { useData } from "../context"
import { describeGdb, gdbConclusion } from "./gdb-card"
import type { GdbFrame } from "./gdb-report"
import { shortPath } from "./hw-format"
import { HwNote, HwRaw, HwReadout, HwReadouts, HwSection, HwTags, HwTool, type HwState } from "./hw-tool"
import type { ToolProps } from "./message-part"

/** 出事的那一行:接得上编辑器就是按钮,接不上就是一段等宽文字。 */
function FrameWhere(props: { frame: GdbFrame; path?: string; line?: number }) {
  const data = useData()
  const label = () => props.frame.short ?? props.frame.at
  return (
    <Show
      when={data.openFile && props.path}
      fallback={
        <span data-slot="where" title={props.frame.at}>
          {label()}
        </span>
      }
    >
      <button
        type="button"
        data-slot="where"
        data-clickable=""
        title={props.path}
        onClick={(event) => {
          event.stopPropagation()
          data.openFile?.(props.path!, props.line)
        }}
      >
        {label()}
      </button>
    </Show>
  )
}

/** `stopped#2 breakpoint-hit` —— 名牌右边那一段,超过这个长度读起来就是一条噪声。 */
function stopMeta(stop: { n: number; reason: string } | undefined): string | undefined {
  if (!stop) return undefined
  return `stopped#${stop.n} ${stop.reason.split(" ")[0]}`
}

/** 目标状态词自己的颜色。 */
function stateTone(state: string | undefined): HwState | undefined {
  switch (state) {
    case "running":
      return "active"
    case "halted":
      return "attention"
    case "exited":
    case "connection-lost":
    case "no-session":
      return "offline"
    default:
      return undefined
  }
}

/** 一个字段都没认出来 —— 那就把原文摊开,这一条正是"解析不出就原样显示"。 */
function thin(card: { report: { fault?: unknown; frames: unknown[]; values: unknown[]; breakpoints: unknown[]; notes: unknown[] } }) {
  const { report } = card
  return !report.fault && report.frames.length === 0 && report.values.length === 0 && report.breakpoints.length === 0 && report.notes.length === 0
}

export function GdbTool(props: ToolProps) {
  const i18n = useI18n()
  const card = createMemo(() => describeGdb(props.input, props.metadata, props.output))
  const running = () => props.status === "pending" || props.status === "running"

  const state = (): HwState => {
    const hit = card()
    if (running()) return "active"
    if (!hit) return "idle"
    if (hit.report.fault) return "fail"
    switch (hit.state) {
      case "running":
        return "active"
      case "halted":
        return "attention"
      case "exited":
      case "connection-lost":
      case "no-session":
        return "offline"
      default:
        return "idle"
    }
  }

  return (
    <Show when={card()} fallback={<GenericTool {...props} />}>
      {(hit) => (
        <HwTool
          {...props}
          trigger={{
            state: state(),
            label: GDB_CONTRACT.label,
            action: GDB_CONTRACT.summary(props.input ?? {}) || (hit().action ?? GDB_CONTRACT.name),
            conclusion: running() ? undefined : gdbConclusion(hit())?.text,
          }}
        >
          {/* ---- 故障块:出了事,这一块永远排在最前面 ---- */}
          <Show when={hit().report.fault}>
            {(fault) => (
              <HwSection title={i18n.t("ui.tool.gdb.fault")} tone="attention">
                <HwReadouts>
                  <HwReadout k={i18n.t("ui.tool.gdb.faultKind")} v={fault().kind} tone="fail" />
                  <Show when={fault().flags.length > 0}>
                    <HwReadout
                      k={i18n.t("ui.tool.gdb.flags")}
                      v={<HwTags items={fault().flags.map((flag) => ({ text: flag, tone: "fail" as HwState }))} />}
                    />
                  </Show>
                  <Show when={fault().address}>
                    <HwReadout k={i18n.t("ui.tool.gdb.address")} v={fault().address!} tone="fail" />
                  </Show>
                  <Show when={fault().location}>
                    <HwReadout k={i18n.t("ui.tool.gdb.faultAt")} v={fault().location!} tone="fail" />
                  </Show>
                  <Show when={fault().stack}>
                    <HwReadout k={i18n.t("ui.tool.gdb.excFrame")} v={fault().stack!} wide />
                  </Show>
                </HwReadouts>
                {/* 出事 PC 那一行:符号 + 偏移 + section,原样保留 —— 它的措辞是有意义的。 */}
                <Show when={fault().pcLine}>
                  <HwNote tone="code">{fault().pcLine}</HwNote>
                </Show>
                <Show when={fault().stacked.length > 0}>
                  <div data-component="hw-regs">
                    <For each={fault().stacked}>
                      {(reg) => (
                        <span data-slot="reg">
                          <span data-slot="name">{reg.key}</span>
                          <span data-slot="value">{reg.value}</span>
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
              </HwSection>
            )}
          </Show>

          {/* ---- 调用栈 ---- */}
          <Show when={hit().report.frames.length > 0}>
            <HwSection
              title={i18n.t("ui.tool.gdb.frames")}
              meta={stopMeta(hit().report.stop)}
            >
              <ol data-component="hw-frames">
                <For each={hit().report.frames}>
                  {(frame) => (
                    <li data-fault={frame.short && frame.short === hit().report.fault?.location ? "" : undefined}>
                      <span data-slot="n">#{frame.n}</span>
                      <span data-slot="func">{frame.func}</span>
                      <FrameWhere
                        frame={frame}
                        path={frame.n === 0 ? hit().path : undefined}
                        line={frame.n === 0 ? hit().line : undefined}
                      />
                    </li>
                  )}
                </For>
              </ol>
              <Show when={hit().report.locals}>
                <HwNote>locals: {hit().report.locals}</HwNote>
              </Show>
            </HwSection>
          </Show>

          {/* ---- show / eval 的值 ---- */}
          <Show when={hit().report.values.length > 0}>
            <HwSection title={i18n.t("ui.tool.gdb.values")}>
              <HwReadouts>
                <For each={hit().report.values}>{(value) => <HwReadout k={value.key} v={value.value} />}</For>
              </HwReadouts>
            </HwSection>
          </Show>

          {/* ---- 断点回执 ---- */}
          <Show when={hit().report.breakpoints.length > 0}>
            <HwSection title={i18n.t("ui.tool.gdb.breakpoints")}>
              <HwReadouts>
                <For each={hit().report.breakpoints}>
                  {(bp) => <HwReadout k={`#${bp.n}`} v={[bp.at, bp.where].filter(Boolean).join("  ")} />}
                </For>
              </HwReadouts>
            </HwSection>
          </Show>

          {/* ---- 会话读数 ---- */}
          <HwSection title={i18n.t("ui.tool.hw.readout")}>
            <HwReadouts>
              <Show when={hit().state}>
                {/* 目标状态词按它自己的意思上色 —— halted 不是"出事了",出事的是上面那一块 */}
                <HwReadout k={i18n.t("ui.tool.gdb.state")} v={hit().state!} tone={stateTone(hit().state)} />
              </Show>
              <Show when={hit().location}>
                <HwReadout k={i18n.t("ui.tool.gdb.location")} v={hit().location!} title={hit().path} />
              </Show>
              <Show when={hit().connection}>
                <HwReadout k={i18n.t("ui.tool.gdb.connection")} v={hit().connection!} />
              </Show>
              <For each={hit().report.notes}>{(note) => <HwReadout k={note.key} v={note.value} />}</For>
            </HwReadouts>
            <Show when={hit().file}>
              <HwNote>
                {i18n.t("ui.tool.gdb.sessionLog")} {shortPath(hit().file!, 3)}
              </HwNote>
            </Show>
          </HwSection>

          {/* ---- 认不出来的部分:原样等宽。认出来了就收起来,别把同一份内容铺两遍 ---- */}
          <Show when={typeof props.output === "string" && props.output.length > 0}>
            <HwRaw text={props.output!} label={i18n.t("ui.tool.hw.output")} open={thin(hit())} />
          </Show>
        </HwTool>
      )}
    </Show>
  )
}
