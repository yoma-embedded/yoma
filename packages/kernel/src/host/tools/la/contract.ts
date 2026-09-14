/**
 * la 工具的契约:菜单那一半。
 *
 * DSLogic 逻辑分析仪 —— 采集数字信号、跑协议解码器(I²C / SPI / UART / CAN …)、把总线上真正发生的事
 * 变成模型读得懂的事务。背后是 `engines/bin/yoma-la`(vendored DSView 的采集库 + 150 个解码器,用户
 * 不用装 DSView);语义(事务聚合、期望差分、时序统计、token 预算)全在 `host/domain/la`。
 *
 * 【为什么叫 la 不叫 logic】与 `log` 只差两个字母。模型选错工具是一个**不会报错**的失败模式:
 * 它会拿着串口日志回答"总线上发了什么",而两者都叫得出话来。
 *
 * 门规同 flash / log / toolchain:这个文件只许 import typebox 与工具目录内的相对路径。`EXPECT_SYNTAX`
 * 因此是字面量而不是 import 自 `domain/la/model.ts` —— 两处必须一致,tools-la.test.ts 拿常量比着钉住。
 */

import { type Static, Type } from "typebox"

import type { ToolContract } from "../contract-types.ts"

/** 与 domain/la/model.ts 的 EXPECT_SYNTAX 同值(见文件头:契约不许 import 那边)。 */
export const EXPECT_SYNTAX_TEXT =
  'one item per line, "#" comments, ".." = anything after. ' +
  'I²C: "W 0x51 00 A5" / "R 0x51 37 .." (7-bit address; each address phase is one line, Sr-separated phases on separate lines). ' +
  'UART: hex bytes "48 65 .." or a quoted string "Hello World". ' +
  'SPI: "MOSI 03 00 10" then "MISO FF FF .." (a MOSI+MISO pair is one transfer; either side may be omitted).'

export const LA_ACTIONS = [
  "devices",
  "capture",
  "arm",
  "collect",
  "stop",
  "import",
  "list",
  "decoders",
  "summary",
  "decode",
  "events",
  "timing",
  "expect",
] as const
export type LaAction = (typeof LA_ACTIONS)[number]

export const DEFAULT_SAMPLERATE = "20M"
export const DEFAULT_SAMPLES = "1M"
export const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000
export const DEFAULT_EVENT_LIMIT = 200
/** 超过这个采样数,decode 必须给窗口 —— 防线在生成端,不在截断端。 */
export const FULL_DECODE_MAX_SAMPLES = 32_000_000

const laParameters = Type.Object({
  // 显式元组而非 .map():数组会丢掉元组结构,Static 推导塌成 never。
  action: Type.Union(
    [
      Type.Literal("devices"),
      Type.Literal("capture"),
      Type.Literal("arm"),
      Type.Literal("collect"),
      Type.Literal("stop"),
      Type.Literal("import"),
      Type.Literal("list"),
      Type.Literal("decoders"),
      Type.Literal("summary"),
      Type.Literal("decode"),
      Type.Literal("events"),
      Type.Literal("timing"),
      Type.Literal("expect"),
    ],
    {
      description:
        "devices | capture | arm | collect | stop | import | list | decoders | summary | decode | events | timing | expect",
    },
  ),
  // ── 采集 ──
  channels: Type.Optional(
    Type.Array(Type.Object({ index: Type.Number(), name: Type.Optional(Type.String()) }), {
      description:
        'capture/arm: probe channels to record and their names, e.g. [{index:0,name:"SCL"},{index:1,name:"SDA"}]. Default: all.',
    }),
  ),
  samplerate: Type.Optional(
    Type.String({
      description: `capture/arm: "25M", "100M", "500k"… ≥ 5× the fastest signal. Default ${DEFAULT_SAMPLERATE}.`,
    }),
  ),
  samples: Type.Optional(
    Type.String({
      description: `capture/arm: samples per channel, decimal ("1M" = 1,000,000; default ${DEFAULT_SAMPLES}). Or give durationMs instead. Buffer mode is bounded by device memory (16M on DSLogic Plus at 16 channels).`,
    }),
  ),
  durationMs: Type.Optional(
    Type.Number({ description: "capture/arm: record for this long instead of giving samples." }),
  ),
  trigger: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'capture/arm: per channel index: "r" rising, "f" falling, "c" any edge, "0"/"1" level, "x" ignore — e.g. {"1":"f"}. Without a trigger recording starts immediately.',
    }),
  ),
  triggerPositionPct: Type.Optional(
    Type.Number({ description: "capture/arm: pre-trigger share of the buffer, 0–100 (default 10)." }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("buffer"), Type.Literal("stream")], {
      description:
        "capture/arm: buffer (default, up to 100 MHz × 16ch, bounded by device memory) or stream (continuous over USB, ≤ 20 MHz × 16ch).",
    }),
  ),
  vth: Type.Optional(
    Type.Number({
      description:
        "capture/arm: input threshold in volts (1.65 for 3.3 V logic, 0.9 for 1.8 V). Device default when omitted.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: `capture/arm: stop waiting for the trigger after this long (default ${DEFAULT_CAPTURE_TIMEOUT_MS}); what was captured is returned, flagged timed_out.`,
    }),
  ),
  device: Type.Optional(
    Type.String({
      description:
        'capture/arm: "auto" (first DSLogic, default), an index, or "demo" (built-in simulated signals, no hardware).',
    }),
  ),
  // ── 文件 / 选择 ──
  file: Type.Optional(
    Type.String({ description: "import: path of an existing .dsl (saved by DSView or copied from another machine)." }),
  ),
  capture: Type.Optional(
    Type.String({
      description: "summary/decode/events/timing/expect: capture id from list. Default: the most recent.",
    }),
  ),
  // ── 解码 ──
  decoders: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.String({ description: 'instance name you choose, e.g. "i2c0"' }),
        id: Type.String({
          description: 'decoder id from action=decoders, e.g. "1:i2c", "1:spi", "1:uart", "can", "modbus"',
        }),
        channels: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description: 'decoder channel → capture channel (index or name), e.g. {"scl":"SCL","sda":"SDA"}',
          }),
        ),
        options: Type.Optional(
          Type.Record(Type.String(), Type.String(), { description: 'decoder options, e.g. {"baudrate":"115200"}' }),
        ),
        on: Type.Optional(
          Type.String({
            description: "stack on another instance key (modbus on a uart instance) instead of raw channels",
          }),
        ),
      }),
      { description: "decode: decoder instances to run; they stay attached to the capture for events/expect." },
    ),
  ),
  decoder: Type.Optional(
    Type.String({
      description:
        "decoders: one decoder id for its full entry. events/expect: which instance key (default: the first).",
    }),
  ),
  // ── 查询 ──
  fromMs: Type.Optional(
    Type.Number({ description: "decode/events/timing/expect: window start, ms from capture start." }),
  ),
  toMs: Type.Optional(Type.Number({ description: "decode/events/timing: window end, ms." })),
  detail: Type.Optional(
    Type.Union([Type.Literal("txn"), Type.Literal("frame"), Type.Literal("bit")], {
      description:
        "events: txn (one line per transaction, default), frame (expand members), bit (include bit-level rows).",
    }),
  ),
  rows: Type.Optional(
    Type.Array(Type.String(), { description: "events: only these annotation rows (row ids from decode output)." }),
  ),
  search: Type.Optional(
    Type.String({ description: "events: keep only lines containing this text (case-insensitive), e.g. an address." }),
  ),
  limit: Type.Optional(Type.Number({ description: `events: max lines (default ${DEFAULT_EVENT_LIMIT}).` })),
  timingChannels: Type.Optional(
    Type.Array(Type.String(), { description: "timing: channels (index or name); default all." }),
  ),
  expect: Type.Optional(
    Type.String({ description: `expect: the traffic the firmware should have produced — ${EXPECT_SYNTAX_TEXT}` }),
  ),
})

export type LaInput = Static<typeof laParameters>

export interface LaDetails {
  action: LaAction
  captureId?: string
  /** 采集目录绝对路径(la.view RPC 用它打开同一份采集)。 */
  dir?: string
  file?: string
  samplerate?: number
  samples?: number
  durationMs?: number
  triggerPos?: number
  channels?: { index: number; name: string; edges?: number }[]
  /** 1024 列 × 每通道 2 bit(bit0 有高、bit1 有低),每通道一个 base64。 */
  preview?: { columns: number; from: number; to: number; rows: Record<string, string> }
  decoders?: { key: string; id: string; annotations: number }[]
  /** events / timing / decode 的查询窗口(采样号)。 */
  window?: { from: number; to: number }
  armed?: boolean
  timedOut?: boolean
  truncated?: boolean
  issues?: number
  device?: { model?: string; pid?: string; hdl?: number }
}

const LA_DESCRIPTION = `Logic analyzer (DreamSourceLab DSLogic): capture digital signals, decode bus protocols (I²C, SPI, UART, CAN, Modbus, 1-Wire, JTAG, SWD, USB — 150 DSView decoders bundled, no DSView install), and read the traffic as transactions.

Actions:
- devices: is a DSLogic attached, what can it do (samplerates, depth, threshold).
- capture / arm+collect: record. arm returns immediately so you can flash or reset the board, then collect — that is how you catch what happens right after reset. stop discards an armed capture.
- import (file): register a .dsl saved by DSView or copied from another machine; everything downstream is identical.
- list: captures in this project. summary: per-channel edge counts, idle level, shortest pulse — which wire is the clock, before you decode.
- decoders / decoders (decoder=id): the catalog, or one decoder's real channel and option names. Read it — DSView ids differ from upstream sigrok ("1:uart" is ONE wire; TX and RX are two instances).
- decode (decoders): attach decoder instances to a capture; they stay attached for events/expect.
- events: transactions with a time anchor per line. Narrow with fromMs/toMs, search, decoder; detail=frame expands one, detail=bit shows bit timing.
- expect: diff the capture against the traffic the firmware should have produced — MATCH or the first mismatch with its timestamp. Cheaper and more reliable than reading hundreds of frames.
- timing: pulse widths, period/frequency, duty, glitches per channel — no decoder needed.

Rules:
- Samples are a budget, not a goal: 1–4M samples at 5–10× the bus clock covers most bugs.
- Numbers in events are hex; I²C addresses are 7-bit.
- The full annotation list is always on disk in <project>/.yoma/la/<id>/ — when output is truncated, narrow the window, do not re-capture.
- A capture whose trigger did not fire, or that timed out, proves nothing about the bus. Check wiring, vth and the trigger condition before concluding anything.
- This is a separate USB instrument: it never holds the debug probe, so capturing while gdb or a flasher owns the probe is exactly the intended combination. It is exclusive with DSView — close it first.`

export const LA_CONTRACT = {
  name: "la",
  label: "逻辑分析仪",
  description: LA_DESCRIPTION,
  parameters: laParameters,
  guidelines: [
    "For bus/timing questions (is the MCU sending the right I²C/SPI/UART bytes? is the clock right?), capture with la and read la events / la expect instead of inferring from the source.",
    "Never state what a bus carried without a la capture line showing it; a capture whose trigger never fired proves nothing.",
  ],
  // 确认门:不设。这台设备只是**听**总线(采集不驱动任何引脚),也不碰调试探针 ——
  // 与 flash 那种会改写片子的动作不是一回事,每次都问只会让用户点到麻木。
  summary: laSummary,
} as const satisfies ToolContract<typeof laParameters>

/** 卡片副标题 / 确认条那一行。参数可能还在流式拼,缺什么就少说什么。 */
export function laSummary(input: Partial<LaInput>): string {
  const at = input.capture ? ` ${input.capture}` : ""
  switch (input.action) {
    case "capture":
    case "arm": {
      const rate = input.samplerate ?? DEFAULT_SAMPLERATE
      // 两个都给时 **samples 赢**(captureSpecOf 与引擎的 captureArgs 都是这个优先级)。
      // 这行反过来写的话,卡片上写着 500ms 而实际在采 2M 个点。
      const span = input.samples ?? (input.durationMs !== undefined ? `${input.durationMs}ms` : DEFAULT_SAMPLES)
      const trig =
        input.trigger && Object.keys(input.trigger).length > 0 ? ` trigger ${JSON.stringify(input.trigger)}` : ""
      return `${input.action} ${span} @ ${rate}${trig}`
    }
    case "decode":
      return `decode${at} ${(input.decoders ?? []).map((d) => `${d.key}=${d.id}`).join(" ")}`.trimEnd()
    case "events":
      return `events${at}${input.decoder ? ` ${input.decoder}` : ""}${input.search ? ` /${input.search}/` : ""}`
    case "expect":
      return `expect${at}${input.decoder ? ` ${input.decoder}` : ""}`
    case "import":
      return input.file ? `import ${input.file}` : "import"
    case "decoders":
      return input.decoder ? `decoders ${input.decoder}` : "decoders"
    case "devices":
    case "collect":
    case "stop":
    case "list":
      return input.action
    case "summary":
    case "timing":
      return `${input.action}${at}`
    default:
      return ""
  }
}
