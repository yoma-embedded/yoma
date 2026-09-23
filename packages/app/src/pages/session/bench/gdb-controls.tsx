/**
 * 手动调试器:与这一会话的 agent 共用同一个 gdb 会话(instrument.execute),不经过模型。
 *
 * 布局照 GDB TUI 的信息密度排,不照表单排:
 *   ┌ 工具条(图标按钮)· 停在哪(函数 · 文件:行 · PC · 异常 · 连接)
 *   ├ 代码(源码 / 反汇编)        │ 调用栈 · 局部变量 · 监视 · 寄存器 · 断点
 *   └ 调试控制台:(gdb) 命令行 + 回显(按钮做的事也照 gdb 的写法记一笔)
 * 右栏宽的时候左右两栏,窄的时候上下叠(容器查询,不看窗口宽度)。
 */
import { createEffect, createMemo, For, type JSX, on, onCleanup, Show } from "solid-js"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import type {
  ExecOp,
  GdbBreakpointView,
  GdbDetails,
  GdbInput,
  GdbInspect,
  GdbServerKind,
} from "@yoma-desktop/kernel/tools/gdb/contract"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionKey } from "@/pages/session/session-layout"
import { executeInstrument } from "./instrument-state"
import { createInstrumentSession } from "./instrument-session"
import { useBenchToolParts } from "./use-bench-status"
import {
  baseName,
  type CodeMode,
  GdbCode,
  GdbSidebar,
  type PreviousReadings,
  relativeTo,
  type SectionId,
} from "./gdb-view"
import { breakAt, breakpointOnLine, pendingOnLine, sameSource } from "./gdb-source"
import { commandLineOf, condenseOutput, parseConsole, RESUME, stopBlockOf } from "./gdb-console"
import { GdbIcon, type GdbIconName } from "./gdb-icons"
import "./gdb-controls.css"

/** `agent`:agent 的那一次 gdb 调用(命令行);它的结果照样记成 out / err。 */
type LogKind = "cmd" | "out" | "err" | "stop" | "agent"
interface LogEntry {
  id: number
  kind: LogKind
  text: string
}

const LOG_LIMIT = 400
const HISTORY_LIMIT = 100
const SECTIONS_KEY = "yoma.gdb.sections"
const CONSOLE_KEY = "yoma.gdb.console"
const watchKey = (session: string) => `yoma.gdb.watch:${session}`

/** 监视表达式上限,与内核的 WATCH_LIMIT 相同:多出来的内核不求值,界面上就永远是「…」。 */
export const WATCH_MAX = 20

/** 一次停止的读数(给"刚变过"的高亮当基准)。拷成普通对象:直接存 store 里的数组,下一次 reconcile 会原地改掉它。 */
function readingsOf(inspect: GdbInspect): PreviousReadings {
  const top = inspect.frames.find((frame) => frame.level === inspect.selectedFrame)
  const locals: Record<string, string> = {}
  for (const local of inspect.locals) {
    const value = local.value ?? local.detail
    if (value !== undefined) locals[local.name] = value
  }
  const watches: Record<string, string> = {}
  for (const row of inspect.watches ?? []) if (row.value !== undefined) watches[row.expr] = row.value
  return {
    registers: inspect.registers.map(({ name, value }) => ({ name, value })),
    ...(top?.func ? { func: top.func } : {}),
    locals,
    watches,
  }
}

const EMPTY_READINGS: PreviousReadings = { registers: [], locals: {}, watches: {} }

/**
 * 按会话存的面板状态。右栏换到示波器再换回来,这个组件会被卸载重建 —— 不存的话日志、命令历史、上一份读数、
 * 「重新开始」要用的连接参数全丢,屏幕先空一下再慢慢填回来(用户真撞到过)。只在内存里:gdb 会话本身也不跨重启。
 */
const saved = new Map<string, Record<string, unknown>>()
/** 这些不跟会话走:折叠哪几块、控制台开没开是人的习惯;pending / statusError 是这一次挂载的瞬时状态。 */
const NOT_SAVED = new Set(["sections", "consoleOpen", "pending", "statusError"])

/** localStorage 只放每个人自己的便利(折叠哪几块、盯哪几个表达式);读写都可能抛(隐私窗口、配额)。 */
function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存不下就只在这一次打开里有效
  }
}

export function GdbControls(props: { history?: JSX.Element }) {
  const language = useLanguage()
  const sync = useSync()
  const { params } = useSessionKey()
  const instrument = createInstrumentSession()
  const evidence = useBenchToolParts()
  const t = (key: string) => language.t(`session.gdbControl.${key}` as Parameters<typeof language.t>[0])
  const [state, setState] = createStore({
    server: "external" as GdbServerKind,
    endpoint: "localhost:3333",
    elf: "",
    config: "",
    chip: "",
    machine: "",
    gdbPath: "",
    allowUnverified: false,
    pending: false,
    statusError: "",
    live: undefined as GdbDetails | undefined,
    frame: 0,
    pendingBreaks: [] as { file: string; line: number }[],
    /** 上一次停止(第 0 帧)的读数:侧栏拿它标"刚变过"。 */
    previous: EMPTY_READINGS as PreviousReadings,
    /** 这一次停止的读数与它属于哪次停止(epoch:stopId)。换了一次停止,它才挪进 previous。 */
    snapshot: undefined as { key: string; readings: PreviousReadings } | undefined,
    /** 侧栏 / 反汇编上显示的是上一次停住时的读数(单步、继续之后新读数还没到):变淡,不清空。 */
    stale: false,
    /** 已经记进控制台的 agent 调用(`<part id>:run` / `<part id>:done`),跟着会话存:切回来不重放。 */
    agentSeen: [] as string[],
    /** agent 这一会儿正在跑的那条 gdb 调用,状态行上说一句"Agent:next …"。 */
    agentNow: "",
    /** 连上之后先跑到 main:挂上去时停在 Reset_Handler,.data 还没初始化,这时改变量会被启动代码覆盖。 */
    runToMain: true,
    /** 面板自己连的那一次,「重新开始」要照原样再连(QEMU 没有可靠的复位)。 */
    lastStart: undefined as GdbInput | undefined,
    /** 用户打开的文件;缺省跟着停止位置走。每次停住都回到停止位置(VS Code 同样)。 */
    viewPath: undefined as string | undefined,
    focusLine: undefined as number | undefined,
    mode: "source" as CodeMode,
    watchlist: [] as string[],
    sections: readLocal<Partial<Record<SectionId, boolean>>>(SECTIONS_KEY, {}),
    /** 调试控制台收起时只剩命令行 + 最近一行输出:右栏矮的时候把高度让给源码。 */
    consoleOpen: readLocal<boolean>(CONSOLE_KEY, true),
    log: [] as LogEntry[],
    input: "",
    history: [] as string[],
    historyAt: -1,
  })
  let generation = 0
  let disposed = false
  let polling = false
  let logId = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let logBox: HTMLDivElement | undefined

  const say = (kind: LogKind, text: string) => {
    if (!text) return
    setState(
      produce((draft) => {
        draft.log.push({ id: ++logId, kind, text })
        if (draft.log.length > LOG_LIMIT) draft.log.splice(0, draft.log.length - LOG_LIMIT)
      }),
    )
    requestAnimationFrame(() => {
      if (logBox) logBox.scrollTop = logBox.scrollHeight
    })
  }

  const agentBusy = () => {
    const status = sync().data.session_status[params.id ?? ""]
    return !!status && status.type !== "idle"
  }
  const directory = () => {
    const data = sync().data as { session?: { id: string; directory?: string }[] }
    return data.session?.find((item) => item.id === params.id)?.directory
  }
  const connected = () => !!state.live && state.live.state !== "no-session"
  const halted = () => state.live?.state === "halted"
  const running = () => state.live?.state === "running"
  const ended = () => state.live?.state === "exited" || state.live?.state === "connection-lost"
  const disabled = () => state.pending || agentBusy()
  const canConnect = createMemo(
    () =>
      !!state.elf.trim() &&
      !!(state.server === "external"
        ? state.endpoint.trim()
        : state.server === "openocd"
          ? state.config.trim()
          : state.server === "jlink"
            ? state.chip.trim()
            : state.machine.trim()),
  )

  const readDetails = (details: Record<string, unknown> | undefined) => {
    if (!details || typeof details.state !== "string") return
    const next = details as unknown as GdbDetails
    const prev = state.live
    const moved = !!prev && (prev.stopId !== next.stopId || prev.epoch !== next.epoch)
    if (moved) setState({ frame: 0, viewPath: undefined, focusLine: undefined })

    // 真正的读数只在停住时有(运行中内核只回断点表)。单步 / 继续的回复本身不带读数:这时留着上一份、变淡,
    // 等轮询把新的取回来 —— 清空的话每按一下 F10 侧栏就闪一次空。断点表、预算、源文件清单总是用新的。
    const fresh = next.state === "halted" && !!next.inspect && next.inspect.frames.length > 0
    let inspect = next.inspect
    let stale = false
    if (!fresh && prev?.inspect && prev.epoch === next.epoch && (next.state === "halted" || next.state === "running")) {
      inspect = {
        ...prev.inspect,
        ...(next.inspect
          ? {
              breakpoints: next.inspect.breakpoints,
              ...(next.inspect.breakpointBudget ? { breakpointBudget: next.inspect.breakpointBudget } : {}),
              ...(next.inspect.sources ? { sources: next.inspect.sources } : {}),
            }
          : {}),
      }
      stale = moved || prev.state !== next.state || state.stale
    }

    // "刚变过"的基准:只拿第 0 帧的读数,按"哪一次停止"换代 —— 同一次停止里换帧、加监视都不算"上一次"。
    if (fresh && next.inspect!.selectedFrame === 0) {
      const key = `${next.epoch}:${next.stopId}`
      const readings = readingsOf(next.inspect!)
      if (state.snapshot && state.snapshot.key !== key) {
        setState("previous", reconcile(structuredClone(unwrap(state.snapshot.readings))))
      }
      setState("snapshot", { key, readings })
    }

    setState("stale", stale)
    setState("live", reconcile(inspect ? { ...next, inspect } : next))
    return moved
  }

  const flushPending = () => {
    const next = state.pendingBreaks[0]
    if (!next || !halted() || agentBusy() || state.pending) return
    setState("pendingBreaks", state.pendingBreaks.slice(1))
    void run({ action: "break", at: breakAt(relativeTo(directory(), next.file), next.line) })
  }

  const statusInput = (frame: number): GdbInput => ({
    action: "status",
    frame,
    // 过 IPC 要是普通数组:store 里的是代理,结构化克隆会报 "could not be cloned"。
    ...(state.watchlist.length ? { watchlist: [...unwrap(state.watchlist)] } : {}),
  })

  const refresh = async (frame = state.frame) => {
    clearTimeout(timer)
    const id = params.id
    if (!id || disposed || polling) return
    // agent 在用调试器时照样轮询(只读,停着不动时内核走缓存):不然它调试的整个过程这里一动不动,
    // 要等它这一轮说完才一下子跳到最后。自己的命令在飞时才让一让。
    if (state.pending) {
      timer = setTimeout(() => void refresh(), 500)
      return
    }
    const mine = generation
    const requested = frame
    polling = true
    try {
      const result = await executeInstrument({ sessionID: id, tool: "gdb", input: statusInput(requested) })
      if (disposed || generation !== mine) return
      const moved = readDetails(result.details)
      setState("statusError", "")
      // 轮询接住的新停止(继续之后撞上断点、agent 让它停的):像 TUI 一样补一段。
      if (moved) {
        const block = stopBlockOf(result.text)
        if (block) say("stop", block)
      }
      if (state.frame !== requested) {
        timer = setTimeout(() => void refresh(), 0)
        return
      }
      flushPending()
    } catch (error) {
      if (!disposed && generation === mine)
        setState("statusError", error instanceof Error ? error.message : String(error))
    } finally {
      polling = false
      // agent 在忙时轮询得勤一点:它一步接一步地走,两秒半一拍会漏掉中间停过的地方。
      if (!disposed && (generation !== mine || connected()))
        timer = setTimeout(() => void refresh(), agentBusy() ? 800 : 2500)
    }
  }

  const save = (id: string | undefined) => {
    if (!id) return
    const copy = structuredClone(unwrap(state)) as Record<string, unknown>
    for (const key of NOT_SAVED) delete copy[key]
    saved.set(id, copy)
  }
  createEffect(
    on(
      () => params.id,
      (id, previousId) => {
        save(previousId)
        generation++
        const restored = id ? saved.get(id) : undefined
        setState({
          live: undefined,
          statusError: "",
          pending: false,
          frame: 0,
          pendingBreaks: [],
          previous: EMPTY_READINGS,
          snapshot: undefined,
          stale: false,
          agentSeen: [],
          agentNow: "",
          lastStart: undefined,
          viewPath: undefined,
          focusLine: undefined,
          log: [],
          history: [],
          historyAt: -1,
          input: "",
          watchlist: id ? readLocal<string[]>(watchKey(id), []) : [],
          ...(restored ? (structuredClone(restored) as object) : {}),
        })
        void refresh()
      },
    ),
  )
  /**
   * 把 agent 的 gdb 调用实时镜像到这里:开始跑时控制台记一行 `(agent) next`,跑完把它看到的结果记在下面;
   * 结果里的 details 就是这个面板认得的那份(停在哪、第几次停止),直接吃进来,再立刻轮询一次取读数 ——
   * 源码、调用栈、寄存器跟着 agent 一步步走。agent 起的会话,「重新开始」照它的连接参数来。
   * 头一次挂载时已经跑完的那些只标"看过",不把整段历史倒进控制台;最近三条除外,给个上下文。
   */
  const gdbParts = createMemo(() => evidence().filter((part) => part.tool === "gdb"))
  let seededFor: string | undefined
  createEffect(
    on(
      () =>
        [
          params.id,
          gdbParts()
            .map((part) => `${part.id}:${part.state.status}`)
            .join("|"),
        ] as const,
      ([id]) => {
        const parts = gdbParts()
        const seen = new Set(state.agentSeen)
        const marks: string[] = []
        // 挂载前就跑完的那几条只是"给个上下文":记进控制台,但它们的 details 是旧的,不许拿来改当前状态。
        const replay = new Set<string>()
        if (seededFor !== id) {
          seededFor = id
          if (seen.size === 0) {
            const done = parts.filter((part) => part.state.status === "completed" || part.state.status === "error")
            const recent = new Set(done.slice(-3).map((part) => part.id))
            for (const part of parts) {
              if (recent.has(part.id)) {
                replay.add(part.id)
                continue
              }
              if (part.state.status !== "completed" && part.state.status !== "error") continue
              seen.add(`${part.id}:run`)
              seen.add(`${part.id}:done`)
              marks.push(`${part.id}:run`, `${part.id}:done`)
            }
          }
        }
        let running = ""
        let touched = false
        for (const part of parts) {
          const input = part.state.input as GdbInput
          const line = commandLineOf(input)
          const status = part.state.status
          if (status === "pending") continue
          if (!seen.has(`${part.id}:run`)) {
            say("agent", line)
            seen.add(`${part.id}:run`)
            marks.push(`${part.id}:run`)
          }
          if (status === "running") {
            running = line
            continue
          }
          if (seen.has(`${part.id}:done`)) continue
          seen.add(`${part.id}:done`)
          marks.push(`${part.id}:done`)
          touched = true
          if (status === "error") {
            say("err", part.state.error)
            continue
          }
          if (status !== "completed") continue
          say("out", condenseOutput(input, part.state.output))
          const details = part.state.metadata as Record<string, unknown> | undefined
          if (replay.has(part.id)) continue
          // 拷一份:metadata 是同步层 store 里的对象,直接 reconcile 进来会和那边共用同一份。
          if (details && typeof details.state === "string") readDetails(structuredClone(unwrap(details)))
          if (input.action === "start" && details?.state !== "no-session") {
            setState("lastStart", structuredClone(unwrap(input)))
          }
        }
        if (marks.length) setState("agentSeen", (list) => [...list, ...marks].slice(-600))
        setState("agentNow", running)
        if (touched || running) {
          clearTimeout(timer)
          void refresh()
        }
      },
    ),
  )
  createEffect(on(agentBusy, () => void refresh(), { defer: true }))
  onCleanup(() => {
    save(params.id)
    disposed = true
    generation++
    clearTimeout(timer)
  })

  /** 一串动作占一次 pending:连接 + 跑到 main、重新开始这种组合中途不让别的按钮插进来。遇错即停。 */
  const runSteps = async (inputs: GdbInput[]) => {
    if (disabled() || inputs.length === 0) return false
    clearTimeout(timer)
    const mine = ++generation
    setState({ pending: true })
    let ok = true
    try {
      for (const input of inputs) {
        say("cmd", commandLineOf(input))
        const result = await instrument.run("gdb", input)
        if (disposed || generation !== mine) return false
        readDetails(result.details)
        say("out", condenseOutput(input, result.text))
        // start 被拒(镜像对不上等)是正常返回而不是抛错:会话没起来就停在这里,
        // 否则后面的「跑到 main」会再报一句给模型看的 "no gdb session",把真正的原因盖住。
        if (input.action === "start" && result.details?.state === "no-session") {
          ok = false
          break
        }
      }
    } catch (error) {
      ok = false
      if (!disposed && generation === mine) say("err", error instanceof Error ? error.message : String(error))
    } finally {
      if (!disposed && generation === mine) {
        setState("pending", false)
        timer = setTimeout(() => void refresh(), 100)
      }
    }
    return ok
  }
  const run = (input: GdbInput) => runSteps([input])
  const toMain = (): GdbInput[] =>
    state.runToMain
      ? [
          { action: "break", at: "main", temporary: true },
          { action: "exec", op: "continue", waitMs: 10_000 },
        ]
      : []

  const connect = (event: SubmitEvent) => {
    event.preventDefault()
    if (!canConnect()) return
    const start: GdbInput = {
      action: "start",
      server: state.server,
      elfPath: state.elf.trim(),
      ...(state.server === "external" ? { connect: state.endpoint.trim() } : {}),
      ...(state.server === "openocd"
        ? {
            config: state.config
              .split(/[,\n]/)
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
      ...(state.server === "jlink" ? { chip: state.chip.trim() } : {}),
      ...(state.server === "qemu" ? { machine: state.machine.trim() } : {}),
      ...(state.gdbPath.trim() ? { gdbPath: state.gdbPath.trim() } : {}),
      allowUnverified: state.allowUnverified,
    }
    setState("lastStart", start)
    void runSteps([start, ...toMain()])
  }

  const exec = (op: ExecOp) => {
    if (op === "continue") return void run({ action: "exec", op, expectRunning: true, ...RESUME })
    if (op === "interrupt") return void run({ action: "exec", op, waitMs: 3000 })
    void run({ action: "exec", op, ...RESUME })
  }

  /**
   * 重新开始。QEMU 的 system_reset 复位不了 Cortex-M 核,只能断开再按原样连上,断点照原样补回去;
   * OpenOCD / J-Link 走 reset-halt。之后照连接时的选择跑到 main。
   */
  const restart = () => {
    // store 里的是代理对象,过 IPC 的结构化克隆会报 "An object could not be cloned"(真窗口里撞到的)。
    const start = state.lastStart ? structuredClone(unwrap(state.lastStart)) : undefined
    if (start?.server === "qemu") {
      const breaks = (state.live?.inspect?.breakpoints ?? [])
        .filter((bp) => bp.kind === "break")
        .map((bp): GdbInput => ({ action: "break", at: bp.location }))
      void runSteps([{ action: "stop" }, start, ...breaks, ...toMain()])
      return
    }
    void runSteps([{ action: "exec", op: "reset-halt", waitMs: 5000 }, ...toMain()])
  }

  const viewedPath = () => state.viewPath ?? state.live?.path
  const toggleLine = (line: number) => {
    const path = viewedPath()
    if (!path || disabled() || (!halted() && !running())) return
    const hit = breakpointOnLine(state.live?.inspect?.breakpoints, path, line)
    if (hit) return void run({ action: "break", remove: String(hit.number) })
    const queued = pendingOnLine(state.pendingBreaks, path, line)
    if (queued >= 0) {
      setState(
        "pendingBreaks",
        state.pendingBreaks.filter((_, index) => index !== queued),
      )
      return
    }
    // 目标在跑时插不进断点:先记在界面上,下次停住再插(VS Code 的做法)。
    if (running()) return void setState("pendingBreaks", [...state.pendingBreaks, { file: path, line }])
    // 工程里的文件发相对路径:短,而且工程目录带空格时也不怕(内核那边另外会加引号)。
    void run({ action: "break", at: breakAt(relativeTo(directory(), path), line) })
  }
  const toggleAddress = (address: string) => {
    if (disabled() || !halted()) return
    const hit = state.live?.inspect?.breakpoints.find(
      (bp) => bp.kind === "break" && bp.addr && Number(bp.addr) === Number(address),
    )
    void run(hit ? { action: "break", remove: String(hit.number) } : { action: "break", at: `*${address}` })
  }
  const selectFrame = (level: number) => {
    if (disabled() || !halted()) return
    setState({ frame: level, viewPath: undefined, focusLine: undefined })
    void refresh(level)
  }
  const revealBreak = (bp: GdbBreakpointView) => {
    if (!bp.file || !bp.line) return
    setState({
      mode: "source",
      viewPath: sameSource(bp.file, state.live?.path) ? undefined : bp.file,
      focusLine: bp.line,
    })
  }
  const setWatchlist = (list: string[]) => {
    setState("watchlist", list)
    if (params.id) writeLocal(watchKey(params.id), list)
    void refresh()
  }
  const toggleSection = (id: SectionId) => {
    const current = state.sections[id] ?? id === "history"
    setState("sections", id, !current)
    writeLocal(SECTIONS_KEY, unwrap(state.sections))
  }

  /** 控制台的一行:回显用户敲的原样,结果按 eval / exec 的压缩规则记。 */
  const consoleRun = async (raw: string) => {
    const action = parseConsole(raw)
    if (!action) return
    if (action.kind === "refuse") {
      say("cmd", raw)
      say("err", t("consoleNoThread"))
      return
    }
    if (action.kind === "frame") {
      say("cmd", raw)
      const frames = state.live?.inspect?.frames ?? []
      if (!halted() || frames.length === 0) return say("err", t("consoleFrameHalted"))
      const level = action.level ?? state.frame + (action.delta ?? 0)
      const target = frames.find((frame) => frame.level === level)
      if (!target) return say("err", t("consoleNoFrame").replace("{n}", String(level)))
      say(
        "out",
        `#${target.level} ${target.func ?? "??"}${target.file && target.line ? ` at ${baseName(target.file)}:${target.line}` : ""}`,
      )
      selectFrame(level)
      return
    }
    const input = action.input
    clearTimeout(timer)
    const mine = ++generation
    setState("pending", true)
    say("cmd", raw)
    try {
      const result = await instrument.run("gdb", input)
      if (disposed || generation !== mine) return
      readDetails(result.details)
      say("out", condenseOutput(input, result.text))
    } catch (error) {
      if (!disposed && generation === mine) say("err", error instanceof Error ? error.message : String(error))
    } finally {
      if (!disposed && generation === mine) {
        setState("pending", false)
        timer = setTimeout(() => void refresh(), 100)
      }
    }
  }

  const onConsoleKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    const list = state.history
    if (!list.length) return
    // 没在翻历史时按 ↓:什么都不做(不然会把正在打的字清掉)。
    if (event.key === "ArrowDown" && state.historyAt < 0) return
    event.preventDefault()
    const at =
      event.key === "ArrowUp"
        ? state.historyAt < 0
          ? list.length - 1
          : Math.max(0, state.historyAt - 1)
        : state.historyAt < 0
          ? -1
          : state.historyAt + 1
    if (at < 0 || at >= list.length) return void setState({ historyAt: -1, input: "" })
    setState({ historyAt: at, input: list[at]! })
  }

  /** VS Code 的调试快捷键,只在焦点落在调试器里时生效(不和全局快捷键抢)。 */
  const onKey = (event: KeyboardEvent) => {
    const key = event.key
    if (!key.startsWith("F")) return
    const mod = event.ctrlKey || event.metaKey
    let handled = true
    if (
      key === "F5" &&
      mod &&
      event.shiftKey &&
      connected() &&
      (!ended() || state.lastStart?.server === "qemu") &&
      !running() &&
      !disabled()
    )
      restart()
    else if (key === "F5" && !event.shiftKey && halted() && !disabled()) exec("continue")
    else if (key === "F6" && running() && !disabled()) exec("interrupt")
    else if (key === "F10" && halted() && !disabled()) exec("next")
    else if (key === "F11" && event.shiftKey && halted() && !disabled()) exec("finish")
    else if (key === "F11" && halted() && !disabled()) exec("step")
    else handled = false
    if (handled) event.preventDefault()
  }

  const inspect = () => state.live?.inspect
  const topFrame = () => inspect()?.frames.find((frame) => frame.level === 0)
  const tool = (props: {
    icon?: GdbIconName
    text?: string
    label: string
    keys?: string
    tone?: "go" | "stop"
    enabled: boolean
    onClick: () => void
  }) => (
    <button
      type="button"
      data-slot="tool"
      data-tone={props.tone}
      title={props.keys ? `${props.label} (${props.keys})` : props.label}
      aria-label={props.label}
      disabled={!props.enabled}
      onClick={() => props.onClick()}
    >
      <Show when={props.icon} fallback={<span data-slot="tool-text">{props.text}</span>}>
        {(icon) => <GdbIcon name={icon()} />}
      </Show>
    </button>
  )

  return (
    <section
      data-component="gdb-controls"
      data-connected={connected() ? "true" : undefined}
      aria-label={t("title")}
      onKeyDown={onKey}
    >
      <header data-slot="toolbar">
        {/* 目标退出 / 掉线之后工具条照样留着:运行控制全灰,但「断开」还按得动 —— gdb 与 server
            (openocd 攥着探针)要等 stop 才放手,下面的连接表单只管"再连一次"。 */}
        <Show when={connected()}>
          <div data-slot="tools" role="toolbar" aria-label={t("title")}>
            {tool({
              icon: "continue",
              label: t("continue"),
              keys: "F5",
              tone: "go",
              enabled: !disabled() && halted(),
              onClick: () => exec("continue"),
            })}
            {tool({
              icon: "pause",
              label: t("pause"),
              keys: "F6",
              enabled: !disabled() && running(),
              onClick: () => exec("interrupt"),
            })}
            <span data-slot="sep" />
            {tool({
              icon: "over",
              label: t("next"),
              keys: "F10",
              enabled: !disabled() && halted(),
              onClick: () => exec("next"),
            })}
            {tool({
              icon: "into",
              label: t("step"),
              keys: "F11",
              enabled: !disabled() && halted(),
              onClick: () => exec("step"),
            })}
            {tool({
              icon: "out",
              label: t("finish"),
              keys: "Shift+F11",
              enabled: !disabled() && halted(),
              onClick: () => exec("finish"),
            })}
            {tool({
              text: "si",
              label: t("stepi"),
              enabled: !disabled() && halted(),
              onClick: () => exec("stepi"),
            })}
            <span data-slot="sep" />
            {tool({
              icon: "restart",
              label: t("restart"),
              keys: "Ctrl+Shift+F5",
              // 掉线 / 退出之后只有 QEMU 那条"断开再照原样连上"走得通;硬件上的 reset-halt 发给一个没有目标的 gdb 只会报错。
              enabled: !disabled() && !running() && (!ended() || state.lastStart?.server === "qemu"),
              onClick: restart,
            })}
            {tool({
              icon: "disconnect",
              label: t("disconnect"),
              tone: "stop",
              enabled: !disabled(),
              onClick: () => void run({ action: "stop" }),
            })}
          </div>
        </Show>
        <div data-slot="where">
          <span
            data-component="bench-led"
            data-state={
              state.pending
                ? "active"
                : running()
                  ? "active"
                  : halted()
                    ? (inspect()?.exception?.number ?? 0) !== 0
                      ? "attention"
                      : "idle"
                    : "offline"
            }
          />
          <strong>{state.pending ? t("working") : t(state.live?.state ?? "no-session")}</strong>
          <Show when={halted() && topFrame()}>
            {(frame) => (
              <>
                <span data-slot="func">{frame().func ?? "??"}</span>
                <Show when={frame().file && frame().line}>
                  <span data-slot="loc" title={frame().file}>
                    {baseName(frame().file!)}:{frame().line}
                  </span>
                </Show>
                <Show when={frame().addr}>
                  <span data-slot="pc">PC {frame().addr}</span>
                </Show>
              </>
            )}
          </Show>
          {/* 回调形式:子节点拿到的是 when 已经判过的值。写成 inspect()!.exception!.name 的话,
              切走再切回来时子节点可能先于 when 重算,读到 undefined,整页掉进错误页(真窗口里撞到的)。 */}
          <Show when={halted() && (inspect()?.exception?.number ?? 0) !== 0 ? inspect()?.exception : undefined}>
            {(exc) => <span data-slot="exception">{exc().name}</span>}
          </Show>
          <Show when={agentBusy()}>
            <span data-slot="agent" title={t("agentBusy")}>
              {state.agentNow ? `Agent › ${state.agentNow}` : t("agentBusy")}
            </span>
          </Show>
          <Show when={state.statusError}>
            <span data-slot="warn" title={state.statusError}>
              ⚠
            </span>
          </Show>
          <span data-slot="conn">{state.live?.connection}</span>
        </div>
      </header>

      <Show when={!connected() || ended()}>
        <form onSubmit={connect} data-slot="connect">
          <label>
            {t("server")}
            <select
              value={state.server}
              disabled={disabled()}
              onChange={(e) => setState("server", e.currentTarget.value as GdbServerKind)}
            >
              <option value="external">{t("external")}</option>
              <option value="openocd">OpenOCD</option>
              <option value="jlink">J-Link</option>
              <option value="qemu">QEMU</option>
            </select>
          </label>
          <label data-slot="elf">
            ELF
            <input
              required
              placeholder="build/firmware.elf"
              value={state.elf}
              disabled={disabled()}
              onInput={(e) => setState("elf", e.currentTarget.value)}
            />
          </label>
          <Show when={state.server === "external"}>
            <label>
              {t("endpoint")}
              <input
                required
                value={state.endpoint}
                disabled={disabled()}
                onInput={(e) => setState("endpoint", e.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={state.server === "openocd"}>
            <label data-slot="config">
              {t("config")}
              <input
                required
                placeholder="interface/stlink.cfg, target/stm32f4x.cfg"
                value={state.config}
                disabled={disabled()}
                onInput={(e) => setState("config", e.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={state.server === "jlink"}>
            <label>
              {t("chip")}
              <input
                required
                placeholder="STM32G431CB"
                value={state.chip}
                disabled={disabled()}
                onInput={(e) => setState("chip", e.currentTarget.value)}
              />
            </label>
          </Show>
          <Show when={state.server === "qemu"}>
            <label>
              {t("machine")}
              <input
                required
                placeholder="netduinoplus2"
                value={state.machine}
                disabled={disabled()}
                onInput={(e) => setState("machine", e.currentTarget.value)}
              />
            </label>
          </Show>
          <div data-slot="connect-row">
            <label data-slot="check">
              <input
                type="checkbox"
                checked={state.runToMain}
                onChange={(e) => setState("runToMain", e.currentTarget.checked)}
              />
              {t("runToMain")}
            </label>
            <button type="submit" data-primary disabled={disabled() || !canConnect()}>
              {t("connect")}
            </button>
          </div>
          <details data-slot="advanced">
            <summary>{t("advanced")}</summary>
            <label>
              GDB
              <input
                placeholder="arm-none-eabi-gdb"
                value={state.gdbPath}
                onInput={(e) => setState("gdbPath", e.currentTarget.value)}
              />
            </label>
            <label data-slot="check">
              <input
                type="checkbox"
                checked={state.allowUnverified}
                onChange={(e) => setState("allowUnverified", e.currentTarget.checked)}
              />
              {t("unverified")}
            </label>
          </details>
        </form>
      </Show>

      <Show when={connected() && !ended()}>
        <div data-slot="workspace">
          <GdbCode
            directory={directory()}
            path={state.live?.path}
            line={state.live?.line}
            viewPath={state.viewPath}
            focusLine={state.focusLine}
            mode={state.mode}
            onMode={(mode) => setState("mode", mode)}
            onView={(path) =>
              setState({
                viewPath: path && !sameSource(path, state.live?.path) ? path : undefined,
                focusLine: undefined,
              })
            }
            halted={halted()}
            running={running()}
            inspect={inspect()}
            pending={state.pendingBreaks}
            busy={disabled()}
            stale={state.stale}
            onToggleLine={toggleLine}
            onToggleAddress={toggleAddress}
          />
          <GdbSidebar
            inspect={inspect()}
            stale={state.stale}
            watchMax={WATCH_MAX}
            halted={halted()}
            busy={disabled()}
            directory={directory()}
            previous={state.previous}
            watchlist={state.watchlist}
            pending={state.pendingBreaks}
            collapsed={state.sections}
            onToggleSection={toggleSection}
            onSelectFrame={selectFrame}
            onAddWatch={(expr) => {
              if (state.watchlist.length >= WATCH_MAX || state.watchlist.includes(expr)) return
              setWatchlist([...state.watchlist, expr])
            }}
            onRemoveWatch={(index) => setWatchlist(state.watchlist.filter((_, i) => i !== index))}
            onAddBreak={(location) => void run({ action: "break", at: location })}
            onRemoveBreak={(number) => void run({ action: "break", remove: String(number) })}
            onRevealBreak={revealBreak}
            history={props.history}
          />
        </div>
      </Show>

      <div
        data-slot="console"
        data-collapsed={state.consoleOpen ? undefined : "true"}
        role="log"
        aria-label={t("console")}
      >
        <div
          data-slot="console-log"
          ref={(element) => {
            logBox = element
            // 切回来时日志是从存档里恢复的:挂上之后滚到底,停在最新一条,而不是第一条。
            requestAnimationFrame(() => (element.scrollTop = element.scrollHeight))
          }}
        >
          <Show when={state.log.length === 0}>
            <p data-slot="console-hint">{connected() ? t("consoleHint") : t("consoleIdle")}</p>
          </Show>
          <For each={state.log}>
            {(entry) => (
              <pre data-slot="entry" data-kind={entry.kind}>
                {entry.kind === "cmd"
                  ? `(gdb) ${entry.text}`
                  : entry.kind === "agent"
                    ? `(agent) ${entry.text}`
                    : entry.text}
              </pre>
            )}
          </For>
        </div>
        <form
          data-slot="prompt"
          onSubmit={(event) => {
            event.preventDefault()
            // 上一条还在跑(或 agent 正在用调试器):先别收走输入,等一下再按回车。
            if (disabled()) return
            const line = state.input.trim()
            const raw = !line && state.history.length ? state.history[state.history.length - 1]! : line
            if (!raw) return
            if (line) {
              setState(
                produce((draft) => {
                  if (draft.history[draft.history.length - 1] !== line) draft.history.push(line)
                  if (draft.history.length > HISTORY_LIMIT) draft.history.shift()
                }),
              )
            }
            setState({ input: "", historyAt: -1 })
            if (!connected()) {
              say("cmd", raw)
              say("err", t("notConnected"))
              return
            }
            void consoleRun(raw)
          }}
        >
          <span data-slot="ps">(gdb)</span>
          <input
            aria-label={t("console")}
            placeholder={t("consolePlaceholder")}
            spellcheck={false}
            autocomplete="off"
            value={state.input}
            disabled={agentBusy()}
            onInput={(e) => setState({ input: e.currentTarget.value, historyAt: -1 })}
            onKeyDown={onConsoleKey}
          />
          <button
            type="button"
            data-slot="console-toggle"
            aria-expanded={state.consoleOpen}
            title={state.consoleOpen ? t("consoleCollapse") : t("consoleExpand")}
            aria-label={state.consoleOpen ? t("consoleCollapse") : t("consoleExpand")}
            onClick={() => {
              setState("consoleOpen", !state.consoleOpen)
              writeLocal(CONSOLE_KEY, state.consoleOpen)
              requestAnimationFrame(() => {
                if (logBox) logBox.scrollTop = logBox.scrollHeight
              })
            }}
          >
            {state.consoleOpen ? "▾" : "▴"}
          </button>
        </form>
      </div>
    </section>
  )
}
