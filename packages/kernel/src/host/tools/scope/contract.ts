import { type Static, Type } from "typebox"
import type { ToolContract } from "../contract-types.ts"

export const SCOPE_ACTIONS = [
  "devices",
  "connect",
  "status",
  "setup",
  "capture",
  "arm",
  "collect",
  "measure",
  "samples",
  "list",
  "screenshot",
  "stop",
  "disconnect",
] as const
export type ScopeAction = (typeof SCOPE_ACTIONS)[number]
export const MAX_SCOPE_POINTS = 2_000_000

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("devices"),
    Type.Literal("connect"),
    Type.Literal("status"),
    Type.Literal("setup"),
    Type.Literal("capture"),
    Type.Literal("arm"),
    Type.Literal("collect"),
    Type.Literal("measure"),
    Type.Literal("samples"),
    Type.Literal("list"),
    Type.Literal("screenshot"),
    Type.Literal("stop"),
    Type.Literal("disconnect"),
  ]),
  address: Type.Optional(
    Type.String({
      description:
        'Instrument address: "usb" / "usb:<serial>" (USBTMC) or "<ip>[:5025]" (LAN), optionally prefixed with a driver name ("siglent@usb:<serial>"); a bare address auto-detects the driver from *IDN?. Omit after connect. With multiple instruments always select a serial.',
    }),
  ),
  channels: Type.Optional(
    Type.Array(
      Type.Object({
        ch: Type.Integer({ minimum: 1, maximum: 4 }),
        on: Type.Optional(Type.Boolean()),
        vdiv: Type.Optional(
          Type.Number({
            exclusiveMinimum: 0,
            description:
              "Displayed channel units/div (V/div or A/div), including the instrument's configured probe factor.",
          }),
        ),
        offset: Type.Optional(Type.Number()),
        unit: Type.Optional(
          Type.Union([Type.Literal("V"), Type.Literal("A")], {
            description:
              "Displayed channel unit. Configure unit and probe factor only from confirmed physical probe sensitivity; e.g. a confirmed 1 V/A current probe uses unit=A and probe=1. Changing the unit alone does not calibrate an unknown probe.",
          }),
        ),
        coupling: Type.Optional(Type.Union([Type.Literal("DC"), Type.Literal("AC"), Type.Literal("GND")])),
        probe: Type.Optional(
          Type.Number({
            exclusiveMinimum: 0,
            description:
              "Instrument probe scaling factor. For voltage probes confirm the physical attenuation switch; for current probes confirm the model/range and sensitivity (V/A or mV/A). Bandwidth (e.g. 30 MHz) is not a multiplier. Initially preserve the instrument's actual setting until calibration is confirmed.",
          }),
        ),
        bwlimit: Type.Optional(Type.Union([Type.Literal("FULL"), Type.Literal("20M")])),
        label: Type.Optional(Type.String()),
      }),
      {
        minItems: 1,
        maxItems: 4,
        description: "setup/arm: channel settings. capture: channel numbers only; default enabled channels.",
      },
    ),
  ),
  timebase: Type.Optional(
    Type.Object({ scale: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), delay: Type.Optional(Type.Number()) }),
  ),
  trigger: Type.Optional(
    Type.Object({
      type: Type.Optional(
        Type.String({
          description: "Trigger type from capabilities.triggerTypes; default edge (the only type today).",
        }),
      ),
      mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("normal")])),
      source: Type.Optional(Type.String({ description: "C1..C4 or LINE. Enable the source channel first." })),
      level: Type.Optional(
        Type.Number({ description: "Threshold in the trigger source channel's displayed unit (V or A)." }),
      ),
      slope: Type.Optional(Type.Union([Type.Literal("rising"), Type.Literal("falling"), Type.Literal("alternate")])),
    }),
  ),
  mdepth: Type.Optional(
    Type.String({
      description:
        "Acquisition memory depth, e.g. 10k, 100k, 1M; legal values depend on the model and how many channels are on (capabilities.memoryDepths from connect/status). For exact captures choose at most 2M points/channel.",
    }),
  ),
  run: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("stop")])),
  autoset: Type.Optional(Type.Boolean()),
  quality: Type.Optional(
    Type.Union([Type.Literal("exact"), Type.Literal("overview")], {
      description:
        "capture/arm: exact (default) retains every acquired sample. overview explicitly decimates and cannot rule out glitches.",
    }),
  ),
  points: Type.Optional(
    Type.Integer({
      minimum: 16,
      maximum: MAX_SCOPE_POINTS,
      description:
        "Per-channel storage budget: exact defaults to 2M, overview defaults to 4000. Exact refuses records exceeding this budget; lower mdepth first.",
    }),
  ),
  stride: Type.Optional(
    Type.Integer({ minimum: 1, description: "overview only: retain every Nth sample. exact only permits stride=1." }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("current"), Type.Literal("single")], {
      description: "capture: freeze current record (default) or arm and wait for one trigger.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 100,
      maximum: 3_600_000,
      description: "Trigger wait, default 30000 ms. collect timeout leaves the instrument armed for retry.",
    }),
  ),
  resume: Type.Optional(
    Type.Boolean({
      description: "capture/collect: resume only if acquisition was running before the operation (default true).",
    }),
  ),
  plot: Type.Optional(
    Type.Boolean({ description: "Include a small text plot (default false); the front end has the saved waveform." }),
  ),
  screenshot: Type.Optional(
    Type.Boolean({
      description:
        "capture/collect: save a screenshot of the frozen record alongside samples (default true). Screenshot failure is reported without discarding waveform evidence.",
    }),
  ),
  items: Type.Optional(
    Type.Array(Type.Object({ type: Type.String(), source: Type.String() }), {
      minItems: 1,
      maxItems: 12,
      description: 'measure: e.g. [{type:"FREQ",source:"C1"},{type:"PKPK",source:"C1"}].',
    }),
  ),
  repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  intervalMs: Type.Optional(Type.Integer({ minimum: 20, maximum: 10000 })),
  capture: Type.Optional(
    Type.String({ description: "samples: capture id from list, default most recent in this project." }),
  ),
  channel: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
  fromUs: Type.Optional(Type.Number({ description: "samples window start, microseconds relative to trigger." })),
  toUs: Type.Optional(Type.Number({ description: "samples window end, microseconds relative to trigger." })),
  every: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  edges: Type.Optional(Type.Boolean()),
  threshold: Type.Optional(
    Type.Number({ description: "samples edges: crossing value in the stored channel's unit (V or A)." }),
  ),
})
export type ScopeInput = Static<typeof parameters>

export interface ScopeChannelDetails {
  ch: number
  on?: boolean
  label?: string
  vdiv?: number
  offset?: number
  coupling?: string
  probe?: number
  unit?: string
  bwlimit?: string
  points?: number
  interval?: number
  stats?: {
    min: number
    max: number
    pp: number
    mean: number
    rms: number
    /** RMS with the DC component removed (ripple / noise). */
    acRms?: number
    /** Histogram-mode settled levels; absent when the signal has no two settled levels (sine, ramp, noise). */
    top?: number
    base?: number
    overshoot?: number
    undershoot?: number
    freq?: number
    period?: number
    /** Ratio 0..1 (instrument DUTY measurements are in percent). */
    duty?: number
    rise?: number
    fall?: number
    edges?: number
    /** Samples within 1% of the ADC rails; when present, min/max are bounds, not readings. */
    clipped?: { low: number; high: number }
  }
  /** Unit of every stats field, so the agent never guesses seconds vs samples or ratio vs percent. */
  units?: Record<string, string>
}

/**
 * What the connected instrument can be set to right now. Mirrors `ScopeCapabilities` in
 * host/domain/scope/driver.ts (this menu file cannot import the tool room); session.ts assigns one to the other,
 * so a drift between the two fails typecheck. Lists depend on current state (memory depth shrinks with enabled
 * channels); an empty list means unknown or unsupported, not an error.
 */
export interface ScopeCapabilities {
  driver: string
  model: string
  /** True only for models yoma has exercised on hardware. */
  verified: boolean
  channels: number
  enabledChannels: number
  units: string[]
  couplings: string[]
  bwlimits: string[]
  probes: number[]
  /** True when the instrument also accepts probe factors outside `probes` (custom current probes, shunts). */
  customProbe: boolean
  timebase: { min: number; max: number; steps: string }
  triggerTypes: string[]
  triggerSources: string[]
  triggerSlopes: string[]
  triggerModes: string[]
  memoryDepths: string[]
  sampleRates: number[]
  measureTypes: string[]
  externalTrigger: boolean
  screenshot: boolean
  measurements: boolean
}

export interface ScopeDetails {
  action: ScopeAction
  address?: string
  /** Registry name of the driver behind this instrument. */
  driver?: string
  /** Driver warnings (unverified model, demo instrument); repeated on every result while connected. */
  warnings?: string[]
  /** connect/status only: legal values for the current state. */
  capabilities?: ScopeCapabilities
  /** devices only. */
  devices?: { serial?: string; product?: string; vendorId?: number }[]
  drivers?: {
    name: string
    description: string
    models: { model: string; transports: string[]; example: string; verified: string; note?: string }[]
  }[]
  model?: string
  serial?: string
  firmware?: string
  captureId?: string
  /** Project directory, distinct from the capture directory in dir. */
  directory?: string
  dir?: string
  file?: string
  sampleRate?: number
  interval?: number
  points?: number
  quality?: "exact" | "overview"
  stride?: number
  mdepth?: string
  timebase?: { scale: number; delay: number }
  trigger?: { mode?: string; source?: string; level?: number; slope?: string; status?: string }
  channels?: ScopeChannelDetails[]
  measurements?: {
    type: string
    source: string
    value: number | null
    unit?: string
    n?: number
    min?: number
    max?: number
    mean?: number
  }[]
  armed?: boolean
  timedOut?: boolean
  truncated?: boolean
  bytes?: number
}

export const SCOPE_CONTRACT = {
  name: "scope",
  label: "示波器",
  parameters,
  description: `Bench oscilloscope over USBTMC or LAN (drivers: Siglent SDS ':' command tree, verified on the SDS824X HD): capture analog waveforms, measure channel levels/timing with confirmed probe scaling, and read screenshots.
devices lists USB instruments plus the driver catalog with example addresses; connect selects one (auto-detects the driver from *IDN?, or use driver@address) and remembers its address; status reads current settings. Both return capabilities: the legal couplings, probes, trigger sources, memory depths and sample rates for the current channel configuration, and warnings such as an unverified model.
setup applies channels/timebase/trigger/mdepth and reports actual readback and mismatches. Use arm (optional settings), perform the flash/reset/physical action, then collect to capture a transient. collect timeout keeps waiting; stop discards the armed operation. disconnect releases the instrument for another session or application.
capture defaults to exact (stride=1), max 2M points per channel; it refuses a larger record, so lower mdepth before capture. quality=overview intentionally decimates: useful for shape, unable to prove absence of a glitch. mode=current freezes the existing record; mode=single waits for a new trigger.
All samples and acquisition settings are saved under .yoma/scope/<id>. list and samples read this evidence offline, with time relative to trigger. measure uses the instrument's own measurements; screenshot attaches a PNG. Raw samples never enter the conversation history; use a bounded samples window instead.
Only one session owns an instrument at a time. An armed acquisition retains ownership until collect/stop/disconnect. USB cancellation or communication failure drops the connection; reconnect before retrying.`,
  guidelines: [
    "For analog evidence use scope capture/measure. First state the measurement point, channel, wiring or clamp position, and physical probe attenuation/sensitivity, ask the human to perform/confirm those physical actions, and wait for their reply. USB cannot verify the actual wiring, clamp orientation or probe range.",
    "Read back setup and report mismatches before interpreting measurements. For voltage probes, attenuation must match the physical probe switch or voltages are wrong.",
    "For current probes confirm model, selected range/sensitivity (V/A or mV/A), zeroing and clamp orientation. Preserve the reported channel unit and existing probe factor initially; bandwidth is not a scaling factor. If the instrument reports V, report displayed voltage; derive current only after accounting for the instrument probe factor and confirmed sensitivity, applying each exactly once. Unit A alone does not calibrate an unknown probe.",
    "Arm before triggering the board event, then collect. A timed-out trigger or an overview with decimated samples cannot establish that a transient/glitch is absent. Cite the saved capture and time window supporting the conclusion.",
    "Capture frequency/period/duty are threshold-crossing estimates with a consistency check, not proof of periodicity. Missing estimates mean insufficient or irregular crossings, not zero frequency. Inspect the waveform and compare instrument measurements before attributing a physical cause to ripple or noise.",
    "Propose only values listed in capabilities (memory depths, couplings, trigger sources, measurement types; probes too unless customProbe is true); re-read status after enabling or disabling channels because legal depths change with the channel count. Treat driver warnings (unverified model, demo instrument) as 'readbacks are the only source of truth'. A capture whose stats report clipped samples gives bounds, not peak readings: raise vdiv and capture again.",
  ],
  summary(input: Partial<ScopeInput>): string {
    if (!input.action) return ""
    if (input.action === "capture" || input.action === "arm")
      return `${input.action} ${input.quality ?? "exact"}${input.channels ? ` ${input.channels.map((c) => `C${c.ch}`).join(",")}` : ""}`
    return `${input.action}${input.capture ? ` ${input.capture}` : ""}${input.address ? ` ${input.address}` : ""}`
  },
} as const satisfies ToolContract<typeof parameters>
