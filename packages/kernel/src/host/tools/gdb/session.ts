/**
 * gdb 工具的厨房那一半:一个调试会话(gdb 子进程 + 可选的 gdb server)+ 六个对它发指令的动作。
 *
 * 【为什么是 gdb 而不是 DAP】C 嵌入式这一侧的既成事实是 OpenOCD / J-Link / pyOCD + arm-none-eabi-gcc。没有
 * OpenOCD 的 DAP server,也没有 J-Link 的;而 gdb 是通用语,今天 STM32,明天 qemu / RISC-V / 别人的 gdbserver
 * 都是同一套。所以传输是 MI3(mi-session.ts),解析在 domain/gdb。
 *
 * 【明确不做的一件事】没有"连上→跑一条→断开"的一次性动作。--batch 式的 attach/detach 会在连接时暂停目标、
 * 退出时恢复目标,于是模型分不清"固件跑了"和"我自己的查询让它跑了"(实测连续三次一次性查询同一个计数器,
 * 读到 0 → 2,825,990 → 5,672,733)。这条别再提。
 *
 * 与 attic 版不同的几处(同 flash / log / la 的教训):
 * - cwd 每次 execute 从 toolContext 取;中止走 context.abortSignal —— exec 等停止的那几十秒要能被停止按钮
 *   打断,打断时把目标 interrupt 住(停住的目标能恢复,悄悄跑着的不能)。
 * - 发动机的 AgentHarness 不读 executionMode,同一批里的调用并行,所以这里用一条 promise 队列把**全部**
 *   动作串起来:gdb 是单个 REPL、探针是独占设备,没有一个动作适合并发。
 * - 会话关掉时 `dispose()` 收 gdb + server + 释放探针租约(桌面内核长驻,只靠进程退出收尸的话 gdbserver 会
 *   攥着探针到内核退出)。
 * - eval 的闸门多认 load / flash-erase / 表达式里的赋值(domain/gdb/eval-policy.ts),`show` 表达式过同一把尺;
 *   `load` 成功后更新 flash-state,否则下一次 start 会把刚 load 进去的镜像报成"不符"。
 */

import { mkdir, stat } from "node:fs/promises"
import path from "node:path"

import type { AgentHarnessTool, AgentToolResult, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import {
  appendProbeOccupationHint,
  clamp,
  claimProbe,
  describeProbeConflict,
  releaseProbe,
  stamp,
} from "../../domain/engines.ts"
import {
  classifyEval,
  clip,
  escapeCString,
  expressionWrites,
  miNumber,
  miString,
  miTuple,
  shortenPath,
  unwrapList,
} from "../../domain/gdb/index.ts"
import { resolveToCwd } from "../../domain/paths.ts"
import { sha256File, writeFlashState } from "../flash/session.ts"
import {
  DEFAULT_WAIT_MS,
  type ExecOp,
  GDB_CONTRACT,
  type GdbAction,
  type GdbDetails,
  type GdbInput,
  type GdbServerKind,
  MAX_STEP_COUNT,
  MAX_WAIT_MS,
} from "./contract.ts"
import { GdbSession } from "./mi-session.ts"
import {
  buildServerArgv,
  parseConnect,
  pickFreePort,
  SERVER_CAPS,
  serverBinary,
  type ServerProcess,
  spawnServer,
  stopServer,
  waitForServerReady,
} from "./servers.ts"
import {
  type CoreProbe,
  describeStuck,
  displayFrame,
  elfMachineOf,
  fixSourcePaths,
  INTERRUPT_GRACE_MS,
  locationOf,
  probeCore,
  renderBanner,
  renderBreakpoints,
  renderStopReport,
  resolveGdbPath,
  verifyImage,
} from "./target.ts"

/** attach / compare-sections 这类要走 SWD 读大段内存的,给宽一点。 */
const ATTACH_TIMEOUT_MS = 60_000
/** server 从 spawn 到 gdb 端口可连的上限。 */
const SERVER_READY_MS = 20_000
const MAX_EVAL_CHARS = 6_000
const HEARTBEAT_MS = 1_000
const GDB_DIR = path.join(".yoma", "gdb")

/** 需要独占探针的 server。qemu 是纯软件,external 由对方负责。 */
const PROBE_SERVERS: ReadonlySet<GdbServerKind> = new Set<GdbServerKind>(["openocd", "jlink"])

const MI_RESUME: Record<string, string> = {
  continue: "-exec-continue",
  step: "-exec-step",
  next: "-exec-next",
  finish: "-exec-finish",
  stepi: "-exec-step-instruction",
}

export interface GdbToolOptions {
  /** 覆盖 gdb 二进制(测试用;生产按 ELF 架构在 PATH 上找,或 `YOMA_GDB`)。 */
  gdbPath?: string
}

/** 比装配面的工具多一个收尾口:会话关掉时收 gdb、server 与探针租约。 */
export type GdbTool = AgentHarnessTool<ExecutionToolContext, typeof GDB_CONTRACT.parameters, GdbDetails> & {
  dispose(): Promise<void>
}

type GdbResult = AgentToolResult<GdbDetails>
type Update = (partial: GdbResult) => void

function textResult(text: string, details: GdbDetails): GdbResult {
  return { content: [{ type: "text", text }], details }
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    (s) => s.isFile(),
    () => false,
  )
}

/**
 * promise 是否在 ms 之内落定;中止信号一响就按"没落定"返回。拒绝原样传出去,不吞成 false ——
 * 吞掉的话将来某个会抛的调用方会变成"静默 false + unhandled rejection",那种 bug 在硬件路径上极难归因。
 * 定时器 unref:等待绝不能拖住事件循环。
 */
function settledWithin(promise: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }
    const finish = (value: boolean) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve(value)
    }
    const onAbort = () => finish(false)
    const timer = setTimeout(() => finish(false), ms)
    timer.unref?.()
    signal?.addEventListener("abort", onAbort, { once: true })
    promise.then(
      () => finish(true),
      (error) => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

export function createGdbTool(options: GdbToolOptions = {}): GdbTool {
  // 一个工具实例 = 一个调试会话。闭包持有,和 log / la 同构。
  let session: GdbSession | undefined
  let server: ServerProcess | undefined
  let serverKind: GdbServerKind = "external"
  let connection: string | undefined
  let heldProbe = false
  let elfPath: string | undefined
  let core: CoreProbe = {}
  /** 这次会话真正用的 gdb(交接命令要写它,不是裸的 `gdb`:这台机器上多半没有叫 gdb 的东西)。 */
  let gdbPathUsed: string | undefined
  let disposed = false
  /** start 在飞:status 不排队,得知道现在是"正在 attach"还是"没有会话"。 */
  let starting = false
  /** dispose 一按就响:正在等停止的 exec 立刻收手,别让关会话等上两分钟。 */
  const closing = new AbortController()

  // 发动机忽略 executionMode,同一批调用并行 —— gdb 是单个 REPL,全部动作排队(见文件头)。
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const caps = () => SERVER_CAPS[serverKind]

  const detailsOf = (action: GdbAction, extra?: Partial<GdbDetails>): GdbDetails => ({
    action,
    state: session?.running ? session.state : "no-session",
    epoch: session?.epoch ?? 0,
    stopId: session?.stopCount ?? 0,
    ...(session?.running && connection ? { connection } : {}),
    ...(session ? { file: session.file } : {}),
    ...extra,
  })

  /** 停在有源码的位置时给编辑器用;文件在本机不存在就不填。 */
  const withLocation = (action: GdbAction): GdbDetails => {
    const at = locationOf(session?.lastStop?.frame)
    return detailsOf(action, at ? { path: at.path, line: at.line } : undefined)
  }

  const banner = (cwd: string) => renderBanner(session, core, connection, cwd)

  const requireSession = (action: GdbAction): GdbSession => {
    if (session?.running) return session
    throw new Error(
      `no gdb session — run \`gdb\` action:"start" first (${action} needs one). ` +
        'Example with a board: server:"openocd", config:["interface/stlink.cfg","target/stm32g4x.cfg"], elfPath:"build/firmware.elf". ' +
        'Example with no hardware: server:"qemu", machine:"netduinoplus2", elfPath:"build/firmware.elf". ' +
        'Example against a server you already started: connect:"localhost:3333", elfPath:"build/firmware.elf".',
    )
  }

  const teardown = async (keepServer: boolean) => {
    let cleanupNote = ""
    const closingSession = session
    await closingSession?.stop()
    session = undefined
    core = {}
    if (server && !keepServer) {
      // 顺序不能反:gdb 断开后,J-Link 才会退出并清理硬件断点。不能发完 kill 就宣布探针空闲。
      const stopped = await stopServer(server, serverKind === "jlink")
      if (serverKind === "jlink" && (stopped.forced || server.exited?.code !== 0)) {
        cleanupNote = "\nJ-Link did not exit normally. The server process is gone, but hardware breakpoint cleanup is unverified; reconnect before treating target faults as firmware evidence."
      }
    }
    if (!keepServer) {
      server = undefined
      connection = undefined
    }
    // keepServer 留下的 OpenOCD 仍然攥着探针:租约跟着它,别放 —— 放了的话下一次 flash 会被告知
    // 探针空着,然后在硬件层面撞上占用,而不是被指回这里。
    if (heldProbe && !(keepServer && PROBE_SERVERS.has(serverKind))) {
      heldProbe = false
      releaseProbe("gdb")
    }
    return cleanupNote
  }

  /** 目标已经不在了(程序退出 / 探针掉了):任何运行控制都该明说,而不是让 gdb 报 "The program is not being run."。 */
  const requireLive = (s: GdbSession): void => {
    if (s.state === "exited") {
      throw new Error(
        "the target program has exited — there is nothing to resume. Run gdb stop, then gdb start to run it again.",
      )
    }
    if (s.state === "connection-lost") {
      throw new Error(
        "the connection to the target is lost (probe unplugged, target unpowered, or the server died) — run gdb stop, then gdb start to reattach.",
      )
    }
  }

  /** server 最近的输出:QEMU 上固件的 semihosting 打印只有这一条路,目标退出 / 掉线时把它带给模型。 */
  const serverTailNote = (): string =>
    server?.tail.length ? `\nserver output (last lines):\n${server.tail.map((l) => `  ${l}`).join("\n")}` : ""

  /** 停止报告;目标没停在"halted"(退出了 / 掉线了)时把 server 的尾巴接上。 */
  const reportAfterStop = async (s: GdbSession, cwd: string, show?: string[]): Promise<string> => {
    const report = await renderStopReport(s, core, { show, relativeTo: cwd })
    return s.state === "halted" ? report : `${report}${serverTailNote()}`
  }

  /** 每一轮的中止信号与"会话正在关"合成一个。 */
  const abortOf = (signal: AbortSignal | undefined): AbortSignal =>
    signal ? AbortSignal.any([signal, closing.signal]) : closing.signal

  /**
   * resume 一步并等停止。waiter **必须先装** —— 实测 `*stopped` 会先于该命令的结果记录到达,后装就会漏掉
   * 已经发生的停止,然后一路等到超时。中止信号响了就 interrupt 目标再返回:停住的目标能恢复,悄悄跑着的不能。
   */
  const resumeAndWait = async (
    s: GdbSession,
    command: string | undefined,
    waitMs: number,
    onTimeout: "interrupt" | "leave-running",
    signal: AbortSignal,
  ): Promise<{ stopped: boolean; note?: string; error?: string; aborted?: boolean }> => {
    const waiter = s.expectStop()
    if (command) {
      const r = await s.send(command)
      if (r.class === "error") {
        const msg = miString(r.results?.msg) ?? "unknown error"
        // 断点插不进去时 continue 会 abort 且**不 resume**。不说清楚,上层会等到超时,而模型会把它读成"固件卡死了"。
        if (/Cannot insert|Could not insert|Command aborted/i.test(msg)) {
          return {
            stopped: false,
            error: `${msg}\nThe target did NOT resume. This is the hardware breakpoint budget, not a hang — delete a breakpoint (gdb break remove) and try again.`,
          }
        }
        return { stopped: false, error: msg }
      }
    }
    if (await settledWithin(waiter, waitMs, signal)) return { stopped: true }

    if (signal.aborted) {
      const halted = await interruptTarget(s)
      return {
        stopped: halted,
        aborted: true,
        note: halted
          ? "the wait was aborted; the target was interrupted and is halted."
          : `the wait was aborted; -exec-interrupt was sent but nothing stopped within ${INTERRUPT_GRACE_MS} ms.`,
      }
    }
    if (onTimeout === "leave-running") {
      return {
        stopped: false,
        note: `no stop within ${waitMs} ms and the target was left RUNNING. Use exec op:"wait" to keep waiting, or exec op:"interrupt" to halt it now.`,
      }
    }
    // 中断阶梯:-exec-interrupt 的 ^done 只表示"中断已发出",不表示停了。
    if (await interruptTarget(s)) {
      return {
        stopped: true,
        note: `nothing stopped within ${waitMs} ms, so I interrupted the target. Your firmware was running normally — this halt was mine, not a crash.`,
      }
    }
    // "还在跑""睡着了""彻底卡死"是三个完全不同的诊断,不能糊成一句"没停下来"。
    return { stopped: false, note: await describeStuck(s, core, waitMs) }
  }

  const interruptTarget = async (s: GdbSession): Promise<boolean> => {
    const waiter = s.expectStop()
    await s.send("-exec-interrupt").catch(() => undefined)
    return settledWithin(waiter, INTERRUPT_GRACE_MS)
  }

  /** -break-info 里的 type:"watchpoint"(软件)/ "hw watchpoint" / "read watchpoint" / "acc watchpoint" / "breakpoint"。 */
  const breakpointType = async (s: GdbSession, number: number): Promise<string | undefined> => {
    const r = await s.send(`-break-info ${number}`).catch(() => undefined)
    if (!r || r.class !== "done") return undefined
    const rows = unwrapList(miTuple(r.results?.BreakpointTable)?.body, "bkpt")
    return miString(rows.find((row) => miNumber(row.number) === number)?.type)
  }

  async function start(params: GdbInput, cwd: string, signal: AbortSignal): Promise<GdbResult> {
    const notes: string[] = []
    if (session?.running && session.state !== "exited" && session.state !== "connection-lost") {
      // 自动压缩会把会话从上下文里抹掉,但会话还活着。这里**不能抛**:抛出去模型会 stop 再 start,拆掉一个本该留着的会话。
      const text = `${banner(cwd)}\na gdb session is already attached — reusing it.\n${await renderStopReport(session, core, { relativeTo: cwd })}`
      return textResult(text, withLocation("start"))
    }
    if (session?.running) {
      // 目标已经退出 / 连接已断:复用一个没有目标的 gdb 只会从 ELF 文件里读出"看起来像活的"值(审稿实测)。收掉重来。
      notes.push(
        `the previous session's target had ${session.state === "exited" ? "exited" : "lost its connection"} — restarted from scratch`,
      )
      await teardown(false)
    } else if (session || server) {
      // gdb 崩了(running=false)但 server 可能还活着攥着探针:先收干净,否则新起的 server 和它抢同一个探针,
      // 而旧的那个再也没人认(审稿实测:两个 openocd 同时攥着一个 ST-Link,dispose 只收得到新的)。
      await teardown(false)
    }
    if (disposed) throw new Error("gdb start: the session is closing")
    if (signal.aborted) throw new Error("gdb start was aborted")

    if (!params.elfPath) {
      throw new Error(
        "gdb start needs elfPath — the ELF with debug info that matches what is on the target. " +
          "Without symbols every frame is `??` and no breakpoint can be set by name.",
      )
    }
    const elf = resolveToCwd(cwd, params.elfPath)
    if (!(await fileExists(elf))) throw new Error(`ELF file not found: ${elf}`)

    if (params.connect && params.server && params.server !== "external") {
      throw new Error(
        `gdb start got both server:"${params.server}" and connect:"${params.connect}". ` +
          "Pass server to launch one, or connect alone to attach to a server that is already listening.",
      )
    }
    const kind: GdbServerKind = params.server ?? "external"
    if (kind === "external" && !params.connect) {
      throw new Error(
        'gdb start needs either connect:"host:port" (attach to a running server) or server:"openocd|jlink|qemu" plus its options.',
      )
    }

    let host = "localhost"
    let port: number
    if (params.connect) ({ host, port } = parseConnect(params.connect))
    else port = await pickFreePort()

    // argv 在拿探针之前就拼好:缺 config / chip / machine 这种参数错不该先占一把租约再报。
    const serverArgv =
      kind === "external"
        ? undefined
        : buildServerArgv({
            server: kind,
            port,
            chip: params.chip,
            elfPath: elf,
            config: params.config,
            machine: params.machine,
          })
    const machine = await elfMachineOf(elf)
    const { gdbPath } = resolveGdbPath(machine, params.gdbPath ?? options.gdbPath)

    if (serverArgv) serverArgv[0] = serverBinary(kind as Exclude<GdbServerKind, "external">)

    if (PROBE_SERVERS.has(kind)) {
      const holder = claimProbe(
        "gdb",
        `${kind} on ${params.chip ?? "target"}`,
        () => session?.running === true || Boolean(server && !server.exited),
      )
      if (holder) throw new Error(`gdb start: ${describeProbeConflict(holder)}`)
      heldProbe = true
    }

    serverKind = kind
    let started: GdbSession | undefined
    try {
      const dir = path.join(cwd, GDB_DIR)
      await mkdir(dir, { recursive: true })
      const tag = stamp()
      if (serverArgv) {
        server = spawnServer(serverArgv, port, cwd, path.join(dir, `server-${tag}.log`))
        await waitForServerReady(server, caps().readyRe, SERVER_READY_MS, signal, kind === "jlink")
      }
      started = new GdbSession({
        gdbPath,
        cwd,
        logFile: path.join(dir, `session-${tag}.log`),
        miFile: path.join(dir, `session-${tag}.mi`),
        stopsFile: path.join(dir, `stops-${tag}.jsonl`),
      })
      session = started
      await started.spawnGdb()
      await started.hygiene()

      const load = await started.send(`-file-exec-and-symbols "${escapeCString(elf)}"`, ATTACH_TIMEOUT_MS)
      if (load.class === "error") throw new Error(`gdb could not load ${elf}: ${miString(load.results?.msg)}`)

      // waiter 先装:连接时通常紧跟一个 *stopped,而它会先于 ^connected 到达。
      const firstStop = started.expectStop()
      connection = `${host}:${port}`
      const sel = await started.send(`-target-select extended-remote ${connection}`, ATTACH_TIMEOUT_MS)
      if (sel.class === "error") {
        const tail = server?.tail.length ? `\nThe server's last output:\n${server.tail.join("\n")}` : ""
        throw new Error(
          appendProbeOccupationHint(
            `could not connect to ${connection}: ${miString(sel.results?.msg)}${tail}`,
            server?.tail.join("\n") ?? "",
          ),
        )
      }
      await settledWithin(firstStop, 2_000, signal)

      core = await probeCore(started)
      const sourceNote = await fixSourcePaths(started, cwd)
      if (sourceNote) notes.push(sourceNote)
      const image = await verifyImage(cwd, elf)
      notes.push(image.note)
      if (!image.ok && !params.allowUnverified) {
        const text = `${banner(cwd)}\n${image.note}`
        await teardown(false)
        return textResult(text, detailsOf("start"))
      }
      // 起会话的这几十秒里会话被关了:把自己起的收掉,别让它活过会话。
      if (disposed || signal.aborted) {
        await teardown(false)
        throw new Error(disposed ? "gdb start: the session was closed" : "gdb start was aborted")
      }
    } catch (error) {
      await teardown(false)
      throw error
    }

    elfPath = elf
    gdbPathUsed = gdbPath
    const c = core.core
    const lines = [
      banner(cwd),
      `attached to ${connection} via ${kind}, gdb ${gdbPath}`,
      c
        ? `core: ${c.name} ${c.revision}${core.breakpointUnits ? `, ${core.breakpointUnits} hardware breakpoints` : ""}${core.watchpointUnits ? `, ${core.watchpointUnits} watchpoints` : ""}${core.breakpointUnits ? "" : " (breakpoint budget unknown — the FPB did not report one; gdb's own reply decides)"}`
        : "core: not a Cortex-M (no PPB) — fault decoding and hardware budgets are unavailable",
      caps().watchpoints === "none" ? `note: ${kind} does not support watchpoints at all` : "",
      caps().rttHint ? `note: ${caps().rttHint}` : "",
      ...notes,
      `session log: ${started.file}`,
      server?.logFile ? `server log: ${server.logFile}` : "",
      started.lastStop
        ? await renderStopReport(started, core, { relativeTo: cwd })
        : 'target state unknown — run gdb exec op:"interrupt" or op:"continue"',
    ].filter(Boolean)
    return textResult(lines.join("\n"), withLocation("start"))
  }

  async function breakAction(params: GdbInput, cwd: string): Promise<GdbResult> {
    const s = requireSession("break")
    if (params.at && params.watch) {
      throw new Error(
        "gdb break got both at and watch — pass `at` for a code location or `watch` for a data watchpoint, not both.",
      )
    }

    if (params.remove) {
      if (params.remove === "all") {
        await s.send("-break-delete")
        s.breakpoints.clear()
      } else {
        const n = Number(params.remove)
        if (!Number.isInteger(n))
          throw new Error(`gdb break remove: "${params.remove}" is not a breakpoint number or "all"`)
        const r = await s.send(`-break-delete ${n}`)
        if (r.class === "error") throw new Error(miString(r.results?.msg) ?? `could not delete breakpoint ${n}`)
        s.breakpoints.delete(n)
      }
      return textResult(`${banner(cwd)}\n${renderBreakpoints(s, core)}`, detailsOf("break"))
    }

    if (!params.at && !params.watch) {
      return textResult(`${banner(cwd)}\n${renderBreakpoints(s, core)}`, detailsOf("break"))
    }

    if (params.watch) {
      if (caps().watchpoints === "none") {
        throw new Error(
          `${serverKind} has no watchpoint support at all, so this watchpoint would silently never fire. ` +
            "Use OpenOCD or J-Link for watchpoints" +
            (serverKind === "qemu" ? " (QEMU also hangs permanently when a watchpoint is hit — verified)." : "."),
        )
      }
      const used = s.usedUnits("watch")
      if (core.watchpointUnits && used >= core.watchpointUnits) {
        throw new Error(
          `all ${core.watchpointUnits} hardware watchpoints are in use:\n${renderBreakpoints(s, core)}\nDelete one first (gdb break remove).`,
        )
      }
      const flag = params.mode === "r" ? "-r " : params.mode === "rw" ? "-a " : ""
      const r = await s.send(`-break-watch ${flag}${params.watch}`)
      if (r.class === "error") throw new Error(miString(r.results?.msg) ?? "could not set the watchpoint")
      const results = r.results ?? {}
      const wpt = miTuple(results.wpt) ?? miTuple(results["hw-awpt"]) ?? miTuple(results["hw-rwpt"])
      const number = miNumber(wpt?.number)
      if (number !== undefined) s.breakpoints.set(number, { kind: "watch", location: params.watch, units: 1 })
      // MI 对软件与硬件的**写**观察点都回 `wpt=`(只有 console 文本不同),硬/软只能看 -break-info 的 type
      // (审稿实测:阁楼那套"没有 hw- 前缀就是软件"把每一个写观察点都报成 SOFTWARE)。软件观察点会**单步整个程序**,
      // 在 SWD 上慢一万倍,和挂死无法区分;type 读不到就不吓人。
      const type = number === undefined ? undefined : await breakpointType(s, number)
      const warn =
        type === "watchpoint"
          ? '\n⚠ gdb fell back to a SOFTWARE watchpoint — it single-steps the whole program and is indistinguishable from a hang over a probe. Delete it and watch a fixed address instead, e.g. watch:"*(uint32_t*)&var".'
          : ""
      return textResult(
        `${banner(cwd)}\nwatchpoint ${number ?? "?"} on ${params.watch}${warn}\n${renderBreakpoints(s, core)}`,
        detailsOf("break"),
      )
    }

    // 代码断点。留一个单元给 step/next/finish 的临时断点,否则单步会突然失败。
    const usedBreak = s.usedUnits("break")
    // 只有一个比较器的核留不出这一个,那就不留(否则它永远下不了断点)。
    const reserve = core.breakpointUnits && core.breakpointUnits > 1 ? 1 : 0
    if (core.breakpointUnits && usedBreak >= core.breakpointUnits - reserve) {
      throw new Error(
        `${usedBreak} of ${core.breakpointUnits} hardware breakpoints are in use${reserve ? " and one must stay free for step/next/finish" : ""}:\n` +
          `${renderBreakpoints(s, core)}\nDelete one first (gdb break remove).`,
      )
    }
    const flags = [params.temporary ? "-t" : "", params.condition ? `-c "${escapeCString(params.condition)}"` : ""]
      .filter(Boolean)
      .join(" ")
    const r = await s.send(`-break-insert ${flags} ${params.at}`.replace(/\s+/g, " ").trim())
    if (r.class === "error") {
      const msg = miString(r.results?.msg) ?? "unknown"
      if (s.state === "running") {
        throw new Error(
          `${msg}\nThe target is running — halt it first (gdb exec op:"interrupt"); breakpoints cannot be inserted while it runs.`,
        )
      }
      // 只有"找不到位置"那类错误才配这段解释;别的错误(目标在跑、地址非法)配上会把模型引去查一个没问题的符号。
      const pending = /not defined|No symbol|No source file|No line/i.test(msg)
        ? `\n(pending breakpoints are disabled on purpose: there are no shared libraries on bare metal, so a pending breakpoint would never resolve and would look like "this code never runs". Check the symbol name, or use file.c:line.)`
        : ""
      throw new Error(`${msg}${pending}`)
    }
    const bkpt = miTuple(r.results?.bkpt)
    const number = miNumber(bkpt?.number)
    const addr = miString(bkpt?.addr)
    const locations = unwrapList(bkpt?.locations).length
    const units = Math.max(1, locations)
    if (number !== undefined) s.breakpoints.set(number, { kind: "break", location: params.at!, addr, units })
    const multi =
      locations > 1
        ? `\n⚠ this location resolved to ${locations} addresses (inlined or identical-code-folded) and therefore uses ${locations} hardware units.`
        : ""
    const shown = displayFrame(
      { file: miString(bkpt?.file), fullname: miString(bkpt?.fullname), line: miString(bkpt?.line) },
      cwd,
    )
    const where = shown.file && shown.line ? ` — ${shown.file}:${shown.line}` : ""
    return textResult(
      `${banner(cwd)}\nbreakpoint ${number ?? "?"} at ${addr ?? "?"}${where}${multi}\n${renderBreakpoints(s, core)}`,
      detailsOf("break"),
    )
  }

  async function exec(params: GdbInput, cwd: string, onUpdate: Update, signal: AbortSignal): Promise<GdbResult> {
    const s = requireSession("exec")
    requireLive(s)
    const op: ExecOp = params.op ?? "continue"
    const waitMs = clamp(params.waitMs, DEFAULT_WAIT_MS, 100, MAX_WAIT_MS)
    const onTimeout = params.onTimeout ?? "interrupt"
    const show = params.show ?? []
    // show 表达式在每次停止时都会被求值:`x=1` 这种会写目标,而且是每停一次写一次。
    const writing = show.filter((expr) => expressionWrites(expr))
    if (writing.length > 0) {
      throw new Error(
        `gdb exec refused show expressions that would WRITE the target (${writing.map((e) => `\`${e}\``).join(", ")}): show is read-only and is evaluated at every stop. Use eval with write: true for a deliberate write.`,
      )
    }

    // UI 心跳:continue 期间 MI 一个字节都不产生,卡片会空白几十秒,和挂死无法区分 —— 而那正是用户最可能按停止掐掉
    // 一个本该等下去的会话的时刻。
    let beats = 0
    const heartbeat = setInterval(() => {
      beats++
      const armed = [...s.breakpoints.values()].map((b) => b.location).join(", ") || "none"
      onUpdate(textResult(`running ${beats}s — waiting for a stop (breakpoints: ${armed})`, detailsOf("exec")))
    }, HEARTBEAT_MS)
    heartbeat.unref?.()

    try {
      if ((op === "interrupt" || op === "wait") && s.state === "halted") {
        // 对已经停住的目标发 -exec-interrupt,gdb 回 ^done 但永远不会来 *stopped —— 等下去就是一份假的
        // WFI / SWD 掉线诊断(审稿实测)。停着就是停着,把现状给出去。
        const text = `${banner(cwd)}\nthe target is already halted — nothing to ${op === "wait" ? "wait for" : "interrupt"}.\n${await renderStopReport(s, core, { show, relativeTo: cwd })}`
        return textResult(text, withLocation("exec"))
      }

      if (op === "interrupt") {
        const halted = await interruptTarget(s)
        const text = halted
          ? `${banner(cwd)}\n${await renderStopReport(s, core, { show, relativeTo: cwd })}`
          : `${banner(cwd)}\ninterrupt was sent but the target did not stop within ${INTERRUPT_GRACE_MS} ms — it may be asleep (WFI with the debug clock gated) or SWD lost sync.`
        return textResult(text, withLocation("exec"))
      }

      if (op === "reset-halt" || op === "reset-run") {
        const template = op === "reset-halt" ? caps().resetHalt : caps().resetRun
        if (!template) {
          throw new Error(
            `${serverKind} does not expose ${op} through gdb. ` +
              (serverKind === "qemu"
                ? "Restart the session instead — QEMU's monitor system_reset does not reliably reset a Cortex-M core."
                : "Use gdb eval with the server's own monitor command (write: true)."),
          )
        }
        const waiter = s.expectStop()
        const r = await s.console(template)
        const said = r.output.trim()
        // monitor 的失败不走 ^error:OpenOCD 把 "Error: timed out while waiting for target halted" 当普通文本吐在 ^done 下面。
        // 没复位成功就别宣布"复位了",更别把 epoch 往前推(那等于告诉模型旧地址全作废)。
        if (r.class === "error" || /\berror\b|\bfail|timed out/i.test(said)) {
          const text = `${banner(cwd)}\nthe reset may NOT have happened — the server said:\n${clip(said || (miString(r.results?.msg) ?? "(nothing)"), 800)}`
          return textResult(text, withLocation("exec"))
        }
        s.epoch += 1
        const stopped = op === "reset-halt" ? await settledWithin(waiter, INTERRUPT_GRACE_MS, signal) : false
        const afterReset =
          op === "reset-halt"
            ? stopped
              ? `\n${await renderStopReport(s, core, { show, relativeTo: cwd })}`
              : '\nno stop record came back after the reset — the previous stop report is stale; run gdb status or exec op:"interrupt" to resynchronise'
            : ""
        const text =
          `${banner(cwd)}\nsession epoch is now ${s.epoch} — the target was reset, so any address, register value or ` +
          `breakpoint hit count you cached before this line is stale.\n${clip(said, 800)}${afterReset}`
        return textResult(text, withLocation("exec"))
      }

      if (op === "wait") {
        const outcome = await resumeAndWait(s, undefined, waitMs, onTimeout, signal)
        if (outcome.aborted) throw new Error(`gdb exec wait was aborted: ${outcome.note}`)
        const text = outcome.stopped
          ? `${banner(cwd)}\n${outcome.note ? `${outcome.note}\n` : ""}${await reportAfterStop(s, cwd, show)}`
          : `${banner(cwd)}\n${outcome.note ?? `nothing stopped within ${waitMs} ms.`}`
        return textResult(text, withLocation("exec"))
      }

      if (op === "continue" && s.breakpoints.size === 0 && !params.expectRunning) {
        throw new Error(
          "no breakpoints or watchpoints are armed — continue would run until the timeout with nothing to stop it, " +
            "and the timeout would look like a hang even though the firmware is fine. " +
            'Set a breakpoint first (gdb break at:"..."), or pass expectRunning: true if you just want it running.',
        )
      }

      const command = MI_RESUME[op]!
      const count = op === "continue" || op === "finish" ? 1 : clamp(params.count, 1, 1, MAX_STEP_COUNT)

      // 单步循环:每步一行,最后给一份完整报告。十行两个观察表达式从"20 次往返 40k token"变成一次调用。
      const trail: string[] = []
      let outcome = await resumeAndWait(s, command, waitMs, onTimeout, signal)
      for (let i = 1; i < count && outcome.stopped && !outcome.aborted; i++) {
        const f = s.lastStop?.frame
        const shown = await Promise.all(
          show.map(async (e) => {
            const r = await s.send(`-data-evaluate-expression "${escapeCString(e)}"`).catch(() => undefined)
            return `${e}=${r?.class === "done" ? miString(r.results?.value) : "?"}`
          }),
        )
        trail.push(
          `${f?.file && f?.line ? `${shortenPath(f.file, cwd)}:${f.line}` : (f?.func ?? "?")}${shown.length ? ` ${shown.join(" ")}` : ""}`,
        )
        if (s.lastStop && s.lastStop.reason !== "end-stepping-range") break
        outcome = await resumeAndWait(s, command, waitMs, onTimeout, signal)
      }

      if (outcome.aborted) throw new Error(`gdb exec ${op} was aborted: ${outcome.note}`)
      if (outcome.error) return textResult(`${banner(cwd)}\n${outcome.error}`, detailsOf("exec"))
      const parts = [banner(cwd)]
      if (trail.length) parts.push(`steps: ${trail.join(" | ")}`)
      if (outcome.note) parts.push(outcome.note)
      parts.push(
        outcome.stopped ? await reportAfterStop(s, cwd, show) : `the target is still RUNNING after ${waitMs} ms.`,
      )
      return textResult(parts.join("\n"), withLocation("exec"))
    } finally {
      clearInterval(heartbeat)
    }
  }

  async function evalAction(params: GdbInput, cwd: string): Promise<GdbResult> {
    const s = requireSession("eval")
    if (!params.command) throw new Error('gdb eval needs command, e.g. command:"p/x *cfg" or command:"info registers"')
    const verdict = classifyEval(params.command)
    if (verdict.kind === "blocked") throw new Error(`gdb eval refused \`${params.command}\`: ${verdict.reason}`)
    if (verdict.kind === "reroute") {
      throw new Error(
        `\`${params.command}\` is run control — use gdb exec op:"${verdict.op}" instead. ` +
          "exec waits for the stop and returns the frames, source line and locals in the same call; " +
          "running it through eval would leave the tool's idea of the target state wrong.",
      )
    }
    if (verdict.kind === "mutating" && !params.write) {
      throw new Error(`gdb eval refused \`${params.command}\`: ${verdict.reason}`)
    }

    const r = await s.console(params.command)
    const failed = r.class === "error"
    const body = failed ? (miString(r.results?.msg) ?? "error") : r.output.trim() || "(no output)"
    let note = ""
    // `load` 把 ELF 经 gdb server 烧进去了:flash-state 要跟着走,否则下一次 start 会把它报成"镜像不符"。
    if (!failed && verdict.kind === "mutating" && /^\s*load\b/i.test(params.command)) {
      const arg = params.command.trim().split(/\s+/)[1]
      const loaded = arg ? resolveToCwd(cwd, arg) : elfPath
      if (loaded) {
        const recorded = await sha256File(loaded)
          .then((sha256) => writeFlashState(cwd, { elfPath: loaded, sha256, at: Date.now() }).then(() => true))
          .catch(() => false)
        if (recorded) note = `\nrecorded ${loaded} as the image on the target.`
      }
    }
    // 目标退出 / 掉线之后 gdb 照样答:答案来自 ELF 文件(.data 的初值、符号地址),不是片子。不标注的话模型会把
    // 一个"看起来像活的"值当成现场(审稿实测:退出后 `p g_iter` 读回 0,而退出前明明改成了 42)。
    const gone =
      s.state === "exited" || s.state === "connection-lost"
        ? `⚠ the target is gone (${s.state}): anything below comes from the ELF file, not the chip — run gdb stop, then gdb start.\n`
        : ""
    const text = `${banner(cwd)}\n${gone}${failed ? "gdb reported an error: " : ""}${clip(body, MAX_EVAL_CHARS)}${note}`
    return textResult(text, withLocation("eval"))
  }

  /** 不排队(见 execute):exec 等停止的那几十秒正是用户最想问"现在在哪"的时候。 */
  async function status(cwd: string): Promise<GdbResult> {
    if (starting) {
      return textResult("[gdb starting] a start is in progress — attaching to the target.", detailsOf("status"))
    }
    if (!session?.running) {
      return textResult('[gdb no session] nothing is attached. Run `gdb` action:"start".', detailsOf("status"))
    }
    const s = session
    const serverLine = !server
      ? `server: external (${connection})`
      : server.exited
        ? `server: ${serverKind} EXITED (${server.exited.signal ? `signal ${server.exited.signal}` : `code ${server.exited.code}`})${server.logFile ? ` — its output: ${server.logFile}` : ""}`
        : `server: ${serverKind} pid ${server.child.pid} on ${connection}${server.logFile ? `, log ${server.logFile}` : ""}`
    const where =
      s.state === "running"
        ? `the target is RUNNING — breakpoints armed: ${[...s.breakpoints.values()].map((b) => b.location).join(", ") || "none"}. Use exec op:"wait" to wait for a stop or op:"interrupt" to halt it.`
        : s.lastStop
          ? await reportAfterStop(s, cwd)
          : "no stop recorded yet"
    const lines = [
      banner(cwd),
      `elf: ${elfPath ?? "?"}`,
      core.core ? `core: ${core.core.name} ${core.core.revision}` : "core: unknown / not Cortex-M",
      renderBreakpoints(s, core),
      where,
      `session log: ${s.file}`,
      serverLine,
    ]
    return textResult(lines.filter(Boolean).join("\n"), withLocation("status"))
  }

  async function stop(params: GdbInput): Promise<GdbResult> {
    if (params.keepServer && serverKind === "jlink" && server && !server.exited) {
      throw new Error("J-Link uses single-run mode so disconnect can clean up hardware breakpoints; keepServer is not supported. Keep this session open, or use a separately managed server with connect for a manual handover.")
    }
    if (!session?.running) {
      // 会话可能已经死了(gdb 崩了)但 server 还在:一并收掉。
      const cleanup = await teardown(false)
      return textResult(`no gdb session was running.${cleanup}`, detailsOf("stop"))
    }
    const keep = params.keepServer === true && server !== undefined
    const probeNote =
      keep && PROBE_SERVERS.has(serverKind)
        ? "\nThe server still owns the debug probe (the lease stays with it): flash will be refused until you run gdb stop again without keepServer, or start a new session."
        : ""
    const handover =
      keep && connection && elfPath
        ? `\nThe server is still listening. To take over by hand:\n  ${gdbPathUsed ?? "gdb"} ${elfPath} -ex "target extended-remote ${connection}"${probeNote}`
        : ""
    const file = session.file
    const cleanup = await teardown(keep)
    return textResult(`gdb session closed.${handover}${cleanup}\nSession log: ${file}`, detailsOf("stop"))
  }

  async function run(
    params: GdbInput,
    cwd: string,
    onUpdate: Update,
    signal: AbortSignal | undefined,
  ): Promise<GdbResult> {
    const merged = abortOf(signal)
    // 这一轮已经被用户停掉(信号在排队期间就响了):碰目标的动作一个都别做。status / stop 无害。
    if (merged.aborted && params.action !== "status" && params.action !== "stop") {
      throw new Error(`gdb ${params.action} was aborted before it ran`)
    }
    switch (params.action) {
      case "start":
        starting = true
        try {
          return await start(params, cwd, merged)
        } finally {
          starting = false
        }
      case "break":
        return breakAction(params, cwd)
      case "exec":
        return exec(params, cwd, onUpdate, merged)
      case "eval":
        return evalAction(params, cwd)
      case "status":
        return status(cwd)
      case "stop":
        return stop(params)
    }
  }

  return {
    name: GDB_CONTRACT.name,
    label: GDB_CONTRACT.label,
    description: GDB_CONTRACT.description,
    parameters: GDB_CONTRACT.parameters,
    // 只是给人看的意图声明:AgentHarness 不读它,真正的串行在上面的 serialize 里。
    executionMode: "sequential",
    async dispose() {
      disposed = true
      closing.abort()
      // 排在队列里:在飞的动作(等停止的 exec 已被 closing 叫醒)先落地,再收 gdb / server / 探针。
      await serialize(() => teardown(false)).catch(() => undefined)
    },
    execute: (_toolCallId, params, onUpdate, toolContext, _invocation, context) => {
      // status 不排队:它只读闭包里的状态,发的 MI 命令由 GdbSession.send 自己串行;排进队列的话一次 30 秒的
      // continue 会把"现在在哪"这个最常问的问题堵到 30 秒之后(审稿实测)。
      if (params.action === "status") return run(params, toolContext.env.cwd, onUpdate, context.abortSignal)
      return serialize(() => {
        if (disposed && params.action !== "stop") throw new Error(`gdb ${params.action}: the session is closing`)
        return run(params, toolContext.env.cwd, onUpdate, context.abortSignal)
      })
    },
  }
}
