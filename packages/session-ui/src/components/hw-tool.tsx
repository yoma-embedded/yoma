/**
 * 硬件工具卡片的公共外壳 —— flash / log / gdb / la / scope 五张卡共用。
 *
 * 为什么有这一层:时间线里所有硬件动作从前都是同一行灰字("调用了 `gdb`"),和"调用了 `ls`"
 * 长得一模一样 —— agent 找到的 BusFault 出事地址折在一行后面。这五个工具是这个产品的身份,
 * 它们的卡片要在**折叠态就把结论说出来**。
 *
 * 契约(每张卡都守):
 * 1. **折叠态一行**:LED + 工具短名(契约的 `label`)+ 动作 + 一句结论(等宽)。高度与通用卡
 *    同一量级 —— 时间线不许变成一墙大卡片。
 * 2. **展开态是排好版的读数**,不是一坨原始文本;认不出来的部分原样等宽显示。
 * 3. **防御式解析**:`describe*` 拿不准就返回 undefined,组件回落到 `GenericTool`。
 *    旧会话重放时 details 可能是上一个版本的形状,`metadata` 的类型本来就是 `Record<string, unknown>`。
 * 4. **长输出有上限**:`HwMono` 自带内部滚动,`HwLines` 自带条数上限 + "全文见 …"。
 *
 * 视觉原语全部来自 `bench.css`(LED / 读数行 / 等宽数字 / 通道色),与右栏的仪器面板同一套。
 */
import { For, Show, type JSX, type ParentProps } from "solid-js"
import { useI18n } from "@yoma-desktop/ui/context/i18n"
import { BasicTool } from "./basic-tool"
import { readoutIsWide } from "./hw-format"
import type { ToolProps } from "./message-part"

/** 与 `bench.css` 的 `[data-component="bench-led"][data-state=…]` 同一套词。 */
export type HwState = "ok" | "active" | "warn" | "attention" | "fail" | "idle" | "offline"

export interface HwTrigger {
  state: HwState
  /** 工具短名。来自契约的 `label`(`烧录` / `日志` / `调试器` / `逻辑分析仪` / `示波器`)。 */
  label: string
  /** 这一次干的事:`start qemu` / `wait /HARDFAULT/`。等宽、弱化,挤不下时先截它。 */
  action?: string
  /** 一句结论。等宽,按 state 着色 —— 这是整张卡片存在的理由。 */
  conclusion?: string
}

export function HwTriggerRow(props: { model: HwTrigger; pending?: boolean }) {
  return (
    <div data-component="hw-trigger" data-state={props.model.state}>
      <span data-component="bench-led" data-state={props.pending ? "active" : props.model.state} aria-hidden="true" />
      <span data-slot="label">{props.model.label}</span>
      <Show when={props.model.action}>
        <span data-slot="action" class="bench-mono">
          {props.model.action}
        </span>
      </Show>
      <Show when={props.model.conclusion && !props.pending}>
        <span data-slot="sep" aria-hidden="true">
          ·
        </span>
        <span data-slot="conclusion" class="bench-mono">
          {props.model.conclusion}
        </span>
      </Show>
    </div>
  )
}

/**
 * 一张硬件卡。`trigger` 是折叠态那一行,children 是展开态。
 *
 * `defer` 跟着时间线的 `deferContent` 走(虚拟列表挂载时不要一口气把所有展开态建出来),
 * running 态照常可以展开 —— 走进度通道的工具(flash / log)边跑边有活尾巴。
 */
export function HwTool(props: ToolProps & { trigger: HwTrigger; children?: JSX.Element }) {
  const pending = () => props.status === "pending"
  return (
    <BasicTool
      {...props}
      defer={props.deferContent}
      icon="mcp"
      trigger={<HwTriggerRow model={props.trigger} pending={pending()} />}
    >
      <div data-component="hw-body">{props.children}</div>
    </BasicTool>
  )
}

/** 展开态里的一块:小号大写的名牌 + 一条发丝线 + 内容。 */
export function HwSection(props: ParentProps<{ title: string; meta?: string; tone?: HwState }>) {
  return (
    <section data-component="hw-section">
      <div data-component="bench-panel-head" data-state={props.tone}>
        <span data-slot="title">{props.title}</span>
        <span data-slot="rule" />
        <Show when={props.meta}>
          <span data-slot="meta">{props.meta}</span>
        </Show>
      </div>
      {props.children}
    </section>
  )
}

/**
 * 键值读数行。`tone` 给值上色(fail = 红,warn = 黄,ok = 绿)。
 * `wide` = 这一条的值长(一段命令、一句触发描述、异常帧那一串),占满整行 ——
 * 两列布局下窄格子会把 `PSP(EXC_RETURN=0xfffffffd,基本帧)` 从中间劈开。
 * 不写 `wide` 时长字符串也会自动整行(`readoutIsWide`,那里有为什么)。
 */
export function HwReadout(props: { k: string; v: JSX.Element; tone?: HwState; title?: string; wide?: boolean }) {
  return (
    <div
      data-component="bench-readout"
      data-tone={props.tone}
      data-wide={readoutIsWide(props.v, props.wide) ? "" : undefined}
    >
      <span data-slot="key">{props.k}</span>
      <span data-slot="dots" />
      <span data-slot="val" title={props.title}>
        {props.v}
      </span>
    </div>
  )
}

/** 一堆读数行。 */
export function HwReadouts(props: ParentProps) {
  return <div data-component="hw-readouts">{props.children}</div>
}

/**
 * 一段等宽原文。**永远有上限** —— 内部滚动,卡片不许因为一次 40 KB 的 OpenOCD 输出
 * 撑出几千像素(时间线的虚拟列表会跟着测一个荒唐的高度)。
 */
export function HwMono(props: { text: string; wrap?: boolean; tall?: boolean }) {
  return (
    <pre data-component="hw-mono" data-wrap={props.wrap ? "" : undefined} data-tall={props.tall ? "" : undefined}>
      {props.text}
    </pre>
  )
}

export interface HwLine {
  text: string
  /** 行级别 —— 与日志面板同一套 `data-level`(error / warn / info / debug)。 */
  level?: string
  /** 命中的那一行:高亮。 */
  hit?: boolean
  /** 行首弱化的那一段(时间戳 / 行号)。 */
  lead?: string
}

/**
 * 日志式的行区。样式与 `bench-log-panel` 的行**逐字同一套**(等宽、级别着色、时间戳弱化),
 * 走的是 bench.css 里那份 —— 面板和卡片不许有两种日志行长相。
 */
export function HwLines(props: { lines: readonly HwLine[]; footer?: JSX.Element }) {
  return (
    <div data-component="hw-lines">
      <div data-slot="lines">
        <For each={props.lines}>
          {(line) => (
            <div data-slot="line" data-level={line.level} data-hit={line.hit ? "" : undefined}>
              <Show when={line.lead}>
                <span data-slot="lead">{line.lead}</span>
              </Show>
              <span data-slot="text">{line.text}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={props.footer}>
        <div data-slot="footer">{props.footer}</div>
      </Show>
    </div>
  )
}

/**
 * 工具给模型看的那段原文。
 *
 * **默认收起来**:卡片已经把同一份内容排好版了,再原样铺一遍是把卡片撑高一倍、把结论
 * 推到屏幕外。收起时它是一行小字;解析没认出任何东西(`open`)时才默认展开 —— 那正是
 * "解析不出就原样等宽显示"那一条。用原生 `<details>`,不需要额外状态,键盘也走得到。
 */
export function HwRaw(props: { text: string; label: string; open?: boolean; wrap?: boolean }) {
  const i18n = useI18n()
  const lines = () => props.text.split("\n").length
  return (
    <details data-component="hw-raw" open={props.open}>
      <summary>
        {props.label}
        <span data-slot="count">{i18n.t("ui.tool.hw.rawLines", { count: lines() })}</span>
      </summary>
      <HwMono text={props.text} wrap={props.wrap} tall />
    </details>
  )
}

/** 一条安静的注意事项(DEMO 仪器、被截断、引擎缺席)。不是一段大字。`code` 是等宽的那一种。 */
export function HwNote(props: ParentProps<{ tone?: "warn" | "muted" | "code" }>) {
  return (
    <p data-component="hw-note" data-tone={props.tone ?? "muted"}>
      {props.children}
    </p>
  )
}

/** 一串小标记(通道名、标志位、断点号)。 */
export function HwTags(props: { items: readonly { text: string; color?: string; tone?: HwState }[] }) {
  return (
    <div data-component="hw-tags">
      <For each={props.items}>
        {(item) => (
          <span data-slot="tag" data-tone={item.tone} style={item.color ? { "--hw-tag-color": item.color } : undefined}>
            {item.text}
          </span>
        )}
      </For>
    </div>
  )
}
