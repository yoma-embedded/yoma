/**
 * 调试器的两块主视图:左边的代码(源码 / 反汇编),右边的信息分区(栈、局部变量、监视、寄存器、断点)。
 *
 * 排法照 GDB TUI 与 Cortex-Debug:停住那一刻工程师要一眼看到的东西(在哪一行、哪条指令、谁调的它、
 * 变量和寄存器现在是多少、哪些刚变过)全部同时摆出来,不藏在页签后面;每一行都是等宽的一行字,
 * 不画成按钮。分区可以折叠,折叠状态按人记。
 */
import { createEffect, createMemo, For, type JSX, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type {
  GdbAsmLine,
  GdbBreakpointView,
  GdbFrameView,
  GdbInspect,
  GdbLocalView,
  GdbRegisterView,
} from "@yoma-desktop/kernel/tools/gdb/contract"
import { useLanguage } from "@/context/language"
import { kernel } from "@/utils/kernel"
import { breakpointOnLine, changedNames, pendingOnLine, sameSource } from "./gdb-source"
import { parseGdbValue, type GdbValueNode } from "./gdb-value"

type T = (key: string) => string

function useT(): T {
  const language = useLanguage()
  return (key) => language.t(`session.gdbControl.${key}` as Parameters<typeof language.t>[0])
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

/** 工程内的文件显示相对路径,工程外的原样。 */
export function relativeTo(dir: string | undefined, path: string): string {
  const norm = path.replace(/\\/g, "/")
  const base = dir?.replace(/\\/g, "/").replace(/\/$/, "")
  return base && norm.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? norm.slice(base.length + 1) : norm
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const x = Number(a)
  return Number.isFinite(x) && x === Number(b)
}

function splitSource(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** 把某一行摆到滚动框中间。只滚这一个框:scrollIntoView 会连带滚动整条右栏。 */
function centre(scroller: HTMLElement | undefined, selector: string) {
  requestAnimationFrame(() => {
    const row = scroller?.querySelector<HTMLElement>(selector)
    if (!scroller || !row) return
    scroller.scrollTop = row.offsetTop - scroller.clientHeight / 2 + row.offsetHeight / 2
  })
}

// ─── 代码区 ──────────────────────────────────────────────────────────────────

export type CodeMode = "source" | "asm"

export function GdbCode(props: {
  directory?: string
  /** 选中帧所在的文件与行(停止位置,或点选的上层帧)。 */
  path?: string
  line?: number
  /** 正在看的文件:缺省等于 path。 */
  viewPath?: string
  /** 要亮出来的那一行(点了断点列表里的一条)。 */
  focusLine?: number
  mode: CodeMode
  onMode: (mode: CodeMode) => void
  onView: (path: string | undefined) => void
  halted: boolean
  running: boolean
  inspect?: GdbInspect
  pending: readonly { file: string; line: number }[]
  busy: boolean
  /** 反汇编是上一次停住时的(新读数还没到):变淡。源码的当前行跟着 details 走,总是新的。 */
  stale?: boolean
  onToggleLine: (line: number) => void
  onToggleAddress: (address: string) => void
}) {
  const t = useT()
  const [ui, setUi] = createStore({ picking: false, query: "" })
  const shown = () => props.viewPath ?? props.path
  const away = () => !!props.path && !!props.viewPath && !sameSource(props.viewPath, props.path)
  const sources = () => props.inspect?.sources ?? []
  const pick = (text: string) => {
    const wanted = text.trim().toLowerCase().replace(/\\/g, "/")
    if (!wanted) return false
    const hit =
      sources().find((path) => relativeTo(props.directory, path).toLowerCase() === wanted) ??
      sources().find((path) => path.toLowerCase().endsWith(`/${wanted}`))
    if (!hit) return false
    props.onMode("source")
    props.onView(hit)
    setUi({ picking: false, query: "" })
    return true
  }
  const pc = () => props.inspect?.pc
  const asmHere = () => props.inspect?.disassembly?.find((row) => sameAddress(row.address, pc()))

  return (
    <div data-slot="code">
      <div data-slot="code-head">
        <div data-slot="segmented" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={props.mode === "source"}
            onClick={() => props.onMode("source")}
          >
            {t("source")}
          </button>
          <button type="button" role="tab" aria-selected={props.mode === "asm"} onClick={() => props.onMode("asm")}>
            {t("disassembly")}
          </button>
        </div>
        <Show
          when={props.mode === "source"}
          fallback={
            <span data-slot="crumb" data-static>
              {asmHere()?.func ?? "??"}
              <Show when={pc()}>{(value) => <span data-slot="faint"> @ {value()}</span>}</Show>
            </span>
          }
        >
          <Show
            when={ui.picking && sources().length > 0}
            fallback={
              <button
                type="button"
                data-slot="crumb"
                title={t("openFile")}
                disabled={sources().length === 0}
                onClick={() => setUi({ picking: true, query: "" })}
              >
                {shown() ? relativeTo(props.directory, shown()!) : t("openFile")}
                <span data-slot="caret">▾</span>
              </button>
            }
          >
            <input
              data-slot="crumb-input"
              list="gdb-source-files"
              aria-label={t("openFile")}
              placeholder={t("openFile")}
              value={ui.query}
              ref={(element) => requestAnimationFrame(() => element.focus())}
              onInput={(e) => {
                setUi("query", e.currentTarget.value)
                pick(e.currentTarget.value)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") pick(e.currentTarget.value)
                if (e.key === "Escape") setUi({ picking: false, query: "" })
              }}
              onBlur={() => setUi({ picking: false, query: "" })}
            />
            <datalist id="gdb-source-files">
              <For each={sources()}>{(path) => <option value={relativeTo(props.directory, path)} />}</For>
            </datalist>
          </Show>
          <Show when={away()}>
            <button type="button" data-slot="back" title={t("backToStop")} onClick={() => props.onView(undefined)}>
              ↩ {t("backToStop")}
            </button>
          </Show>
        </Show>
      </div>
      <Show
        when={props.mode === "source"}
        fallback={
          <GdbAsm
            lines={props.inspect?.disassembly ?? []}
            pc={pc()}
            func={asmHere()?.func}
            stale={props.stale}
            halted={props.halted}
            breakpoints={props.inspect?.breakpoints ?? []}
            busy={props.busy}
            onToggle={props.onToggleAddress}
          />
        }
      >
        <Show when={shown()} fallback={<p data-slot="empty">{props.running ? t("runningHint") : t("noFrames")}</p>}>
          {(path) => (
            <GdbSource
              directory={props.directory}
              path={path()}
              stopPath={props.path}
              line={props.line}
              focusLine={props.focusLine}
              halted={props.halted}
              running={props.running}
              breakpoints={props.inspect?.breakpoints ?? []}
              pending={props.pending}
              busy={props.busy}
              onToggleLine={props.onToggleLine}
            />
          )}
        </Show>
      </Show>
    </div>
  )
}

function GdbSource(props: {
  directory?: string
  path: string
  stopPath?: string
  line?: number
  focusLine?: number
  halted: boolean
  running: boolean
  breakpoints: readonly GdbBreakpointView[]
  pending: readonly { file: string; line: number }[]
  busy: boolean
  onToggleLine: (line: number) => void
}) {
  const t = useT()
  const [source, setSource] = createStore({ text: "", error: "", loading: false })
  let scroller: HTMLDivElement | undefined
  let request = 0

  createEffect(
    on(
      () => [props.path, props.directory] as const,
      ([path, dir]) => {
        const mine = ++request
        if (!dir) {
          setSource({ text: "", error: t("noSource"), loading: false })
          return
        }
        setSource({ text: "", error: "", loading: true })
        void kernel.file
          .read(dir, path)
          .then((file) => {
            if (mine !== request) return
            const content = typeof file.content === "string" ? file.content : ""
            if (content.includes("\u0000")) setSource({ text: "", error: t("noSource"), loading: false })
            else setSource({ text: content, error: "", loading: false })
          })
          .catch(() => {
            if (mine === request) setSource({ text: "", error: t("noSource"), loading: false })
          })
      },
    ),
  )
  onCleanup(() => request++)

  const here = () => props.halted && sameSource(props.path, props.stopPath)
  // 换文件时源码是异步重读的:等读完、行画出来再滚,不然新内容一到又回到顶部。
  createEffect(() => {
    if (!source.text || source.loading) return
    const target = props.focusLine ?? (here() ? props.line : undefined)
    if (target) centre(scroller, `[data-line="${target}"]`)
  })

  const lines = createMemo(() => splitSource(source.text))
  const canToggle = () => !props.busy && (props.halted || props.running)
  // 行号槽的圆点按"这个文件里哪几行有断点"一次算好:HAL 的 .c 动辄几千行,逐行去扫断点表是 行数 × 断点数。
  const setLines = createMemo(() => {
    const lines = new Set<number>()
    for (const bp of props.breakpoints) {
      if (bp.kind === "break" && bp.line && breakpointOnLine([bp], props.path, bp.line)) lines.add(bp.line)
    }
    return lines
  })
  const queuedLines = createMemo(
    () => new Set(props.pending.filter((item) => pendingOnLine([item], props.path, item.line) >= 0).map((item) => item.line)),
  )

  return (
    <div data-slot="scroll" ref={(element) => (scroller = element)}>
      <Show when={source.loading}>
        <p data-slot="empty">{t("loading")}</p>
      </Show>
      <Show when={source.error}>
        <p data-slot="empty">{source.error}</p>
      </Show>
      <For each={lines()}>
        {(text, index) => {
          const line = () => index() + 1
          const set = () => setLines().has(line())
          const queued = () => queuedLines().has(line())
          const current = () => here() && props.line === line()
          return (
            <div
              data-slot="row"
              data-line={line()}
              data-current={current() ? "true" : undefined}
              data-focus={props.focusLine === line() ? "true" : undefined}
            >
              <button
                type="button"
                data-slot="gutter"
                data-set={set() ? "true" : undefined}
                data-pending={queued() ? "true" : undefined}
                aria-pressed={!!set() || queued()}
                aria-label={t("toggleBreak").replace("{line}", String(line()))}
                disabled={!canToggle()}
                onClick={() => props.onToggleLine(line())}
              >
                <span data-slot="dot" />
                <span data-slot="num">{line()}</span>
              </button>
              <span data-slot="mark">{current() ? "▶" : ""}</span>
              <code>{text || " "}</code>
            </div>
          )
        }}
      </For>
    </div>
  )
}

function GdbAsm(props: {
  lines: readonly GdbAsmLine[]
  pc?: string
  /** 当前函数:它自己的指令只写 `<+4>`(标题栏已经写了函数名),别的函数的写全。 */
  func?: string
  stale?: boolean
  halted: boolean
  breakpoints: readonly GdbBreakpointView[]
  busy: boolean
  onToggle: (address: string) => void
}) {
  const t = useT()
  let scroller: HTMLDivElement | undefined
  createEffect(() => {
    const pc = props.pc
    if (!pc || props.lines.length === 0) return
    const row = props.lines.find((line) => sameAddress(line.address, pc))
    if (row) centre(scroller, `[data-address="${row.address}"]`)
  })
  return (
    <div
      data-slot="scroll"
      data-kind="asm"
      data-stale={props.stale ? "true" : undefined}
      ref={(element) => (scroller = element)}
    >
      <Show when={props.lines.length > 0} fallback={<p data-slot="empty">{t("noDisassembly")}</p>}>
        <For each={props.lines}>
          {(row) => {
            const set = () => props.breakpoints.some((bp) => bp.kind === "break" && sameAddress(bp.addr, row.address))
            const current = () => props.halted && sameAddress(row.address, props.pc)
            return (
              <div data-slot="row" data-address={row.address} data-current={current() ? "true" : undefined}>
                <button
                  type="button"
                  data-slot="gutter"
                  data-set={set() ? "true" : undefined}
                  aria-pressed={set()}
                  aria-label={t("toggleBreakAt").replace("{address}", row.address)}
                  disabled={props.busy || !props.halted}
                  onClick={() => props.onToggle(row.address)}
                >
                  <span data-slot="dot" />
                </button>
                <span data-slot="mark">{current() ? "▶" : ""}</span>
                <span data-slot="addr">{row.address}</span>
                <span data-slot="sym" title={row.func ? `${row.func}+${row.offset ?? 0}` : undefined}>
                  {row.func ? (row.func === props.func ? `<+${row.offset ?? 0}>` : `<${row.func}+${row.offset ?? 0}>`) : ""}
                </span>
                <code>{row.inst}</code>
              </div>
            )
          }}
        </For>
      </Show>
    </div>
  )
}

// ─── 右侧分区 ────────────────────────────────────────────────────────────────

export type SectionId = "stack" | "locals" | "watch" | "registers" | "breakpoints" | "history"

function Section(props: {
  id: SectionId
  title: string
  meta?: string
  collapsed: boolean
  onToggle: (id: SectionId) => void
  children: JSX.Element
}) {
  return (
    <section data-slot="section" data-section={props.id} data-collapsed={props.collapsed ? "true" : undefined}>
      <button
        type="button"
        data-slot="section-head"
        aria-expanded={!props.collapsed}
        onClick={() => props.onToggle(props.id)}
      >
        <span data-slot="caret">{props.collapsed ? "▸" : "▾"}</span>
        <span data-slot="title">{props.title}</span>
        <Show when={props.meta}>
          <span data-slot="meta">{props.meta}</span>
        </Show>
      </button>
      <Show when={!props.collapsed}>
        <div data-slot="section-body">{props.children}</div>
      </Show>
    </section>
  )
}

function ValueTree(props: { node: GdbValueNode; depth: number; changed?: boolean; title?: string }) {
  return (
    <Show
      when={props.node.children}
      fallback={
        <div data-slot="var" title={props.title} data-changed={props.changed ? "true" : undefined}>
          <span data-slot="name">{props.node.name}</span>
          <span data-slot="value">{props.node.value}</span>
        </div>
      }
    >
      {(children) => (
        <details data-slot="var-tree" open={props.depth === 0 && children().length <= 6}>
          <summary title={props.title} data-changed={props.changed ? "true" : undefined}>
            <span data-slot="name">{props.node.name}</span>
            <span data-slot="value" data-faint>
              {props.node.value}
            </span>
          </summary>
          <div data-slot="var-children">
            <For each={children()}>{(child) => <ValueTree node={child} depth={props.depth + 1} />}</For>
          </div>
        </details>
      )}
    </Show>
  )
}

/** 上一次停止的读数,用来标"刚变过"(TUI 反白、VS Code 高亮的那一下)。 */
export interface PreviousReadings {
  registers: readonly GdbRegisterView[]
  /** 局部变量只在同一个函数里比:换了函数,同名变量不是同一个东西。 */
  func?: string
  locals: Record<string, string>
  watches: Record<string, string>
}

function xpsrTitle(exception: { number: number; name: string } | undefined): string | undefined {
  return exception ? `IPSR ${exception.number} — ${exception.name}` : undefined
}

function localTitle(local: GdbLocalView): string | undefined {
  return local.type
}

export function GdbSidebar(props: {
  inspect?: GdbInspect
  /** 读数是上一次停住时的:整块变淡,不清空。 */
  stale?: boolean
  watchMax: number
  halted: boolean
  busy: boolean
  directory?: string
  previous: PreviousReadings
  watchlist: readonly string[]
  pending: readonly { file: string; line: number }[]
  collapsed: Partial<Record<SectionId, boolean>>
  onToggleSection: (id: SectionId) => void
  onSelectFrame: (level: number) => void
  onAddWatch: (expr: string) => void
  onRemoveWatch: (index: number) => void
  onAddBreak: (location: string) => void
  onRemoveBreak: (number: number) => void
  onRevealBreak: (bp: GdbBreakpointView) => void
  history?: JSX.Element
}) {
  const t = useT()
  const [draft, setDraft] = createStore({ watch: "", breakpoint: "" })
  const frames = () => props.inspect?.frames ?? []
  const selected = () => props.inspect?.selectedFrame ?? 0
  const selectedFunc = () => frames().find((frame) => frame.level === selected())?.func
  const locals = () => props.inspect?.locals ?? []
  const registers = () => props.inspect?.registers ?? []
  // 寄存器的"刚变过"只在看第 0 帧时算:上层帧的 pc / sp / lr 是回溯出来的,和上一次停止的第 0 帧没法比。
  const changedRegs = createMemo(() =>
    selected() === 0 && !props.stale ? changedNames(props.previous.registers, registers()) : new Set<string>(),
  )
  const localChanged = (local: GdbLocalView) => {
    if (props.stale || !props.previous.func || props.previous.func !== selectedFunc()) return false
    const before = props.previous.locals[local.name]
    const now = local.value ?? local.detail
    return before !== undefined && now !== undefined && before !== now
  }
  // 按表达式找,不按位置:刚加 / 删一条时,手上的结果还是上一份列表的,按位置对就张冠李戴。
  const watchValue = (expr: string) => props.inspect?.watches?.find((row) => row.expr === expr.trim().slice(0, 200))
  const budget = () => {
    const row = props.inspect?.breakpointBudget
    if (!row) return undefined
    return row.total === undefined ? String(row.used) : `${row.used}/${row.total}`
  }
  const pcAddr = () => frames().find((frame) => frame.level === 0)?.addr
  const collapsed = (id: SectionId) => !!props.collapsed[id]

  const frameLabel = (frame: GdbFrameView) =>
    frame.file && frame.line ? `${baseName(frame.file)}:${frame.line}` : (frame.addr ?? "")
  const breakLabel = (bp: GdbBreakpointView) => {
    if (bp.kind === "watch") return bp.location
    const pathLike = /[\\/]|\.\w+:\d+$/.test(bp.location)
    return pathLike && bp.file && bp.line ? `${baseName(bp.file)}:${bp.line}` : bp.location
  }
  const breakWhere = (bp: GdbBreakpointView) => {
    const pathLike = /[\\/]|\.\w+:\d+$/.test(bp.location)
    return !pathLike && bp.file && bp.line ? `${baseName(bp.file)}:${bp.line}` : ""
  }

  return (
    <aside data-slot="sidebar" data-stale={props.stale ? "true" : undefined}>
      <Section
        id="stack"
        title={t("stack")}
        meta={frames().length ? String(frames().length) : undefined}
        collapsed={collapsed("stack")}
        onToggle={props.onToggleSection}
      >
        <Show when={frames().length} fallback={<p data-slot="empty">{t("noFrames")}</p>}>
          <For each={frames()}>
            {(frame) => {
              const handler = () => frame.func === "<signal handler called>"
              return (
                <button
                  type="button"
                  data-slot="frame"
                  data-selected={frame.level === selected() ? "true" : undefined}
                  data-handler={handler() ? "true" : undefined}
                  title={frame.file && frame.line ? `${frame.file}:${frame.line}` : frame.addr}
                  disabled={props.busy || !props.halted || handler()}
                  onClick={() => props.onSelectFrame(frame.level)}
                >
                  <span data-slot="level">#{frame.level}</span>
                  <span data-slot="func">{handler() ? t("exceptionEntry") : (frame.func ?? "??")}</span>
                  <span data-slot="where">{handler() ? "" : frameLabel(frame)}</span>
                </button>
              )
            }}
          </For>
        </Show>
      </Section>

      <Section
        id="locals"
        title={t("locals")}
        meta={selectedFunc()}
        collapsed={collapsed("locals")}
        onToggle={props.onToggleSection}
      >
        <Show when={locals().length} fallback={<p data-slot="empty">{t("noLocals")}</p>}>
          <For each={locals()}>
            {(local) => (
              <Show
                when={local.detail}
                fallback={
                  <ValueTree
                    node={{
                      name: local.name,
                      value:
                        local.value === "<optimized out>"
                          ? t("optimized")
                          : (local.value ?? (local.type ? `{${local.type}}` : "")),
                    }}
                    depth={0}
                    changed={localChanged(local)}
                    title={localTitle(local)}
                  />
                }
              >
                {(detail) => (
                  <ValueTree
                    node={parseGdbValue(detail(), local.value !== undefined ? `${local.name} → *` : local.name)}
                    depth={0}
                    changed={localChanged(local)}
                    title={local.value !== undefined ? `${local.type ?? ""} = ${local.value}` : localTitle(local)}
                  />
                )}
              </Show>
            )}
          </For>
        </Show>
      </Section>

      <Section
        id="watch"
        title={t("watch")}
        meta={props.watchlist.length ? String(props.watchlist.length) : undefined}
        collapsed={collapsed("watch")}
        onToggle={props.onToggleSection}
      >
        <For each={props.watchlist}>
          {(expr, index) => {
            const result = () => watchValue(expr)
            const changed = () => {
              const before = props.previous.watches[expr]
              const now = result()?.value
              return !props.stale && before !== undefined && now !== undefined && before !== now
            }
            return (
              <div data-slot="watch-row">
                <Show
                  when={result()?.value !== undefined ? result() : undefined}
                  fallback={
                    <div data-slot="var" data-error={result()?.error ? "true" : undefined}>
                      <span data-slot="name">{expr}</span>
                      <span data-slot="value">{result()?.error ?? (props.halted ? "…" : t("whenHalted"))}</span>
                    </div>
                  }
                >
                  {(row) => <ValueTree node={parseGdbValue(row().value ?? "", expr)} depth={0} changed={changed()} />}
                </Show>
                <button
                  type="button"
                  data-slot="remove"
                  aria-label={t("removeWatch").replace("{expr}", expr)}
                  onClick={() => props.onRemoveWatch(index())}
                >
                  ×
                </button>
              </div>
            )
          }}
        </For>
        <form
          data-slot="add"
          onSubmit={(event) => {
            event.preventDefault()
            if (!draft.watch.trim()) return
            props.onAddWatch(draft.watch.trim())
            setDraft("watch", "")
          }}
        >
          <input
            aria-label={t("addWatch")}
            placeholder={props.watchlist.length >= props.watchMax ? t("watchFull") : `+ ${t("addWatch")}`}
            disabled={props.watchlist.length >= props.watchMax}
            value={draft.watch}
            onInput={(e) => setDraft("watch", e.currentTarget.value)}
          />
        </form>
      </Section>

      <Section
        id="registers"
        title={t("registers")}
        meta={
          props.inspect?.exception === undefined
            ? undefined
            : props.inspect.exception.number === 0
              ? t("threadMode")
              : props.inspect.exception.name
        }
        collapsed={collapsed("registers")}
        onToggle={props.onToggleSection}
      >
        <Show when={registers().length} fallback={<p data-slot="empty">{t("noRegisters")}</p>}>
          <div data-slot="regs">
            <For each={registers()}>
              {(row) => (
                <div
                  data-slot="reg"
                  data-changed={changedRegs().has(row.name) ? "true" : undefined}
                  title={
                    row.name === "xpsr" ? xpsrTitle(props.inspect?.exception) : undefined
                  }
                >
                  <span data-slot="name">{row.name}</span>
                  <span data-slot="value">{row.value}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Section>

      <Section
        id="breakpoints"
        title={t("breakpoints")}
        meta={budget()}
        collapsed={collapsed("breakpoints")}
        onToggle={props.onToggleSection}
      >
        <For each={props.inspect?.breakpoints ?? []}>
          {(bp) => (
            <div
              data-slot="bp-row"
              data-hit={props.halted && bp.kind === "break" && sameAddress(bp.addr, pcAddr()) ? "true" : undefined}
            >
              <button
                type="button"
                data-slot="bp-main"
                title={[bp.location, bp.addr].filter(Boolean).join(" @ ")}
                disabled={!bp.file || !bp.line}
                onClick={() => props.onRevealBreak(bp)}
              >
                <span data-slot="dot" data-kind={bp.kind} />
                <span data-slot="level">{bp.number}</span>
                <span data-slot="func">{breakLabel(bp)}</span>
                <span data-slot="where">{breakWhere(bp) || bp.addr || ""}</span>
              </button>
              <button
                type="button"
                data-slot="remove"
                aria-label={t("removeBreak").replace("{n}", String(bp.number))}
                disabled={props.busy || !props.halted}
                onClick={() => props.onRemoveBreak(bp.number)}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <For each={props.pending}>
          {(item) => (
            <div data-slot="bp-row" data-pending="true">
              <span data-slot="bp-main">
                <span data-slot="dot" data-hollow />
                <span data-slot="level">·</span>
                <span data-slot="func">{`${baseName(item.file)}:${item.line}`}</span>
                <span data-slot="where">{t("pending")}</span>
              </span>
            </div>
          )}
        </For>
        <form
          data-slot="add"
          onSubmit={(event) => {
            event.preventDefault()
            if (!draft.breakpoint.trim()) return
            props.onAddBreak(draft.breakpoint.trim())
            setDraft("breakpoint", "")
          }}
        >
          <input
            aria-label={t("breakpoint")}
            placeholder={`+ ${t("addBreak")}`}
            value={draft.breakpoint}
            disabled={props.busy || !props.halted}
            onInput={(e) => setDraft("breakpoint", e.currentTarget.value)}
          />
        </form>
      </Section>

      <Show when={props.history}>
        <Section
          id="history"
          title={t("history")}
          collapsed={props.collapsed.history ?? true}
          onToggle={props.onToggleSection}
        >
          {props.history}
        </Section>
      </Show>
    </aside>
  )
}
