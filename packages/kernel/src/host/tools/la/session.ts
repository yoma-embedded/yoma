/**
 * la 工具的厨房那一半:13 个动作 → `domain/la` 与 `engines/bin/yoma-la`。
 *
 * 纪律(从 attic/tools/la.ts 原样带过来,每一条都有来历):
 * - **一次采集一个子进程**:引擎那边的采集库是全局单例 + 单活动设备,进程边界就是免费的清理。
 * - **arm / collect 分开**:核心用例是"先武装,再 flash 复位板子,然后看抓到了什么"。arm 立刻返回,
 *   在飞的采集登记进 `armedSet`,`killOnHostExit` 保证宿主退出时带走它们。
 * - **不占探针租约**:DSLogic 是独立 USB 设备,"gdb 握着 ST-Link 同时抓总线"正是要支持的组合。
 *   设备自身的互斥(DSView 开着、另一个 la 进程)由引擎打不开设备时的人话兜住。
 * - **details 只放摘要 + 1024 列预览**:它进会话 JSONL、开会话时整批重传、不可回收。原始样本留在
 *   `<cwd>/.yoma/la/<id>/`,缓存与布局在 `domain/la/store.ts`,与 kernel 的 `la.view` RPC 同一份。
 * - **位级行默认折叠、events 默认 200 行、超 32M 采样的 decode 必须给窗口** —— 防线在生成端不在截断端。
 *
 * 两处与 attic 版不同:
 * 1. cwd **每次 execute 现取**(`toolContext.env.cwd`),不在工厂期定死 —— 与 flash / log 同一条教训。
 * 2. 这个工具有状态(armed 的那一次采集活在闭包里),而发动机的 AgentHarness **不读 `executionMode`**,
 *    同一批里的调用是并行的:两条 `arm` 能同时通过 "已经武装了吗" 的检查、各起一个子进程,而引擎的
 *    采集库是单例。所以这里用一条 promise 队列把自己的调用串起来(同 log)。
 */

import { copyFile, mkdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { executionEnvSnapshot } from "../../domain/execution-env.ts"

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import {
  capEngineOutput,
  clamp,
  engineBin,
  killOnHostExit,
  stamp,
  type EnginePathOptions,
} from "../../domain/engines.ts"
import { fmtFreq, fmtTime, toSeconds, type AnnotationSet } from "../../domain/la/annotations.ts"
import { channelStats, columnBits, lowerBound, type ChannelStats, type DslChannel } from "../../domain/la/dsl.ts"
import {
  laCapture,
  laDecode,
  laDecoders,
  laDevices,
  type CaptureSpec,
  type LaCaptureReport,
} from "../../domain/la/engine.ts"
import { EXPECT_SYNTAX, expectDiff, renderEvents, summarize, type Detail } from "../../domain/la/model.ts"
import {
  captureStore,
  CAPTURE_DSL,
  CAPTURE_JSON,
  DECODE_JSON,
  DECODE_NDJSON,
  LA_DIR,
  type CaptureStore,
  type LaCaptureMeta,
  type OpenedCapture,
} from "../../domain/la/store.ts"
import { resolveToCwd } from "../../domain/paths.ts"
import {
  DEFAULT_CAPTURE_TIMEOUT_MS,
  DEFAULT_EVENT_LIMIT,
  FULL_DECODE_MAX_SAMPLES,
  LA_CONTRACT,
  type LaAction,
  type LaDetails,
  type LaInput,
} from "./contract.ts"
import { captureSpecOf, pulseStats, windowOf } from "./stats.ts"

const PREVIEW_COLUMNS = 1024

/**
 * 引擎在不在。**不在不是「装坏了」**:yoma-la 要 cmake + pkg-config + glib + libusb(Windows 上是 MSYS2)
 * 才编得出来,构建脚本探不到工具链时会明确跳过它、其余引擎照常出货。所以 engineBin 那句通用的
 * 「重装 Yoma / 跑 engines:build」在这里是误导 —— 用户重装一百次也不会多出这个文件。
 *
 * 而且这个工具**少了引擎还有一半能用**:别人存的 .dsl 照样 import / summary / timing / events
 * (那几个动作只读文件)。话术要把这半条路指出来,否则模型会以为逻辑分析仪整个不存在。
 */
function requireEngine(enginesDir: string | undefined, action: LaAction): void {
  try {
    engineBin("yoma-la", { enginesDir })
  } catch {
    throw new Error(
      `la ${action}: this build has no logic-analyzer engine (yoma-la is an optional engine and was not built for this platform). ` +
        "Capturing and decoding need it. Reading an existing capture does not: la import <file.dsl>, then la summary / la timing / la events still work.",
    )
  }
}

/** 与 flash 同一个本地小助手:存在性是预检,读不到就当不存在(目录、没权限都算)。 */
async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

export interface LaToolOptions extends EnginePathOptions {
  /** 测试隔离用;生产走进程内唯一的 captureStore(与 kernel 的 la.view 同一份)。 */
  store?: CaptureStore
}

/** 比装配面的工具多一个收尾口:会话关掉时,武装着的那次采集要放开 USB 设备。 */
export type LaTool = AgentHarnessTool<ExecutionToolContext, typeof LA_CONTRACT.parameters, LaDetails> & {
  dispose(): Promise<void>
}

interface ArmedCapture {
  id: string
  dir: string
  controller: AbortController
  promise: Promise<LaCaptureReport>
  spec: CaptureSpec
  killNow(): void
}

/** 在飞的采集(跨所有工具实例):宿主退出要带走它们。killOnHostExit 只认 Set,所以它就是唯一的登记处。 */
const armedSet = new Set<ArmedCapture>()

/** 两个中止信号合一;只有一个就原样用。 */
function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b
}

/** 会动 armed 状态的四个动作要互斥;其余九个只读文件,不该跟在一次采集后面干等。 */
const STATEFUL_ACTIONS: ReadonlySet<LaAction> = new Set<LaAction>(["capture", "arm", "collect", "stop"])

type LaResult = { content: [{ type: "text"; text: string }]; details: LaDetails }

function textResult(text: string, details: LaDetails): LaResult {
  return { content: [{ type: "text", text }], details }
}

export function createLaTool(options: LaToolOptions = {}): LaTool {
  const store = options.store ?? captureStore
  let lastCaptureId: string | undefined
  /** 本工具实例(= 本会话)武装的那一个;armedSet 里可能还有别的会话的。 */
  let armed: ArmedCapture | undefined
  /**
   * 本工具实例起过、**还没结束**的采集子进程。`armed` 不够用:collect 一开始就把 armed 清掉了,
   * 而它随后要 await 那个子进程(缺省 30 秒,timeoutMs 能到一小时)—— 那段时间里子进程还攥着
   * DSLogic,却谁都够不着它:dispose 看不见、killOnHostExit 也不认。审稿实测 dispose 1 ms 就返回,
   * 采集子进程 2 秒后才自己跑完(而 runEngine 是 detached,宿主这时退出就直接成了孤儿)。
   */
  const owned = new Set<ArmedCapture>()
  let disposed = false

  // 发动机忽略 executionMode,同一批调用并行 —— 有状态的工具必须自己排队(见文件头)。
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    // then(task, task):前一次失败也要接着跑下一次,否则一次报错永久堵死这个工具。
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 登记一次在飞采集;它自己结束时(成功或失败)把自己从两个登记处摘掉。 */
  function register(entry: ArmedCapture): ArmedCapture {
    owned.add(entry)
    armedSet.add(entry)
    killOnHostExit(armedSet, { yieldToHost: true })
    // then(release, release) 同时也是那个"没人 await 时别变成 unhandledRejection"的保险:
    // arm 起的采集在 collect 之前没有任何人 await 它,失败会直接打死内核进程。
    const release = () => {
      owned.delete(entry)
      armedSet.delete(entry)
    }
    entry.promise.then(release, release)
    return entry
  }

  const engineCtx = (cwd: string, signal: AbortSignal | undefined, env: NodeJS.ProcessEnv) => ({
    enginesDir: options.enginesDir,
    cwd,
    signal,
    env,
  })
  const rootOf = (cwd: string) => path.join(cwd, LA_DIR)

  async function registerCapture(
    id: string,
    dir: string,
    source: LaCaptureMeta["source"],
    report?: LaCaptureReport,
  ): Promise<{ meta: LaCaptureMeta; cap: OpenedCapture }> {
    const cap = await store.open(dir)
    const header = cap.dsl.header
    const meta: LaCaptureMeta = {
      id,
      dir,
      samplerate: header.samplerate,
      samples: header.totalSamples,
      durationMs: toSeconds(header.totalSamples, header.samplerate) * 1e3,
      channels: header.channels.map((channel) => ({ index: channel.index, name: channel.name })),
      triggerPos: report?.trigger.fired ? report.trigger.pos : header.triggerPos,
      source,
      createdAt: Date.now(),
      decoded: [],
    }
    const { dir: _dir, decoded: _decoded, ...persisted } = meta
    await writeFile(path.join(dir, CAPTURE_JSON), `${JSON.stringify(persisted, null, "\t")}\n`)
    lastCaptureId = id
    return { meta, cap }
  }

  async function requireCapture(
    cwd: string,
    id: string | undefined,
    action: LaAction,
  ): Promise<{ meta: LaCaptureMeta; cap: OpenedCapture }> {
    const all = await store.list(cwd)
    const pick = id ?? lastCaptureId ?? all[0]?.id
    if (!pick) throw new Error(`la ${action}: no capture yet — run la capture (or la import a .dsl) first`)
    const meta = all.find((candidate) => candidate.id === pick)
    if (!meta) throw new Error(`la ${action}: no capture named ${pick} (la list shows them)`)
    return { meta, cap: await store.open(meta.dir) }
  }

  async function requireAnnotations(cap: OpenedCapture, id: string, action: LaAction): Promise<AnnotationSet> {
    const set = await cap.annotations()
    if (!set) throw new Error(`la ${action}: capture ${id} is not decoded yet — run la decode with decoders=[…] first`)
    return set
  }

  function previewOf(cap: OpenedCapture): LaDetails["preview"] {
    const total = cap.dsl.header.totalSamples
    const rows: Record<string, string> = {}
    for (const channel of cap.dsl.header.channels) {
      rows[String(channel.index)] = Buffer.from(
        columnBits(cap.edges(channel.index), 0, total, PREVIEW_COLUMNS),
      ).toString("base64")
    }
    return { columns: PREVIEW_COLUMNS, from: 0, to: total, rows }
  }

  function baseDetails(action: LaAction, meta?: LaCaptureMeta): LaDetails {
    if (!meta) return { action }
    return {
      action,
      captureId: meta.id,
      dir: meta.dir,
      file: path.join(meta.dir, CAPTURE_DSL),
      samplerate: meta.samplerate,
      samples: meta.samples,
      durationMs: meta.durationMs,
      triggerPos: meta.triggerPos,
      channels: meta.channels,
    }
  }

  /**
   * 采集报告 → 人话。**每一条警告都要说出口**:超时没触发、USB 溢出、设备报的数据错 —— 这三样都
   * 会让一份看起来正常的采集其实什么都不证明,而模型只看样本数是分辨不出来的。
   */
  function describeReport(id: string, report: LaCaptureReport & { stderr?: string }): string {
    const device = report.device?.model ? `${report.device.model} (PID ${report.device.pid})` : report.mode
    const lines = [
      `capture ${id}: ${report.ok ? "done" : "INCOMPLETE"} — ${report.samples.toLocaleString()} samples @ ${fmtFreq(report.samplerate)} = ${fmtTime(report.duration_ms / 1e3)} on ${device}, ${report.mode} mode`,
      `channels: ${report.channels.map((channel) => `D${channel.index}=${channel.name}`).join(" ")}`,
    ]
    if (report.trigger.enabled) {
      lines.push(
        `trigger: ${report.trigger.fired ? `fired at sample ${report.trigger.pos} (${fmtTime(toSeconds(report.trigger.pos, report.samplerate))})` : "DID NOT FIRE"}`,
      )
    }
    if (report.timed_out) {
      lines.push(
        `⚠ timed out waiting (${(report.elapsed_ms / 1e3).toFixed(1)} s)${report.samples ? " — kept what was captured" : " — nothing captured"}. If a trigger was set, the edge never came: check wiring, vth, and that the event happens inside the wait.`,
      )
    }
    if (report.overflow)
      lines.push("⚠ USB overflow: stream mode could not keep up — lower the samplerate or use buffer mode.")
    if (report.data_error) lines.push(`⚠ data error ${report.data_error} reported by the device`)
    if (report.stderr) lines.push(report.stderr)
    if (report.file) lines.push(`file: ${report.file}`)
    return lines.join("\n")
  }

  async function finishCapture(
    action: LaAction,
    id: string,
    dir: string,
    report: LaCaptureReport,
    source: LaCaptureMeta["source"],
  ): Promise<LaResult> {
    if (!report.file || report.samples === 0) {
      return textResult(describeReport(id, report), {
        action,
        captureId: id,
        dir,
        timedOut: report.timed_out,
        samples: 0,
      })
    }
    const { meta, cap } = await registerCapture(id, dir, source, report)
    const details = baseDetails(action, meta)
    details.timedOut = report.timed_out
    details.preview = previewOf(cap)
    details.device = { model: report.device?.model, pid: report.device?.pid, hdl: report.device?.hdl_version }
    return textResult(
      `${describeReport(id, report)}\nnext: la summary (what is on each wire), then la decode.`,
      details,
    )
  }

  async function beginCapture(cwd: string, params: LaInput): Promise<{ id: string; dir: string; spec: CaptureSpec }> {
    const spec = captureSpecOf(params)
    const id = `la-${stamp()}`
    const dir = path.join(rootOf(cwd), id)
    await mkdir(dir, { recursive: true })
    return { id, dir, spec }
  }

  async function run(
    params: LaInput,
    cwd: string,
    signal: AbortSignal | undefined,
    env: NodeJS.ProcessEnv,
  ): Promise<LaResult> {
    const action = params.action
    switch (action) {
      case "devices": {
        requireEngine(options.enginesDir, action)
        const found = await laDevices(engineCtx(cwd, signal, env))
        if (found.count === 0) {
          return textResult(
            'No DSLogic found. Is it plugged in? On Windows it shows up as "USB-based DSL Instrument v2" (WinUSB, no driver install needed). If DSView is open, close it — it holds the device. Try the tool without hardware with device="demo".',
            { action },
          )
        }
        const lines = found.devices.map((device, index) => {
          if (device.error) return `#${index} ${device.name}: ${device.error}`
          const modes = (device.channel_modes ?? [])
            .map((mode) => `${mode.stream ? "stream" : "buffer"} ${mode.channels}ch ≤${fmtFreq(mode.max_samplerate)}`)
            .join(", ")
          const hdl =
            device.hdl_version !== undefined
              ? ` · FPGA HDL v${device.hdl_version}${device.hdl_expected !== undefined && device.hdl_version !== device.hdl_expected ? ` (engine expects v${device.hdl_expected} — mismatch!)` : ""}`
              : ""
          return [
            `#${index} ${device.model ?? device.name} — PID ${device.pid}${hdl}`,
            `   ${device.channels} channels, depth ${((device.depth_per_channel ?? 0) / 1e6).toFixed(1)}M samples/channel (buffer), features: ${(device.features ?? []).join(", ")}`,
            `   samplerates: ${(device.samplerates ?? []).map(fmtFreq).join(" ")}`,
            `   modes: ${modes}`,
            `   vth: ${device.vth ?? "?"} V (set vth=1.65 for 3.3 V logic if signals look dead)`,
          ].join("\n")
        })
        return textResult(lines.join("\n"), {
          action,
          device: { model: found.devices[0]?.model, pid: found.devices[0]?.pid, hdl: found.devices[0]?.hdl_version },
        })
      }

      case "capture": {
        requireEngine(options.enginesDir, action)
        if (armed)
          throw new Error(`la capture: a capture is already armed (${armed.id}) — la collect or la stop it first`)
        const { id, dir, spec } = await beginCapture(cwd, params)
        // 一次性的 capture 也进登记处:它同样攥着设备,而 dispose 与宿主退出不经过这条 await。
        const controller = new AbortController()
        const entry = register({
          id,
          dir,
          controller,
          spec,
          promise: laCapture(engineCtx(cwd, mergeSignals(signal, controller.signal), env), spec, dir, "capture"),
          killNow: () => controller.abort(),
        })
        const report = await entry.promise
        return finishCapture(action, id, dir, report, spec.device === "demo" ? "demo" : "capture")
      }

      case "arm": {
        requireEngine(options.enginesDir, action)
        if (armed) throw new Error(`la arm: already armed (${armed.id}) — la collect or la stop first`)
        const { id, dir, spec } = await beginCapture(cwd, params)
        const controller = new AbortController()
        // arm **故意活过这一轮**(武装 → 烧录复位板子 → collect 正是它存在的理由),所以这里不接
        // context.abortSignal:接了的话这一轮一结束采集就没了。能收走它的是 stop / dispose / 宿主退出。
        armed = register({
          id,
          dir,
          controller,
          spec,
          promise: laCapture(engineCtx(cwd, controller.signal, env), spec, dir, "capture"),
          killNow: () => controller.abort(),
        })
        const waiting =
          spec.trigger && Object.keys(spec.trigger).length > 0
            ? `waiting for trigger ${JSON.stringify(spec.trigger)} (up to ${((spec.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS) / 1e3).toFixed(0)} s)`
            : "recording immediately (no trigger)"
        return textResult(`armed ${id}: ${waiting}. Now do the thing (flash/reset/poke the board), then la collect.`, {
          action,
          captureId: id,
          dir,
          armed: true,
        })
      }

      case "collect":
      case "stop": {
        if (!armed) {
          if (action === "stop") return textResult("la stop: nothing armed", { action })
          throw new Error("la collect: nothing armed — la arm first")
        }
        const pending = armed
        armed = undefined
        // **不在这里摘登记**:摘了之后 await 期间那个子进程谁都够不着(见 owned 的注释)。
        // 它自己结束时会把自己摘掉(register 里的 release)。
        if (action === "stop") {
          pending.controller.abort()
          await pending.promise.catch(() => undefined)
          return textResult(`stopped ${pending.id} (discarded)`, { action, captureId: pending.id })
        }
        // 用户按"停止"要能打断这次等待:采集是 arm 起的,它的 controller 在 pending 身上,而这一轮的
        // abortSignal 与那个子进程本来毫无关系 —— 不接的话,一个永远不触发的触发条件 + timeoutMs=1h
        // 会把这个工具钉住一小时,而停止按钮没有任何反应。
        const cancel = () => pending.controller.abort()
        signal?.addEventListener("abort", cancel, { once: true })
        let report: LaCaptureReport
        try {
          report = await pending.promise
        } catch (error) {
          throw new Error(
            `la collect: the armed capture failed — ${error instanceof Error ? error.message : String(error)}`,
          )
        } finally {
          signal?.removeEventListener("abort", cancel)
        }
        return finishCapture(
          action,
          pending.id,
          pending.dir,
          report,
          pending.spec.device === "demo" ? "demo" : "capture",
        )
      }

      case "import": {
        if (!params.file) throw new Error("la import requires file — the .dsl to register")
        const source = resolveToCwd(cwd, params.file)
        if (!(await fileExists(source))) throw new Error(`la import: ${source} not found`)
        const id = `la-${stamp()}-import`
        const dir = path.join(rootOf(cwd), id)
        await mkdir(dir, { recursive: true })
        await copyFile(source, path.join(dir, CAPTURE_DSL))
        const { meta, cap } = await registerCapture(id, dir, "import")
        const details = baseDetails(action, meta)
        details.preview = previewOf(cap)
        return textResult(
          `imported ${id}: ${meta.samples.toLocaleString()} samples @ ${fmtFreq(meta.samplerate)} = ${fmtTime(meta.durationMs / 1e3)}, channels ${meta.channels.map((channel) => `D${channel.index}=${channel.name}`).join(" ")}\nnext: la summary, then la decode.`,
          details,
        )
      }

      case "list": {
        const root = rootOf(cwd)
        const all = await store.list(cwd)
        if (all.length === 0) {
          return textResult(
            `no captures yet in ${root} — la capture, or la import a .dsl. (la decoders lists the decoder catalog.)`,
            { action },
          )
        }
        const rows = all.map(
          (meta) =>
            `${meta.id}${meta.id === lastCaptureId ? " *" : ""}  ${meta.samples.toLocaleString()} samples @ ${fmtFreq(meta.samplerate)} (${fmtTime(meta.durationMs / 1e3)})  ${meta.channels.length} ch  ${meta.source}${meta.decoded.length ? `  decoded: ${meta.decoded.join(",")}` : ""}`,
        )
        return textResult(
          `${rows.length} captures in ${root}:\n${rows.join("\n")}${armed ? `\narmed: ${armed.id}` : ""}`,
          {
            action,
          },
        )
      }

      case "decoders": {
        requireEngine(options.enginesDir, action)
        if (params.decoder) {
          const catalog = await laDecoders(engineCtx(cwd, signal, env), [params.decoder])
          const one = catalog.decoders[0]
          if (!one) throw new Error(`la decoders: no decoder named ${params.decoder} (la decoders lists them)`)
          const text = [
            `${one.id} — ${one.longname}: ${one.desc}`,
            `channels: ${one.channels.map((channel) => `${channel.id} (${channel.desc})`).join(", ") || "none"}`,
            `optional: ${one.opt_channels.map((channel) => `${channel.id} (${channel.desc})`).join(", ") || "none"}`,
            `options: ${one.options.map((option) => `${option.id}=${JSON.stringify(option.default)}${option.values.length ? ` ∈ {${option.values.map((value) => JSON.stringify(value)).join(",")}}` : ""} — ${option.desc}`).join("\n         ") || "none"}`,
            `rows: ${one.rows.map((row) => `${row.id}[${row.classes.map((cls) => one.classes[cls]?.id ?? cls).join(",")}]`).join(" ")}`,
            `inputs: ${one.inputs.join(",") || "logic"}  outputs: ${one.outputs.join(",") || "-"}`,
          ].join("\n")
          return textResult(text, { action })
        }
        const catalog = await laDecoders(engineCtx(cwd, signal, env))
        const lines = [...catalog.decoders]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((decoder) => {
            const channels = [
              ...decoder.channels.map((channel) => channel.id),
              ...decoder.opt_channels.map((channel) => `[${channel.id}]`),
            ].join(",")
            const opts = decoder.options.map((option) => `${option.id}=${JSON.stringify(option.default)}`).join(" ")
            const stack =
              decoder.inputs.length > 0 && !decoder.inputs.includes("logic")
                ? ` (stacks on ${decoder.inputs.join("/")})`
                : ""
            return `${decoder.id.padEnd(18)} ${decoder.name.padEnd(16)} ch:${channels || "-"}${opts ? `  opts: ${opts}` : ""}${stack}`
          })
        const text = capEngineOutput(
          `${catalog.decoders.length} decoders (channels; [optional]; option=default). la decoders decoder=<id> for one in full.\n${lines.join("\n")}`,
          "Ask for one decoder with decoder=<id>.",
        )
        return textResult(text, { action })
      }

      case "summary": {
        const { meta, cap } = await requireCapture(cwd, params.capture, action)
        const rate = meta.samplerate
        const stats: ChannelStats[] = cap.dsl.header.channels.map((channel) =>
          channelStats(channel, cap.edges(channel.index)),
        )
        const active = stats.filter((stat) => stat.edges > 0)
        const lines = [
          `${meta.id}: ${meta.samples.toLocaleString()} samples @ ${fmtFreq(rate)} = ${fmtTime(meta.durationMs / 1e3)}${meta.triggerPos !== undefined ? `, trigger at ${fmtTime(toSeconds(meta.triggerPos, rate))}` : ""}`,
        ]
        for (const stat of stats) {
          if (stat.edges === 0) {
            lines.push(`  D${stat.index} ${stat.name.padEnd(10)} idle ${stat.idle ? "HIGH" : "LOW"} (no edges)`)
            continue
          }
          const span = (stat.lastEdge ?? 0) - (stat.firstEdge ?? 0)
          const estimate = span > 0 ? fmtFreq(stat.edges / 2 / toSeconds(span, rate)) : "-"
          lines.push(
            `  D${stat.index} ${stat.name.padEnd(10)} ${String(stat.edges).padStart(7)} edges  active ${fmtTime(toSeconds(stat.firstEdge ?? 0, rate))}..${fmtTime(toSeconds(stat.lastEdge ?? 0, rate))}  min pulse ${fmtTime(toSeconds(stat.minPulse ?? 0, rate))}  duty ${(stat.dutyHigh * 100).toFixed(0)}%  ~${estimate} toggles`,
          )
        }
        lines.push(...summaryHints(cap, active, rate))
        lines.push(
          'next: la decode with decoders=[{key,id,channels}] — e.g. id "1:i2c" (scl,sda), "1:spi" (clk,[miso],[mosi],[cs]), "1:uart" (rxtx). la decoders for the catalog.',
        )
        const details = baseDetails(action, meta)
        details.channels = stats.map((stat) => ({ index: stat.index, name: stat.name, edges: stat.edges }))
        details.preview = previewOf(cap)
        return textResult(lines.join("\n"), details)
      }

      case "decode": {
        const { meta, cap } = await requireCapture(cwd, params.capture, action)
        if (!params.decoders?.length) {
          throw new Error(
            'la decode requires decoders, e.g. [{key:"i2c0", id:"1:i2c", channels:{scl:"SCL", sda:"SDA"}}]',
          )
        }
        const window =
          params.fromMs !== undefined || params.toMs !== undefined
            ? windowOf(meta, params.fromMs, params.toMs)
            : undefined
        if (!window && meta.samples > FULL_DECODE_MAX_SAMPLES) {
          throw new Error(
            `la decode: ${meta.samples.toLocaleString()} samples is a lot to decode at once — give fromMs/toMs (the capture spans 0..${fmtTime(meta.durationMs / 1e3)}); la summary shows where the activity is`,
          )
        }
        const pds = params.decoders.map((decoder) => {
          if (!/^[A-Za-z_][\w-]*$/.test(decoder.key)) {
            throw new Error(`la decode: key "${decoder.key}" — use a short identifier like i2c0`)
          }
          const parts = [`${decoder.key}=${decoder.id}`]
          for (const [pin, ref] of Object.entries(decoder.channels ?? {})) {
            const channel = cap.dsl.findChannel(ref)
            if (!channel) {
              throw new Error(
                `la decode: ${decoder.key}.${pin}="${ref}" — no such channel in this capture (have: ${meta.channels.map((c) => `D${c.index}=${c.name}`).join(" ")})`,
              )
            }
            parts.push(`${pin}=${channel.index}`)
          }
          for (const [option, value] of Object.entries(decoder.options ?? {})) parts.push(`${option}=${value}`)
          if (decoder.on) parts.push(`on=${decoder.on}`)
          return parts.join(":")
        })
        requireEngine(options.enginesDir, action)
        const outFile = path.join(meta.dir, DECODE_NDJSON)
        const report = await laDecode(
          engineCtx(cwd, signal, env),
          { input: path.join(meta.dir, CAPTURE_DSL), pds, from: window?.from, to: window?.to },
          outFile,
        )
        await writeFile(
          path.join(meta.dir, DECODE_JSON),
          `${JSON.stringify({ pds, file: DECODE_NDJSON, window: window ?? null, at: Date.now() }, null, "\t")}\n`,
        )
        store.invalidate(meta.dir)
        const set = await requireAnnotations(cap, meta.id, action)
        const per = set.meta.decoders.map((decoder) => ({
          key: decoder.key,
          id: decoder.id,
          annotations: (set.byKey.get(decoder.key) ?? []).length,
          summary: summarize(set, decoder.key, { from: window?.from, to: window?.to }),
        }))
        const lines = [
          `decoded ${meta.id}${window ? ` window ${fmtTime(toSeconds(window.from, set.meta.samplerate))}..${fmtTime(toSeconds(window.to, set.meta.samplerate))}` : ""}: ${report.annotations} annotations in ${report.elapsed_ms} ms`,
          ...per.map((entry) => `  ${entry.key} (${entry.id}): ${entry.summary}`),
        ]
        if (report.warnings) lines.push(report.warnings)
        lines.push("next: la events (decoder=<key>) or la expect.")
        const details = baseDetails(action, meta)
        details.decoders = per.map((entry) => ({ key: entry.key, id: entry.id, annotations: entry.annotations }))
        if (window) details.window = window
        return textResult(lines.join("\n"), details)
      }

      case "events": {
        const { meta, cap } = await requireCapture(cwd, params.capture, action)
        const set = await requireAnnotations(cap, meta.id, action)
        const key = params.decoder ?? set.meta.decoders[0]?.key
        if (!key) throw new Error("la events: no decoder instances in this capture's decode")
        const window = windowOf(meta, params.fromMs, params.toMs)
        const limit = clamp(params.limit, DEFAULT_EVENT_LIMIT, 1, 5000)
        const rendered = renderEvents(set, key, {
          from: window.from,
          to: window.to,
          detail: (params.detail as Detail | undefined) ?? "txn",
          rows: params.rows,
          search: params.search,
          limit,
        })
        const decoder = set.meta.decoders.find((entry) => entry.key === key)
        if (!decoder)
          throw new Error(
            `la events: no decoder instance named ${key} (decoded: ${set.meta.decoders.map((d) => d.key).join(", ")})`,
          )
        const head = `# la events ${meta.id}  sr=${fmtFreq(set.meta.samplerate)}  n=${set.meta.total_samples}${set.meta.trigger_pos !== null && set.meta.trigger_pos !== undefined ? `  trig@${set.meta.trigger_pos}` : ""}`
        const foot = `${rendered.summary}.${rendered.truncated ? ` Showing ${limit} of ${rendered.total} — narrow with fromMs/toMs, search, or rows; the full list is in ${path.join(meta.dir, DECODE_NDJSON)}.` : ""}${(params.detail ?? "txn") === "txn" ? " detail=frame expands members." : ""}`
        const full = [head, ...rendered.lines, foot].join("\n")
        const text = capEngineOutput(full, "Narrow the window (fromMs/toMs), use search, or lower limit.")
        const details = baseDetails(action, meta)
        details.window = window
        details.truncated = rendered.truncated || text.length < full.length
        details.decoders = [{ key, id: decoder.id, annotations: (set.byKey.get(key) ?? []).length }]
        return textResult(text, details)
      }

      case "timing": {
        const { meta, cap } = await requireCapture(cwd, params.capture, action)
        const rate = meta.samplerate
        const window = windowOf(meta, params.fromMs, params.toMs)
        const channels: DslChannel[] = params.timingChannels?.length
          ? params.timingChannels.map((ref) => {
              const channel = cap.dsl.findChannel(ref)
              if (!channel) throw new Error(`la timing: no channel "${ref}"`)
              return channel
            })
          : cap.dsl.header.channels
        const at = (samples: number) => fmtTime(toSeconds(samples, rate))
        const lines = [
          `# la timing ${meta.id}  window ${at(window.from)}..${at(window.to)}  sr=${fmtFreq(rate)} (resolution ${fmtTime(1 / rate)})`,
        ]
        for (const channel of channels) {
          const list = cap.edges(channel.index)
          const first = lowerBound(list.edges, window.from)
          const edges = list.edges.subarray(first, lowerBound(list.edges, window.to))
          if (edges.length < 2) {
            lines.push(`D${channel.index} ${channel.name.padEnd(10)} ${edges.length} edge(s) in window`)
            continue
          }
          const { high, low, period, glitches } = pulseStats(edges, ((list.initial + first + 1) & 1) as 0 | 1)
          lines.push(
            `D${channel.index} ${channel.name.padEnd(10)} ${edges.length} edges` +
              (high ? `  high ${at(high.median)} (min ${at(high.min)} max ${at(high.max)})` : "") +
              (low ? `  low ${at(low.median)} (min ${at(low.min)} max ${at(low.max)})` : "") +
              (period
                ? `  period ${at(period.median)} = ${fmtFreq(rate / period.median)} (min ${at(period.min)} max ${at(period.max)})`
                : "") +
              (high && low ? `  duty ${((high.mean / (high.mean + low.mean)) * 100).toFixed(1)}%` : "") +
              (glitches ? `  ⚠ ${glitches} pulses ≤ 2 samples (glitch or under-sampled)` : ""),
          )
        }
        const details = baseDetails(action, meta)
        details.window = window
        return textResult(capEngineOutput(lines.join("\n"), "Pick fewer channels with timingChannels."), details)
      }

      case "expect": {
        const { meta, cap } = await requireCapture(cwd, params.capture, action)
        if (!params.expect?.trim()) throw new Error(`la expect requires expect — ${EXPECT_SYNTAX}`)
        const set = await requireAnnotations(cap, meta.id, action)
        const key = params.decoder ?? set.meta.decoders[0]?.key
        if (!key) throw new Error("la expect: no decoder instances")
        const from = params.fromMs !== undefined ? windowOf(meta, params.fromMs, undefined).from : undefined
        const result = expectDiff(set, key, params.expect, { from })
        const details = baseDetails(action, meta)
        details.issues = result.ok ? 0 : 1
        return textResult(`la expect ${meta.id} ${key}: ${result.message}`, details)
      }

      default: {
        const never: never = action
        throw new Error(`la: unknown action ${String(never)}`)
      }
    }
  }

  return {
    name: LA_CONTRACT.name,
    label: LA_CONTRACT.label,
    description: LA_CONTRACT.description,
    parameters: LA_CONTRACT.parameters,
    // replay 不声明(默认 never):采集碰真实硬件,崩溃恢复不该自动重跑。
    execute: async (_toolCallId, params, _onUpdate, toolContext, _invocation, context) => {
      const cwd = toolContext.env.cwd
      const env = executionEnvSnapshot(toolContext.env)
      const signal = context.abortSignal
      /**
       * 闸门放在**队列里面**:放在外面的话,排在一次采集后面的 arm 会在 dispose 之后照跑,起一个
       * 谁也收不走的子进程(审稿实测两个采集子进程活过了 dispose)。已经按停止的这一轮也一样,
       * 不拦的话它照样真的去开设备。
       */
      const guarded = async (): Promise<LaResult> => {
        if (disposed) throw new Error(`la ${params.action}: this session is closing`)
        if (signal?.aborted) throw new Error(`la ${params.action} was aborted`)
        return run(params, cwd, signal, env)
      }
      // 只有会动 armed 状态的四个动作排队。其余九个只读文件,跟在一次采集后面干等是纯亏:
      // 实测 la list 在一次 1.2 秒的采集后面等了 1.7 秒,生产里那就是整个触发超时(缺省 30 秒)。
      return STATEFUL_ACTIONS.has(params.action) ? serialize(guarded) : guarded()
    },
    /**
     * 会话关掉:**这个工具起过的每一个还没结束的采集**都要收走,不然 DSLogic 被占到内核退出。
     * 不能只看 `armed` —— collect 一开始就把它清掉了,而那个子进程还在跑(见 owned)。
     * 最后还要等队列排空:闸门在队列里面,排着的活儿会各自抛出去,但 dispose 得等它们真的抛完,
     * 不然 dispose 返回之后还可能有子进程被起来。
     */
    dispose: async () => {
      disposed = true
      armed = undefined
      const running = [...owned]
      owned.clear()
      for (const entry of running) {
        armedSet.delete(entry)
        entry.controller.abort()
      }
      await Promise.all(running.map((entry) => entry.promise.catch(() => undefined)))
      await queue.catch(() => undefined)
    },
  }
}

/**
 * "哪根线像时钟、哪根像 UART" —— 提示而非判断。
 *
 * 给的是线索不是结论:说死了模型就不去解码验证了,而这里的判据(边沿多 + 周期规整)对分频时钟、
 * 突发传输都会误判。
 */
function summaryHints(cap: OpenedCapture, active: ChannelStats[], rate: number): string[] {
  const clocks: string[] = []
  for (const stat of [...active].sort((a, b) => b.edges - a.edges).slice(0, 6)) {
    const list = cap.edges(stat.index)
    const periods: number[] = []
    for (let i = 2; i < list.edges.length && periods.length < 2000; i += 2)
      periods.push(list.edges[i]! - list.edges[i - 2]!)
    if (periods.length < 8) continue
    const median = [...periods].sort((a, b) => a - b)[periods.length >> 1]!
    const regular = periods.filter((period) => Math.abs(period - median) <= median * 0.1).length / periods.length
    if (regular > 0.6 && stat.edges >= 32) clocks.push(`D${stat.index} (${fmtFreq(rate / median)})`)
  }
  const hints: string[] = []
  if (clocks.length > 0) {
    hints.push(
      `clock-like: ${clocks.join(", ")} — the data line of that bus is the one that toggles with it (I²C scl/sda, SPI clk/mosi/miso)`,
    )
  }
  const uartish = active.filter(
    (stat) =>
      stat.idle === 1 &&
      stat.edges >= 20 &&
      stat.dutyHigh > 0.5 &&
      !clocks.some((clock) => clock.startsWith(`D${stat.index} `)),
  )
  if (uartish.length > 0) {
    hints.push(`idle-high with bursts (UART-like candidates): ${uartish.map((stat) => `D${stat.index}`).join(", ")}`)
  }
  if (active.length === 0) {
    hints.push(
      "no channel toggles at all — check probe ground, vth (threshold), and that the bus is actually running during the capture window",
    )
  }
  return hints.length > 0 ? [`hints: ${hints.join("; ")}`] : []
}
