/**
 * flash 工具(host/tools/flash/session.ts)的验收。移植自 attic/test/engine-tools.test.ts ——
 * 那批用例在 2026-09-10 工具归零时退役,这里按新内核的六参 execute 重接。
 *
 * 这一组钉的是"烧录器非零退出是数据、不是错误"这条分类学,以及中断路径上探针租约照样归还:
 * 租约漏了之后,下一次 flash 报的是"probe is held by",而那句话与真的硬件被占用长得一模一样。
 * 假烧录器是一段 JS(fixtures/fake-exe.ts),不碰任何真探针。
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { claimProbe, releaseProbe } from "../src/host/domain/engines.ts"
import { FLASH_CONTRACT, type FlashDetails, type FlashInput } from "../src/host/tools/flash/contract.ts"
import { createFlashTool } from "../src/host/tools/flash/session.ts"
import { ECHO_ARGV_JS } from "./fixtures/fake-exe.ts"

const tempDirs: string[] = []

beforeAll(() => {
  // 真 ~/.yoma/probe.lock 归用户,测试绝不碰它 —— 跨进程租约按 pid 探活,留下的锁文件会误伤真会话。
  process.env.YOMA_PROBE_LOCK = join(tmpdir(), `yoma-probe-test-${process.pid}.lock`)
})

afterEach(() => {
  releaseProbe("flash")
  releaseProbe("log")
  releaseProbe("probe")
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

function createTempDir(): string {
  const dir = join(tmpdir(), `yoma-flash-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

/**
 * 假烧录器:一段 JS,argv 直接是 [node, 脚本],三平台同构 —— 不造 .cmd 启动器,Node 20.12 起无 shell 的
 * spawn 拒绝 .cmd/.bat,真烧录器在 Windows 上也是 .exe 而不是批处理。flash 不走 enginesDir,命令由模型
 * 自带,所以脚本住在自己的临时目录里。
 */
function fakeFlasher(js: string): string[] {
  const script = join(createTempDir(), "flasher.mjs")
  writeFileSync(script, js)
  return [process.execPath, script]
}

/** 内核每轮重解析工具上下文,这里照样每次 execute 现造一个 —— cwd 就是工程目录。 */
const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

function makeTool(script: string) {
  const flasher = fakeFlasher(script)
  const cwd = createTempDir()
  const tool = createFlashTool()
  const run = (params: FlashInput, context: Context = BACKGROUND_CONTEXT): Promise<AgentToolResult<FlashDetails>> =>
    tool.execute("c1", params, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, context)
  return { run, cwd, flasher }
}

function textOf(result: AgentToolResult<FlashDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

/** 已经 abort 的信号:runEngine 进门就走中断分支,不必跟计时赛跑。 */
function aborted(): Context {
  return withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT)
}

describe("flash 工具", () => {
  it("argv 原样跑,输出与退出码照实返回", async () => {
    const { run, flasher } = makeTool(ECHO_ARGV_JS)
    const result = await run({ command: [...flasher, "program", "fw.elf"] })
    expect(textOf(result)).toBe("argv: program fw.elf")
    expect(result.details).toEqual({ command: [...flasher, "program", "fw.elf"], exitCode: 0 })
  })

  it("非零退出是正常结果,带探针分诊,不是报错", async () => {
    const { run, flasher } = makeTool(`console.error("Error: no probe found"); process.exitCode = 1;`)
    const result = await run({ command: [...flasher, "program"] })
    const text = textOf(result)
    expect(text).toContain("failed (exit 1)")
    expect(text).toContain("Error: no probe found")
    expect(text).toContain("connect an ST-Link/J-Link/CMSIS-DAP probe")
    expect(text).toContain("another program is using the probe")
    expect(result.details.exitCode).toBe(1)
  })

  it("exclusive access 说探针被占,不说板子没插", async () => {
    const { run, flasher } = makeTool(
      `console.error("Error: Attaching to probe failed: exclusive access (0xe00002c5)"); process.exitCode = 1;`,
    )
    const text = textOf(await run({ command: [...flasher, "program"] }))
    expect(text).toContain("already in use")
    expect(text).toContain("NOT a disconnected board")
    expect(text).not.toMatch(/If no debug probe was found/)
  })

  it("成功时把 elfPath 按 cwd 解析后记进 flash-state.json", async () => {
    const { run, cwd, flasher } = makeTool(ECHO_ARGV_JS)
    writeFileSync(join(cwd, "fw.elf"), "fw")
    const result = await run({ command: [...flasher, "program"], elfPath: "fw.elf" })
    expect(result.details.recordedElf).toBe(join(cwd, "fw.elf"))
    expect(textOf(result)).toContain("gdb start will verify against it")
    const state = JSON.parse(readFileSync(join(cwd, ".yoma", "flash-state.json"), "utf8"))
    expect(state.elfPath).toBe(join(cwd, "fw.elf"))
    // 真算一遍 "fw" 的 sha256:只断言 typeof === "string" 的话,记成常数 0 也能过。
    expect(state.sha256).toBe("07f7ab476bc3a83fad639d34a012cb4a5f859441f0d24c11627ca96696839012")
  })

  it("失败不记账,不存在的 elfPath 在起子进程之前就拒", async () => {
    const { run, cwd, flasher } = makeTool(`process.exitCode = 1;`)
    writeFileSync(join(cwd, "fw.elf"), "fw")
    const failed = await run({ command: [...flasher, "program"], elfPath: "fw.elf" })
    expect(failed.details.recordedElf).toBeUndefined()
    expect(existsSync(join(cwd, ".yoma", "flash-state.json"))).toBe(false)
    await expect(run({ command: [...flasher, "program"], elfPath: "nope.elf" })).rejects.toThrow(/elfPath not found/)
  })

  it("烧成功但记不了账(elfPath 是个目录):仍是正常结果,只是不带 recordedElf", async () => {
    const { run, cwd, flasher } = makeTool(ECHO_ARGV_JS)
    mkdirSync(join(cwd, "fwdir"))
    // 片子已经烧好了;这里若抛错,模型下一步多半是再烧一次。
    const result = await run({ command: [...flasher, "program"], elfPath: "fwdir" })
    expect(result.details).toEqual({ command: [...flasher, "program"], exitCode: 0 })
    expect(existsSync(join(cwd, ".yoma", "flash-state.json"))).toBe(false)
  })

  it("空 command 直接拒,不去 spawn 一个空命令", async () => {
    const { run } = makeTool(ECHO_ARGV_JS)
    await expect(run({ command: [] })).rejects.toThrow(/requires command/)
  })

  it("超时有下界:timeoutMs 给 1 也钳到 5 秒,半秒的烧录照样跑完", async () => {
    const { run, flasher } = makeTool(`setTimeout(() => {}, 500);`)
    // 没有钳位时 1ms 就超时,assertEngineSettled 抛 "timed out"。
    const result = await run({ command: [...flasher, "program"], timeoutMs: 1 })
    expect(result.details.exitCode).toBe(0)
  })

  it("跑到一半被停:烧录器被杀、抛 aborted,而且探针租约还回去了", async () => {
    // 假烧录器睡 10 秒:不被杀就会超出用例超时。
    const { run, flasher } = makeTool(`setTimeout(() => {}, 10_000);`)
    const controller = new AbortController()
    const running = run({ command: [...flasher, "program"] }, withAbortSignal(controller.signal, BACKGROUND_CONTEXT))
    setTimeout(() => controller.abort(), 300)
    await expect(running).rejects.toThrow("was aborted")
    // 租约在 finally 里放:这里若还攥着,claim 会返回 flash 那份租约。
    expect(claimProbe("probe", "after abort")).toBeUndefined()
  })

  it("上一次 flash 还没跑完:指名它拒掉,而且不能顺手把它的租约放了", async () => {
    const { run, flasher } = makeTool(ECHO_ARGV_JS)
    expect(claimProbe("flash", "prior openocd")).toBeUndefined()
    await expect(run({ command: [...flasher, "info"] })).rejects.toThrow(/wait for that command to finish/)
    // releaseProbe 只比 owner 名:claim 与冲突 throw 若挪进 try,finally 会把同名前任的租约抹掉,
    // 这里第二次 claim 就拿得到了 —— 那正是"两路烧录各自以为独占探针"的开头。
    expect(claimProbe("probe", "second")?.owner).toBe("flash")
  })

  it("探针被 log 攥着:错误里指名持有者", async () => {
    const { run, flasher } = makeTool(ECHO_ARGV_JS)
    expect(claimProbe("log", "RTT on STM32G431CB")).toBeUndefined()
    await expect(run({ command: [...flasher, "info"] })).rejects.toThrow(/log/)
  })

  it("这一轮已被停掉:一个探针都不碰,直接抛 aborted", async () => {
    const { run, flasher } = makeTool(ECHO_ARGV_JS)
    expect(claimProbe("log", "RTT on STM32G431CB")).toBeUndefined()
    // 探针明明被 log 攥着,却报 aborted 而不是 held:说明信号检查在 claim 之前,子进程根本没起。
    await expect(run({ command: [...flasher, "info"] }, aborted())).rejects.toThrow("was aborted")
  })
})

describe("flash 契约", () => {
  it("summary 把 argv 拼回一行:含空格的参数加引号,不转义引号本身", () => {
    expect(FLASH_CONTRACT.summary({})).toBe("")
    expect(FLASH_CONTRACT.summary({ command: [] })).toBe("")
    expect(FLASH_CONTRACT.summary({ command: ["openocd", "-c", "program fw.elf verify reset exit"] })).toBe(
      'openocd -c "program fw.elf verify reset exit"',
    )
    expect(FLASH_CONTRACT.summary({ command: ["JLink", "-Device", 'a"b'] })).toBe('JLink -Device a"b')
  })

  it("烧录每一次都要问用户", () => {
    expect(FLASH_CONTRACT.confirm({ command: ["openocd"] })).toBe(true)
  })
})
