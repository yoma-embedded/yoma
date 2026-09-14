/**
 * gdb 工具的契约:菜单那一半。
 *
 * 把一个活的调试会话接进 agent 循环:六个动作 start / break / exec / eval / status / stop。协议是 MI3,
 * 传输是 gdb 子进程 + 一个 gdb server(OpenOCD / J-Link / QEMU,或已经在听的任何一个)。解析、寄存器语义、
 * 渲染与 eval 闸门全在 `host/domain/gdb`;这个文件只说"收什么、给什么"。
 *
 * 门规同 flash / log / la:只许 import typebox 与工具目录内的相对路径。
 *
 * 【描述里不许写"会先问用户"】挂不挂确认钩子是宿主的事(只有桌面端传 confirmTools);写了对 bench 与信箱
 * 工位端就是假话。`confirm` 按效果判:改写目标的 eval、起探针程序的 start、复位目标的 exec 才问(见下面的注释)。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

export const GDB_ACTIONS = ["start", "break", "exec", "eval", "status", "stop"] as const
export type GdbAction = (typeof GDB_ACTIONS)[number]

export const EXEC_OPS = [
  "continue",
  "step",
  "next",
  "finish",
  "stepi",
  "interrupt",
  "wait",
  "reset-halt",
  "reset-run",
] as const
export type ExecOp = (typeof EXEC_OPS)[number]

export const GDB_SERVERS = ["qemu", "openocd", "jlink", "external"] as const
export type GdbServerKind = (typeof GDB_SERVERS)[number]

export const DEFAULT_WAIT_MS = 10_000
export const MAX_WAIT_MS = 120_000
/** exec 的 count 上限:再多就该写脚本了,而且返回值会撑爆预算。 */
export const MAX_STEP_COUNT = 20

const gdbParameters = Type.Object({
  // 显式元组而非 .map():数组会丢掉元组结构,Static 推导塌成 never。
  action: Type.Union(
    [
      Type.Literal("start"),
      Type.Literal("break"),
      Type.Literal("exec"),
      Type.Literal("eval"),
      Type.Literal("status"),
      Type.Literal("stop"),
    ],
    { description: "start | break | exec | eval | status | stop" },
  ),
  server: Type.Optional(
    Type.Union([Type.Literal("qemu"), Type.Literal("openocd"), Type.Literal("jlink"), Type.Literal("external")], {
      description:
        "start: which gdb server to launch. Use external together with connect to attach to one already running.",
    }),
  ),
  connect: Type.Optional(
    Type.String({ description: 'start: "host:port" of an already-running gdb server (implies server: "external").' }),
  ),
  elfPath: Type.Optional(
    Type.String({ description: "start: the ELF with debug info that matches what is on the target." }),
  ),
  chip: Type.Optional(Type.String({ description: 'start (jlink): -device name, e.g. "STM32G431CB".' })),
  config: Type.Optional(
    Type.Array(Type.String(), {
      description: 'start (openocd): -f config files, e.g. ["interface/stlink.cfg","target/stm32g4x.cfg"].',
    }),
  ),
  machine: Type.Optional(
    Type.String({ description: 'start (qemu): -machine, e.g. "netduinoplus2" (STM32F405, Cortex-M4F).' }),
  ),
  // 多探针选择刻意不做:openocd 用 config 里的 `adapter serial`,jlink 要接 `-select USB=<sn>`,
  // 语义按 server 各表 —— 需要时在各自的配置里表达,不给一个跨 server 的假统一参数。
  gdbPath: Type.Optional(
    Type.String({
      description: "start: gdb binary to use; defaults to arm-none-eabi-gdb on PATH (by ELF architecture).",
    }),
  ),
  allowUnverified: Type.Optional(
    Type.Boolean({ description: "start: proceed even when the ELF does not match the last flashed image." }),
  ),
  at: Type.Optional(Type.String({ description: 'break: code location — "file.c:42", "func", or "*0x08001a3e".' })),
  watch: Type.Optional(Type.String({ description: "break: watch this expression instead (data watchpoint)." })),
  mode: Type.Optional(
    Type.Union([Type.Literal("r"), Type.Literal("w"), Type.Literal("rw")], {
      description: "break + watch: read / write / both. Default w.",
    }),
  ),
  condition: Type.Optional(Type.String({ description: "break: only stop when this expression is true." })),
  temporary: Type.Optional(Type.Boolean({ description: "break: delete the breakpoint after it is hit once." })),
  remove: Type.Optional(Type.String({ description: 'break: delete breakpoint N, or "all".' })),
  // 同上:显式元组,别改成 .map()。
  op: Type.Optional(
    Type.Union(
      [
        Type.Literal("continue"),
        Type.Literal("step"),
        Type.Literal("next"),
        Type.Literal("finish"),
        Type.Literal("stepi"),
        Type.Literal("interrupt"),
        Type.Literal("wait"),
        Type.Literal("reset-halt"),
        Type.Literal("reset-run"),
      ],
      {
        description:
          "exec: continue | step | next | finish | stepi | interrupt | wait | reset-halt | reset-run. wait resumes nothing and keeps waiting for the next stop.",
      },
    ),
  ),
  waitMs: Type.Optional(
    Type.Number({ description: `exec: how long to wait for a stop (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}).` }),
  ),
  onTimeout: Type.Optional(
    Type.Union([Type.Literal("interrupt"), Type.Literal("leave-running")], {
      description:
        "exec: what to do if nothing stops in time. Default interrupt — a halted target is recoverable, a silently running one is not.",
    }),
  ),
  expectRunning: Type.Optional(
    Type.Boolean({
      description: "exec continue: acknowledge that no breakpoint is armed and you just want the target running.",
    }),
  ),
  show: Type.Optional(
    Type.Array(Type.String(), {
      description: "exec: read-only expressions to evaluate at the stop and append to the report.",
    }),
  ),
  count: Type.Optional(
    Type.Number({ description: `exec step/next/stepi: repeat this many times (max ${MAX_STEP_COUNT}).` }),
  ),
  command: Type.Optional(
    Type.String({
      description: 'eval: a gdb command or expression, e.g. "p/x *cfg", "info registers", "x/16xw 0x20000000".',
    }),
  ),
  write: Type.Optional(
    Type.Boolean({
      description:
        "eval: required for commands that change the target (set variable, monitor, call, jump, load, assignments inside expressions).",
    }),
  ),
  keepServer: Type.Optional(
    Type.Boolean({
      description: "stop: leave the gdb server running so a human can attach; the tool prints the command line.",
    }),
  ),
})

export type GdbInput = Static<typeof gdbParameters>

export type GdbTargetState = "halted" | "running" | "exited" | "connection-lost"

export interface GdbDetails {
  action: GdbAction
  state: GdbTargetState | "no-session"
  /** 复位 / 重连都 +1:跨 epoch 之后缓存的地址与断点号一律作废。 */
  epoch: number
  /** 这次会话里第几次停止。 */
  stopId: number
  connection?: string
  /** 解码后的会话转录(模型可以 grep)。 */
  file?: string
  /** 停在有源码的位置时给编辑器用;文件在本机不存在时**不填**,否则每次停止都让编辑器去开一个不存在的文件。 */
  path?: string
  line?: number
}

const GDB_DESCRIPTION = `Drives a live GDB session against embedded firmware — breakpoints, run control, expression evaluation, and automatic fault analysis. Works with OpenOCD, J-Link, QEMU, or any gdb server already listening on a port.

Actions:
- start (elfPath + either server+its options, or connect): attach. Launches the server when asked, waits until its gdb port is really listening, loads symbols, and reports the core, the hardware breakpoint budget when the target reports one, and whether the ELF matches the last image flashed by the flash tool. Calling start on a live session is safe — it just reports the session's state; if the target has exited or the connection dropped, start tears the old session down and attaches afresh.
- exec (op, [waitMs], [onTimeout], [show], [count]): run control. THIS IS THE MAIN ACTION. It resumes AND waits for the stop, then returns one compact report: stop reason, top frames, source line, frame-0 locals, plus any show expressions. When the target stops inside a fault handler it also decodes CFSR/HFSR, picks MSP vs PSP from EXC_RETURN, and reports the PC that actually faulted rather than the handler's own.
- break ([at] | [watch], [condition], [temporary], [remove]): breakpoints and watchpoints. Returns the resolved address so an unresolved breakpoint is visible immediately, and — when the target reports its FPB/DWT budget — refuses to exceed it at insert time; otherwise gdb's own reply decides.
- eval (command, [write]): any other gdb command or expression. Read-only by default; commands that change the target (set variable, monitor, call, jump, load, assignments inside an expression) need write: true.
- status: where the target is, the last stop, the breakpoint table and budgets, and the session log path.
- stop ([keepServer]): end the session and release the probe.

Rules:
- Prefer one exec over several eval calls: exec already returns the stop reason, frames, source line and locals.
- A halted target produces no log output. Silence in the log tool after a stop is expected, not evidence of a crash.
- Hardware breakpoints are a small fixed budget (6 on a typical Cortex-M4, 4 on M0+); break reports how many remain when the budget is known. Delete before adding.
- A debug probe can only be held by one process: the gdb server owns it while attached. RTT is read from the server's own TCP port (the start report says where), so logs and gdb coexist — but stop the session before running a flash command, or the probe lease will refuse it and point back here.
- Never state that a line executed, a variable held a value, or a fault occurred at a given place unless a stop report here shows it. When the report says the build is optimized, do not present locals as fact.`

export const GDB_CONTRACT = {
  name: "gdb",
  label: "调试器",
  description: GDB_DESCRIPTION,
  parameters: gdbParameters,
  // 门按效果判,不按动作名判(与 bash / powershell / log 的探针门同一条规矩):eval + write:true 会改目标
  // (内存 / 寄存器 / flash);start 起 openocd / JLinkGDBServer 是 bash 里同一条命令会被问的那个程序;
  // exec reset-* 发的正是 eval 要 write:true 才肯发的 `monitor reset`。qemu / external 的 start、断点、单步、
  // 只读 eval 不问 —— 每次都问只会让用户点到麻木。
  confirm: (input: GdbInput) =>
    (input.action === "eval" && input.write === true) ||
    (input.action === "start" && (input.server === "openocd" || input.server === "jlink")) ||
    (input.action === "exec" && (input.op === "reset-halt" || input.op === "reset-run")),
  guidelines: [
    "Prefer one `gdb exec` over several `gdb eval`: exec returns the stop reason, frames, source line and locals in a single call.",
    "Never claim a line executed, a variable held a value, or a fault happened at a place unless a gdb stop report shows it; when the report says the build is optimized, do not report locals as fact.",
    "Hardware breakpoints are a small fixed budget and a halted target produces no log output — check `gdb status` before concluding the firmware hung or went silent.",
  ],
  summary: gdbSummary,
} as const satisfies ToolContract<typeof gdbParameters>

/** 卡片副标题 / 确认条那一行。参数可能还在流式拼,缺什么就少说什么。 */
export function gdbSummary(input: Partial<GdbInput>): string {
  switch (input.action) {
    case "start": {
      const via = input.connect ? `connect ${input.connect}` : (input.server ?? "")
      return ["start", via, input.elfPath ?? ""].filter(Boolean).join(" ")
    }
    case "break": {
      if (input.remove) return `break remove ${input.remove}`
      if (input.watch) return `break watch ${input.watch}${input.mode ? ` (${input.mode})` : ""}`
      if (input.at) return `break at ${input.at}${input.condition ? ` if ${input.condition}` : ""}`
      return "break"
    }
    case "exec": {
      const count = input.count !== undefined && input.count > 1 ? ` ×${input.count}` : ""
      return `exec ${input.op ?? "continue"}${count}`
    }
    case "eval":
      return `eval ${input.command ?? ""}${input.write ? " (write)" : ""}`.trimEnd()
    case "status":
    case "stop":
      return input.action
    default:
      return ""
  }
}
