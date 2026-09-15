import { writeFakeExe } from "./fixtures/fake-exe.ts"
/**
 * la 工具(host/tools/la/{contract,stats,session}.ts)的验收。
 *
 * 【这台机器上没有真引擎】`engines/bin/yoma-la` 要 cmake + pkg-config + glib-2.0 + libusb-1.0 +
 * python3-embed 才编得出来(Windows 上是 MSYS2 ucrt64),开发机上常常没有。所以这里用**假引擎**:
 * 一段 JS,按子命令吐 canned JSON,capture 时把仓里的 demo 波形拷成 capture.dsl —— 于是
 * "采集 → 解析 .dsl → 统计 → 渲染" 这一整条链路是真的在跑,只有"碰 USB 设备"那一步是假的。
 * 假引擎还会把自己收到的 argv 写下来,让"参数拼对了吗"成为可断言的东西(通道名 → 通道号拼错了
 * 不会报错,只会解出一片垃圾)。
 *
 * 真引擎那一侧(真设备枚举、真解码器目录、真采集)不在这里,也没有别处 —— 如实记录,不假装测到了。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { EXPECT_SYNTAX } from "../src/host/domain/la/model.ts"
import { CaptureStore } from "../src/host/domain/la/store.ts"
import {
  EXPECT_SYNTAX_TEXT,
  LA_ACTIONS,
  LA_CONTRACT,
  type LaDetails,
  type LaInput,
} from "../src/host/tools/la/contract.ts"
import { confirmNeeded } from "../src/host/tools/contracts.ts"
import { createLaTool, type LaTool } from "../src/host/tools/la/session.ts"
import { captureSpecOf, pulseStats, windowOf } from "../src/host/tools/la/stats.ts"

const REPO = join(import.meta.dirname, "..", "..", "..")
const DEMO = join(REPO, "engines", "logic-analyzer", "vendor", "demo", "logic", "protocol.demo")
const HAS_DEMO = existsSync(DEMO)

let projectDir: string
let enginesDir: string
let argvLog: string
const tools: LaTool[] = []

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "yoma-la-project-"))
  enginesDir = mkdtempSync(join(tmpdir(), "yoma-la-engines-"))
  argvLog = join(enginesDir, "argv.log")
})

afterEach(async () => {
  // 武装着的采集会攥着子进程:先收工具,再删目录。
  while (tools.length > 0) await tools.pop()!.dispose()
  rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  rmSync(enginesDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

/**
 * 假 yoma-la。engineBin 找的是 `<enginesDir>/bin/yoma-la`(Windows 上是原生 .exe),所以照
 * test/fixtures/fake-exe.ts 那套写:一段 .mjs + 一个启动器。
 */
/** 采集跑到底时留下的标记文件(每轮一个临时目录)。 */
function finishedMarker(): string {
  return join(enginesDir, "finished")
}

function installFakeEngine(body: string): void {
  body = body.split("@FINISHED@").join(finishedMarker().split("\\").join("\\\\"))
  writeFakeExe(join(enginesDir, "bin"), "yoma-la", body)
}

/** 记 argv + 按子命令分支的假引擎骨架。 */
function fakeEngine(handlers: Record<string, string>): void {
  // 分支体可能是异步的(慢采集要等定时器),所以**不能**在它后面补 process.exit(0) ——
  // 那会在定时器开火之前就把进程杀掉,而症状是引擎"退出码 0 但没有输出"。
  const branches = Object.entries(handlers)
    .map(([name, body]) => `  if (sub === ${JSON.stringify(name)}) { ${body} } else`)
    .join("\n")
  installFakeEngine(`import { appendFileSync, copyFileSync, writeFileSync } from "node:fs"
const argv = process.argv.slice(2)
const sub = argv[0]
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n")
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const all = (name) => argv.flatMap((v, i) => (v === name ? [argv[i + 1]] : []))
${branches}
{
  process.stderr.write("yoma-la: unknown subcommand " + sub + "\\n")
  process.exit(2)
}
`)
}

/** arm 不 await 子进程,所以断言 argv 之前要等它真的起来(轮询而不是睡死一个固定值)。 */
async function waitForCall(sub: string, timeoutMs = 3000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = argvCalls().find((argv) => argv[0] === sub)
    if (hit) return hit
    if (Date.now() > deadline) throw new Error(`假引擎一直没收到 ${sub}(收到的是 ${JSON.stringify(argvCalls())})`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function argvCalls(): string[][] {
  if (!existsSync(argvLog)) return []
  return readFileSync(argvLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
}

function makeTool(): (params: LaInput, context?: Context) => Promise<AgentToolResult<LaDetails>> {
  const tool = createLaTool({ enginesDir, store: new CaptureStore() })
  tools.push(tool)
  return (params, context = BACKGROUND_CONTEXT) =>
    tool.execute(
      "c1",
      params,
      () => {},
      { env: new NodeExecutionEnv({ cwd: projectDir }) },
      invocation,
      context,
    ) as Promise<AgentToolResult<LaDetails>>
}

function textOf(result: AgentToolResult<LaDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

/** demo 波形:25 MHz × 131072 采样 × 16 通道(la.test.ts 记着的既知真值)。 */
const CAPTURE_REPORT = {
  ok: true,
  file: "capture.dsl",
  samplerate: 25_000_000,
  samples: 131_072,
  requested_samples: 131_072,
  device_actual_samples: 131_072,
  duration_ms: 5.24,
  trigger: { enabled: false, fired: false, pos: 0 },
  channels: [{ index: 0, name: "SDA" }],
  mode: "buffer",
  packets: 1,
  bytes_in: 262_144,
  timed_out: false,
  overflow: false,
  data_error: 0,
  elapsed_ms: 12,
  device: { model: "DSLogic Plus", pid: "0x0020", hdl_version: 3 },
}

/**
 * capture 子命令:把 demo 波形拷成 <out>/capture.dsl,再吐一份报告,**最后留一个完成标记**。
 *
 * 那个标记是这组测试的关键道具:"stop / dispose 真的把设备放开了吗"没法直接断言(本机没有真设备),
 * 但"那个子进程有没有跑到底"可以 —— 被杀掉的采集永远写不出标记。审稿人正是用它证明了
 * dispose 之后还有两个子进程活着跑完。
 */
function captureBody(extra = ""): string {
  return `copyFileSync(${JSON.stringify(DEMO)}, arg("--out") + "/capture.dsl"); const r = ${JSON.stringify(
    CAPTURE_REPORT,
  )}; r.file = arg("--out") + "/capture.dsl"; process.stdout.write(JSON.stringify(r)); writeFileSync(${JSON.stringify(
    "@FINISHED@",
  )}, "1"); ${extra}`
}

/** 立刻完成的采集。 */
const CAPTURE_OK = captureBody()

/** 慢采集:等一会儿再完成 —— 期间可以 stop / dispose。 */
function slowCapture(ms: number): string {
  return `setTimeout(() => { ${captureBody()} }, ${ms})`
}

// ─── 纯函数 ──────────────────────────────────────────────────────────────────

describe("pulseStats", () => {
  it("方波:高低脉宽与周期都算得出,中位数按数值序不按字典序", () => {
    // 边沿号 0,10,20,…:高 10、低 10、周期 20。
    const edges = Uint32Array.from([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    const stats = pulseStats(edges, 1)
    expect(stats.high?.median).toBe(10)
    expect(stats.low?.median).toBe(10)
    expect(stats.period?.median).toBe(20)
    expect(stats.glitches).toBe(0)
  })

  it("高低分桶按电平走:第一个边沿之后的电平决定谁是高", () => {
    // 宽度依次 9,100,9,100,9,100;levelAfterFirst=1 ⇒ 高={9,9,9}、低={100,100,100}。
    const edges = Uint32Array.from([0, 9, 109, 118, 218, 227, 327])
    const high = pulseStats(edges, 1)
    expect([high.high?.min, high.high?.max]).toEqual([9, 9])
    expect([high.low?.min, high.low?.max]).toEqual([100, 100])
    // 反过来起步,两个桶就换个个儿。
    const low = pulseStats(edges, 0)
    expect([low.high?.min, low.high?.max]).toEqual([100, 100])
  })

  it("中位数按数值大小取,不是按字典序 —— 字典序会把 100 排在 8 前面,时序结论整个错掉", () => {
    // 高 = 9,100,8(排序后 8,9,100 ⇒ 中位数 9;字典序是 100,8,9 ⇒ 会给出 8)
    const edges = Uint32Array.from([0, 9, 14, 114, 119, 127, 132])
    expect(pulseStats(edges, 1).high?.median).toBe(9)
  })

  it("≤2 采样的脉冲记成毛刺:它要么是真毛刺,要么是采样率不够,两种都得说", () => {
    const edges = Uint32Array.from([0, 1, 2, 100, 200])
    expect(pulseStats(edges, 1).glitches).toBe(2)
  })

  it("边沿不足两个时不炸,给一份空统计", () => {
    expect(pulseStats(Uint32Array.from([5]), 0)).toEqual({ glitches: 0 })
    expect(pulseStats(Uint32Array.from([]), 0)).toEqual({ glitches: 0 })
  })
})

describe("windowOf", () => {
  const meta = { samplerate: 1_000_000, samples: 1_000_000, durationMs: 1000 }

  it("毫秒换成采样号,不给就是整段", () => {
    expect(windowOf(meta, undefined, undefined)).toEqual({ from: 0, to: 1_000_000 })
    expect(windowOf(meta, 1, 2)).toEqual({ from: 1000, to: 2000 })
  })

  it("超出范围的钳回采集边界", () => {
    expect(windowOf(meta, -5, 99_999)).toEqual({ from: 0, to: 1_000_000 })
  })

  it("空窗口直接抛 —— 静默返回 0 条会被当成「总线上什么都没有」", () => {
    expect(() => windowOf(meta, 5, 5)).toThrow(/empty window/)
    expect(() => windowOf(meta, 8, 3)).toThrow(/empty window/)
  })
})

describe("captureSpecOf", () => {
  it("缺省:20M 采样率、1M 采样、30 s 超时", () => {
    const spec = captureSpecOf({ action: "capture" })
    expect(spec.samplerate).toBe("20M")
    expect(spec.samples).toBe("1M")
    expect(spec.timeoutMs).toBe(30_000)
  })

  it("给了 durationMs 就不再给 samples(两者是二选一,同时给引擎会各按各的来)", () => {
    const spec = captureSpecOf({ action: "capture", durationMs: 250 })
    expect(spec.samples).toBeUndefined()
    expect(spec.durationMs).toBe(250)
  })

  it("写法错了在这里就拦下 —— 引擎那边的报错是 libsigrok 原话,模型看不懂也改不对", () => {
    expect(() => captureSpecOf({ action: "capture", samples: "一百万" })).toThrow(/samples/)
    expect(() => captureSpecOf({ action: "capture", samplerate: "fast" })).toThrow(/samplerate/)
    expect(() => captureSpecOf({ action: "capture", trigger: { "1": "z" } })).toThrow(/trigger/)
    expect(captureSpecOf({ action: "capture", trigger: { "1": "F" } }).trigger).toEqual({ "1": "F" })
  })

  it("超时钳在 1 s .. 1 h", () => {
    expect(captureSpecOf({ action: "capture", timeoutMs: 1 }).timeoutMs).toBe(1_000)
    expect(captureSpecOf({ action: "capture", timeoutMs: 9e9 }).timeoutMs).toBe(3_600_000)
  })
})

// ─── 契约 ────────────────────────────────────────────────────────────────────

describe("契约", () => {
  it("expect 语法说明与 domain 的 EXPECT_SYNTAX 同值(契约不许 import domain,只能抄)", () => {
    expect(EXPECT_SYNTAX_TEXT).toBe(EXPECT_SYNTAX)
  })

  it("13 个动作都在 schema 的 union 里", () => {
    const union = (LA_CONTRACT.parameters as { properties: { action: { anyOf: { const: string }[] } } }).properties
      .action
    expect(union.anyOf.map((entry) => entry.const)).toEqual([...LA_ACTIONS])
  })

  it("不设确认门:这台设备只听总线,也不碰调试探针", () => {
    // 走真正那道门(contracts.ts 的总表),而不是看契约上有没有那个字段 —— 门在总表那儿。
    for (const action of LA_ACTIONS) expect(confirmNeeded("la", { action })).toBeUndefined()
  })

  it("summary 在参数还没拼完时也给得出话", () => {
    expect(LA_CONTRACT.summary({ action: "capture", samplerate: "25M", samples: "2M" })).toBe("capture 2M @ 25M")
    expect(LA_CONTRACT.summary({ action: "capture" })).toBe("capture 1M @ 20M")
    expect(LA_CONTRACT.summary({ action: "arm", durationMs: 500, trigger: { "1": "f" } })).toBe(
      'arm 500ms @ 20M trigger {"1":"f"}',
    )
    expect(LA_CONTRACT.summary({ action: "events", capture: "la-1", search: "0x62" })).toBe("events la-1 /0x62/")
    expect(LA_CONTRACT.summary({})).toBe("")
  })
})

// ─── 走假引擎的动作 ──────────────────────────────────────────────────────────

describe("devices", () => {
  it("一台都没有时给的是排查步骤,不是一句 not found", async () => {
    fakeEngine({ devices: "process.stdout.write(JSON.stringify({ devices: [], count: 0 }))" })
    const text = textOf(await makeTool()({ action: "devices" }))
    expect(text).toContain("Is it plugged in")
    expect(text).toContain("close it") // DSView 开着会占住设备
    expect(text).toContain('device="demo"')
  })

  it("有设备时把能力摆出来,并提醒 vth", async () => {
    fakeEngine({
      devices: `process.stdout.write(JSON.stringify({ count: 1, devices: [{ name: "dev", driver: "DSLogic", type: "usb", model: "DSLogic Plus", pid: "0x0020", channels: 16, depth_per_channel: 16e6, features: ["trigger"], samplerates: [25e6], channel_modes: [{ id: 0, stream: false, channels: 16, max_samplerate: 100e6, desc: "" }], vth: 1.65, hdl_version: 3, hdl_expected: 3 }] }))`,
    })
    const text = textOf(await makeTool()({ action: "devices" }))
    expect(text).toContain("DSLogic Plus")
    expect(text).toContain("vth: 1.65 V")
  })
})

describe.skipIf(!HAS_DEMO)("capture → summary → timing(真的解析 .dsl,只有碰设备那一步是假的)", () => {
  it("采集之后落盘、登记,并给出下一步", async () => {
    fakeEngine({ capture: CAPTURE_OK })
    const run = makeTool()
    const result = await run({ action: "capture", samplerate: "25M", samples: "131072" })
    expect(textOf(result)).toContain("done")
    expect(textOf(result)).toContain("next: la summary")
    expect(result.details?.captureId).toMatch(/^la-/)
    expect(existsSync(join(result.details!.dir!, "capture.dsl"))).toBe(true)
    expect(existsSync(join(result.details!.dir!, "capture.json"))).toBe(true)
    // 预览进 details:界面画波形靠它,每通道一段 base64。
    expect(result.details?.preview?.columns).toBe(1024)
    expect(Object.keys(result.details?.preview?.rows ?? {}).length).toBeGreaterThan(1)
  })

  it("summary 报出既知真值:SDA=D0 154 个边沿、SCL=D1 510 个", async () => {
    fakeEngine({ capture: CAPTURE_OK })
    const run = makeTool()
    await run({ action: "capture" })
    const result = await run({ action: "summary" })
    const byIndex = new Map((result.details?.channels ?? []).map((channel) => [channel.index, channel.edges]))
    expect(byIndex.get(0)).toBe(154)
    expect(byIndex.get(1)).toBe(510)
    // 提示是线索不是结论 —— 说死了模型就不去解码验证了。
    expect(textOf(result)).toContain("clock-like")
    expect(textOf(result)).toContain("next: la decode")
  })

  it("timing 算出脉宽与周期,窗口写进 details", async () => {
    fakeEngine({ capture: CAPTURE_OK })
    const run = makeTool()
    await run({ action: "capture" })
    const result = await run({ action: "timing", timingChannels: ["D1"] })
    expect(textOf(result)).toMatch(/D1 .*edges/)
    expect(textOf(result)).toContain("period")
    expect(result.details?.window).toEqual({ from: 0, to: 131_072 })
  })

  it("list 列出这个工程里的采集,并标出最近一次", async () => {
    fakeEngine({ capture: CAPTURE_OK })
    const run = makeTool()
    const first = await run({ action: "capture" })
    const text = textOf(await run({ action: "list" }))
    expect(text).toContain(first.details!.captureId!)
    expect(text).toContain("*")
  })

  it("没有采集时 list 说清去哪儿弄一个,而不是空手回来", async () => {
    fakeEngine({ capture: CAPTURE_OK })
    expect(textOf(await makeTool()({ action: "list" }))).toContain("no captures yet")
  })
})

describe("没有引擎的那半条路", () => {
  // 这台 mac 上就是这个状态:yoma-la 是可选引擎,构建脚本探不到 cmake/glib/libusb 时明确跳过。
  it("要碰设备的动作说清是「这份产物没带这个引擎」,并指出剩下那半条路", async () => {
    const run = makeTool() // 没装假引擎
    for (const action of ["devices", "capture", "arm", "decoders"] as const) {
      await expect(run({ action })).rejects.toThrow(/no logic-analyzer engine/)
    }
    // 通用那句是"重装 Yoma / 跑 engines:build" —— 对一个本来就可选的引擎,那是把人往沟里带。
    // 用 rejects.not.toThrow 写会静默通过(断言的是"没抛"而不是"抛的不是它"),所以自己接住看文本。
    const message = await run({ action: "devices" }).then(
      () => "(没抛)",
      (error: unknown) => String((error as Error)?.message ?? error),
    )
    expect(message).not.toMatch(/reinstall|engines:build/)
    expect(message).toContain("la import")
  })

  it.skipIf(!HAS_DEMO)("只读文件的动作照样能用:别人存的 .dsl 进来,统计照跑", async () => {
    const run = makeTool()
    await run({ action: "import", file: DEMO })
    expect(textOf(await run({ action: "summary" }))).toContain("edges")
    expect(textOf(await run({ action: "timing" }))).toContain("period")
  })
})

describe.skipIf(!HAS_DEMO)("import", () => {
  it("认得 DSView 存的 .dsl,登记之后下游与自己采的一模一样", async () => {
    fakeEngine({})
    const run = makeTool()
    const result = await run({ action: "import", file: DEMO })
    expect(textOf(result)).toContain("131,072 samples")
    expect(result.details?.samplerate).toBe(25_000_000)
    // 下游认它:summary 直接就能跑。
    expect(textOf(await run({ action: "summary" }))).toContain("edges")
  })

  it("文件不在就直说,不去猜", async () => {
    fakeEngine({})
    await expect(makeTool()({ action: "import", file: join(projectDir, "nope.dsl") })).rejects.toThrow(/not found/)
  })
})

describe.skipIf(!HAS_DEMO)("采集参数真的交到了引擎手上", () => {
  it("采样率 / 采样数 / 触发 / 阈值 / 模式 / 触发位置 / 超时都拼进 argv", async () => {
    fakeEngine({ capture: CAPTURE_OK })
    await makeTool()({
      action: "capture",
      samplerate: "25M",
      samples: "2M",
      trigger: { "1": "f" },
      vth: 1.65,
      mode: "stream",
      triggerPositionPct: 25,
      timeoutMs: 5_000,
      channels: [{ index: 0, name: "SDA" }],
    })
    const argv = (await waitForCall("capture")).join(" ")
    // 这几个开关错一个,采回来的就是一份看着正常、其实什么都不证明的波形。
    expect(argv).toContain("--rate 25M")
    expect(argv).toContain("--samples 2M")
    expect(argv).toContain("--vth 1.65")
    expect(argv).toContain("--mode stream")
    expect(argv).toMatch(/--trigger \S*1=f/)
    expect(argv).toContain("--timeout-ms 5000")
    expect(argv).toMatch(/--pos 25|--trigger-pos 25/)
  })

  it("给了 durationMs 就不再发 --samples(两个都发,引擎会各按各的来)", async () => {
    fakeEngine({ capture: CAPTURE_OK })
    await makeTool()({ action: "capture", durationMs: 250 })
    const argv = (await waitForCall("capture")).join(" ")
    expect(argv).toContain("--duration-ms 250")
    expect(argv).not.toContain("--samples")
  })
})

describe.skipIf(!HAS_DEMO)("采集报告里的警告", () => {
  const reportWith = (patch: Record<string, unknown>) =>
    `copyFileSync(${JSON.stringify(DEMO)}, arg("--out") + "/capture.dsl"); const r = Object.assign(${JSON.stringify(
      CAPTURE_REPORT,
    )}, ${JSON.stringify(patch)}); r.file = arg("--out") + "/capture.dsl"; process.stdout.write(JSON.stringify(r))`

  it("触发没打中要明说 —— 一份没触发的采集什么都不证明", async () => {
    fakeEngine({ capture: reportWith({ trigger: { enabled: true, fired: false, pos: 0 } }) })
    expect(textOf(await makeTool()({ action: "capture" }))).toContain("DID NOT FIRE")
  })

  it("超时、USB 溢出、设备报的数据错,一条都不许吞", async () => {
    fakeEngine({
      capture: reportWith({ timed_out: true, overflow: true, data_error: 3, elapsed_ms: 30_000 }),
    })
    const text = textOf(await makeTool()({ action: "capture" }))
    expect(text).toContain("timed out waiting")
    expect(text).toContain("USB overflow")
    expect(text).toContain("data error 3")
  })

  it("一个样本都没采到时不登记成一份采集,但把原因说清", async () => {
    fakeEngine({ capture: reportWith({ ok: false, samples: 0, timed_out: true }) })
    const run = makeTool()
    const result = await run({ action: "capture" })
    expect(textOf(result)).toContain("INCOMPLETE")
    expect(textOf(result)).toContain("nothing captured")
    expect(result.details?.samples).toBe(0)
    // 没登记:list 里不该出现它 —— 不然下游 summary 会去开一个空目录。
    expect(textOf(await run({ action: "list" }))).toContain("no captures yet")
  })
})

describe.skipIf(!HAS_DEMO)("arm / collect / stop", () => {
  const SLOW_CAPTURE = slowCapture(150)

  it("arm 立刻返回(板子还没复位呢),collect 再把结果拿回来", async () => {
    fakeEngine({ capture: SLOW_CAPTURE })
    const run = makeTool()
    const armed = await run({ action: "arm", trigger: { "1": "f" } })
    expect(armed.details?.armed).toBe(true)
    expect(textOf(armed)).toContain("Now do the thing")
    const collected = await run({ action: "collect" })
    expect(textOf(collected)).toContain("done")
    expect(collected.details?.samples).toBe(131_072)
  })

  it("同一批里两条 arm:第二条被拒,而不是两个子进程一起去开同一台设备", async () => {
    fakeEngine({ capture: SLOW_CAPTURE })
    const run = makeTool()
    // 发动机忽略 executionMode,同批调用是并行的 —— 工具得自己排队。
    const [first, second] = await Promise.allSettled([run({ action: "arm" }), run({ action: "arm" })])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual(["fulfilled", "rejected"])
    const rejected = (first.status === "rejected" ? first : second) as PromiseRejectedResult
    expect(String(rejected.reason)).toMatch(/already armed/)
    await waitForCall("capture")
    // 只起了一个采集进程:引擎的采集库是全局单例 + 单活动设备,两个一起去开是未定义行为。
    expect(argvCalls().filter((argv) => argv[0] === "capture")).toHaveLength(1)
    await run({ action: "stop" })
  })

  it("stop 真的把采集杀掉 —— 不是等它自己跑完再说一句 discarded", async () => {
    fakeEngine({ capture: slowCapture(300) })
    const run = makeTool()
    await run({ action: "arm" })
    await waitForCall("capture")
    expect(textOf(await run({ action: "stop" }))).toContain("discarded")
    // 被杀掉的采集永远写不出完成标记。只断言那句 "discarded" 的话,去掉 abort 照样绿(审稿实测)。
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(existsSync(finishedMarker())).toBe(false)
  })

  it("没武装时 stop 不算错", async () => {
    fakeEngine({ capture: SLOW_CAPTURE })
    expect(textOf(await makeTool()({ action: "stop" }))).toContain("nothing armed")
  })

  it("没武装就 collect 是错误,并告诉它先 arm", async () => {
    fakeEngine({ capture: SLOW_CAPTURE })
    await expect(makeTool()({ action: "collect" })).rejects.toThrow(/nothing armed/)
  })

  it("会话关掉时武装着的采集要放开设备 —— 不放的话下一个会话打不开它", async () => {
    // 采集 300 ms,断言窗口 800 ms:窗口必须**比采集自己跑完还长**,否则"没杀掉"和"还没跑完"
    // 长得一模一样,用例就成了空的(第一版 1500/400 就是这个毛病,变异验证时才露出来)。
    fakeEngine({ capture: slowCapture(300) })
    const tool = createLaTool({ enginesDir, store: new CaptureStore() })
    const execute = (params: LaInput) =>
      tool.execute(
        "c1",
        params,
        () => {},
        { env: new NodeExecutionEnv({ cwd: projectDir }) },
        invocation,
        BACKGROUND_CONTEXT,
      )
    await execute({ action: "arm" })
    await waitForCall("capture")
    await tool.dispose()
    // 子进程必须已经死了。只断言下面那句 /closing/ 的话,把 dispose 减成 disposed=true 照样绿(审稿实测)。
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(existsSync(finishedMarker())).toBe(false)
    // dispose 之后不许再开新的:会话正在拆。
    await expect(execute({ action: "arm" })).rejects.toThrow(/closing/)
  })

  it("collect 等着的时候会话被关:那个子进程照样收得走 —— 它这时已经不在 armed 里了", async () => {
    fakeEngine({ capture: slowCapture(300) })
    const tool = createLaTool({ enginesDir, store: new CaptureStore() })
    const execute = (params: LaInput) =>
      tool.execute(
        "c1",
        params,
        () => {},
        { env: new NodeExecutionEnv({ cwd: projectDir }) },
        invocation,
        BACKGROUND_CONTEXT,
      )
    await execute({ action: "arm" })
    await waitForCall("capture")
    const collecting = execute({ action: "collect" }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await tool.dispose()
    await collecting
    // collect 一开始就把 armed 清掉了;只看 armed 的 dispose 会放它跑到底(审稿实测 dispose 1 ms 就返回、
    // 子进程 2 秒后才跑完,而 runEngine 是 detached —— 宿主这时退出就是个孤儿)。
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(existsSync(finishedMarker())).toBe(false)
  })

  it("排在队列里的 arm 不许在 dispose 之后才开跑", async () => {
    fakeEngine({ capture: slowCapture(300) })
    const tool = createLaTool({ enginesDir, store: new CaptureStore() })
    const execute = (params: LaInput) =>
      tool.execute(
        "c1",
        params,
        () => {},
        { env: new NodeExecutionEnv({ cwd: projectDir }) },
        invocation,
        BACKGROUND_CONTEXT,
      )
    const first = execute({ action: "capture" }).catch(() => undefined)
    const queued = execute({ action: "arm" }).then(
      () => "跑了",
      (error: unknown) => String((error as Error)?.message ?? error),
    )
    await tool.dispose()
    // 闸门在队列外面的话,这条会在会话拆完之后照样起一个谁也收不走的子进程(审稿实测)。
    expect(await queued).toMatch(/closing/)
    await first
  })
})

describe.skipIf(!HAS_DEMO)("decode 的参数拼装", () => {
  const DECODE_OK = `
const out = arg("--out")
const meta = { type: "meta", file: arg("--in"), version: 1, samplerate: 25000000, total_samples: 131072, trigger_pos: null, from: Number(arg("--from") ?? 0), to: Number(arg("--to") ?? 131072), channels: [], decoders: [{ key: "i2c0", id: "onewire", name: "1-Wire", channels: {}, options: {}, rows: [{ id: "addr", desc: "Address", classes: [0] }], classes: [{ id: "a", desc: "addr" }] }] }
const ann = { s: 10, e: 20, k: "i2c0", c: 0, t: ["W 0x62"] }
const end = { type: "end", annotations: 1, elapsed_ms: 3, ok: true }
writeFileSync(out, [meta, ann, end].map((o) => JSON.stringify(o)).join("\\n") + "\\n")
process.stdout.write("")`

  it("通道名被翻成通道号交给引擎 —— 拼错了不会报错,只会解出一片垃圾", async () => {
    fakeEngine({ capture: CAPTURE_OK, decode: DECODE_OK })
    const run = makeTool()
    await run({ action: "capture" })
    await run({
      action: "decode",
      decoders: [{ key: "i2c0", id: "1:i2c", channels: { scl: "SCL", sda: "SDA" }, options: { addressing: "7" } }],
    })
    const decode = argvCalls().find((argv) => argv[0] === "decode")
    const pd = decode?.[decode.indexOf("--pd") + 1]
    // demo 波形里 SDA 是 D0、SCL 是 D1。
    expect(pd).toBe("i2c0=1:i2c:scl=1:sda=0:addressing=7")
  })

  it("通道名不存在时当场说清这份采集里有哪些", async () => {
    fakeEngine({ capture: CAPTURE_OK, decode: DECODE_OK })
    const run = makeTool()
    await run({ action: "capture" })
    await expect(
      run({ action: "decode", decoders: [{ key: "i2c0", id: "1:i2c", channels: { scl: "NOPE" } }] }),
    ).rejects.toThrow(/no such channel/)
  })

  it("key 必须是短标识符(它要进引擎的 --pd 串,带冒号会把串拆坏)", async () => {
    fakeEngine({ capture: CAPTURE_OK, decode: DECODE_OK })
    const run = makeTool()
    await run({ action: "capture" })
    await expect(run({ action: "decode", decoders: [{ key: "i2c:0", id: "1:i2c" }] })).rejects.toThrow(
      /short identifier/,
    )
  })

  it("解码之后 events 读得回来,decode.json 也落了盘", async () => {
    fakeEngine({ capture: CAPTURE_OK, decode: DECODE_OK })
    const run = makeTool()
    const captured = await run({ action: "capture" })
    await run({ action: "decode", decoders: [{ key: "i2c0", id: "1:i2c", channels: { sda: "SDA" } }] })
    expect(existsSync(join(captured.details!.dir!, "decode.json"))).toBe(true)
    const events = await run({ action: "events" })
    expect(textOf(events)).toContain("W 0x62")
    expect(events.details?.decoders?.[0]?.key).toBe("i2c0")
  })

  it("没解码就问 events,告诉它先 decode,而不是回一句空", async () => {
    fakeEngine({ capture: CAPTURE_OK })
    const run = makeTool()
    await run({ action: "capture" })
    await expect(run({ action: "events" })).rejects.toThrow(/not decoded yet/)
  })
})
