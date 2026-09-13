/**
 * powershell 工具(host/tools/powershell/session.ts)的验收。
 *
 * 真 PowerShell 只在 Windows 上有,所以这一组用一段 JS 冒充它(fixtures/fake-exe.ts):它把收到的
 * argv 打出来,并把 -EncodedCommand 的 base64 解回 UTF-16LE 脚本 —— 于是"四个固定开关逐字"与
 * "两行编码头在脚本最前面"这两条契约在 macOS/Linux 上也钉得住。那两行头是付过学费的疤:
 * 少了 $ProgressPreference,5.1 会把进度记录序列化成 `#< CLIXML` 写 stderr(模型会当成脚本输出读);
 * 少了 [Console]::OutputEncoding,中文 Windows 上输出按 cp936 写而我们按 UTF-8 解,得到 U+FFFD。
 *
 * 假货走的是 POSIX 的 sh 启动器,Windows 上是 .cmd —— 而 Node≥20.12 无 shell 的 spawn 拒 .cmd,
 * 所以假货那一组在 win32 上跳过,那台机器跑的是下面真 PowerShell 的往返用例。
 */

import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import type { PowerShellDetails, PowerShellInput } from "../src/host/tools/powershell/contract.ts"
import {
  createPowerShellTool,
  findOnPath,
  POWERSHELL_MISSING,
  powershellArgv,
  powershellExe,
  powershellScript,
  PS_NO_PROGRESS,
  PS_UTF8_OUTPUT,
  stripClixml,
} from "../src/host/tools/powershell/session.ts"
import { writeFakeExe } from "./fixtures/fake-exe.ts"

const tempDirs: string[] = []
const originalPath = process.env.PATH

afterEach(() => {
  process.env.PATH = originalPath
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

function createTempDir(): string {
  const dir = join(tmpdir(), `yoma-ps-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

/** 假 PowerShell:一段 JS,外面按平台包一层启动器;返回的是给 `{ exe }` 用的可执行文件路径。 */
function fakePowerShell(js: string): string {
  return writeFakeExe(createTempDir(), "fake-powershell", js)
}

function makeTool(js: string | undefined, cwd = createTempDir()) {
  const tool = createPowerShellTool(js === undefined ? {} : { exe: fakePowerShell(js) })
  const run = (
    params: PowerShellInput,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<AgentToolResult<PowerShellDetails>> =>
    tool.execute("c1", params, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, context)
  return { run, cwd }
}

function textOf(result: AgentToolResult<PowerShellDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

/**
 * 一段"打 N 行然后卡住"的假脚本:行全部交给管道之后才在 cwd 落一个 ready.txt。中止类用例等这个文件
 * 出现再点停止 —— 按固定毫秒数等的话,满载的 CI 上进程还没起来就被停了,断言"输出还在"会假红。
 */
function printThenHang(lines: number): string {
  return [
    `import { writeFileSync } from "node:fs"`,
    `const text = Array.from({ length: ${lines} }, (_, i) => "line " + i).join("\\n") + "\\n"`,
    `process.stdout.write(text, () => writeFileSync("ready.txt", "1"))`,
    `setInterval(() => {}, 1000)`,
  ].join("\n")
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** 把 argv 与解回来的脚本一起打出来的假货:前者验开关,后者验两行头。 */
const ECHO_ENCODED_JS = `
const args = process.argv.slice(2)
const i = args.indexOf("-EncodedCommand")
console.log("flags: " + args.slice(0, i).join(" "))
process.stdout.write(Buffer.from(args[i + 1], "base64").toString("utf16le"))
`

describe("powershell 纯函数", () => {
  it("脚本头两行的顺序是契约", () => {
    const script = powershellScript("Get-Date")
    expect(script.split("\n")).toEqual([PS_NO_PROGRESS, PS_UTF8_OUTPUT, "Get-Date"])
    expect(PS_NO_PROGRESS).toContain("SilentlyContinue")
    expect(PS_UTF8_OUTPUT).toContain("OutputEncoding")
  })

  it("argv 是四个固定开关 + -EncodedCommand,base64 能解回 UTF-16LE 脚本", () => {
    const argv = powershellArgv("Write-Output 'héllo €'")
    expect(argv.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"])
    expect(argv).toHaveLength(6)
    expect(Buffer.from(argv[5], "base64").toString("utf16le")).toBe(powershellScript("Write-Output 'héllo €'"))
  })

  it("超长命令被拒,并指向 .ps1 + -File", () => {
    expect(() => powershellArgv("a".repeat(30_000))).toThrow(/command too long/)
    expect(() => powershellArgv("a".repeat(30_000))).toThrow(/-File/)
  })

  it("stripClixml 剥掉整块 XML,留下真报错", () => {
    const stderr = [
      "#< CLIXML",
      '<Objs Version="1.1.0.1" xmlns="http://x"><Obj S="progress" RefId="0"><TN RefId="0"><T>p</T></TN></Obj></Objs>',
      "Get-PnpDevice : real failure",
    ].join("\n")
    expect(stripClixml(stderr)).toBe("Get-PnpDevice : real failure")
  })

  it("stripClixml 把块里的错误记录解码出来,而不是连同进度一起删掉", () => {
    const stderr = [
      "#< CLIXML",
      '<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"><TN RefId="0"><T>p</T></TN></Obj><S S="Error">Get-PnpDevice : boom &lt;x&gt;_x000D__x000A_</S><S S="Error">second_x000D__x000A_</S></Objs>',
    ].join("\n")
    expect(stripClixml(stderr)).toBe("Get-PnpDevice : boom <x>\nsecond\n")
  })

  it("stripClixml 把 Verbose / Debug / Information 流也解出来,只丢进度记录", () => {
    // 上一版只认 Error / Warning:`$VerbosePreference='Continue'; Write-Verbose "probe on COM3"` 退出码 0、
    // stdout 空、stderr 就是这一块 —— 整块删掉后模型看到 "(no output)",认定"脚本跑了、什么都没找到"。
    const stderr = [
      "#< CLIXML",
      '<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"><TN RefId="0"><T>p</T></TN><MS><PR N="Record"><AV>Preparing modules</AV></PR></MS></Obj>' +
        '<S S="Verbose">probe attached on COM3_x000D__x000A_</S><S S="Debug">d</S><S S="Information">i</S><S S="Warning">w</S></Objs>',
    ].join("\n")
    expect(stripClixml(stderr)).toBe("probe attached on COM3\nd\ni\nw\n")
  })

  it("stripClixml 对多块、对只有标记行的情况都成立", () => {
    expect(stripClixml("#< CLIXML\n<Objs a><Obj/></Objs>\n#< CLIXML\n<Objs b></Objs>\nkeep")).toBe("keep")
    expect(stripClixml("#< CLIXML\nkeep")).toBe("keep")
    expect(stripClixml("no xml here")).toBe("no xml here")
  })

  it("findOnPath 在给定 PATH 上找,找不到给 undefined", () => {
    const dir = createTempDir()
    const exe = writeFakeExe(dir, "fake-powershell", "")
    expect(findOnPath(join("..", "..", "nope"), dir)).toBeUndefined()
    expect(findOnPath(exe.slice(dir.length + 1), dir)).toBe(exe)
    expect(findOnPath("definitely-not-here", createTempDir())).toBeUndefined()
  })

  it("powershellExe 优先用显式注入的那个", () => {
    expect(powershellExe("/custom/pwsh")).toBe("/custom/pwsh")
  })
})

// 见文件头:假货的启动器在 Windows 上是 .cmd,无 shell 的 spawn 起不了它。
describe.skipIf(process.platform === "win32")("powershell 工具(假 PowerShell)", () => {
  it("四个固定开关逐字,两行编码头在脚本最前面", async () => {
    const { run } = makeTool(ECHO_ENCODED_JS)
    const lines = textOf(await run({ command: "Write-Output hi" })).split("\n")
    expect(lines[0]).toBe("flags: -NoProfile -NonInteractive -ExecutionPolicy Bypass")
    expect(lines[1]).toBe(PS_NO_PROGRESS)
    expect(lines[2]).toBe(PS_UTF8_OUTPUT)
    expect(lines[3]).toBe("Write-Output hi")
  })

  it("在会话 cwd 里跑", async () => {
    const cwd = createTempDir()
    const { run } = makeTool(`console.log(process.cwd())`, cwd)
    // macOS 的 /var 是 /private/var 的符号链接,子进程报的是真实路径 —— 比对前先 realpath。
    expect(textOf(await run({ command: "pwd" }))).toBe(realpathSync(cwd))
  })

  it("stdout 与 stderr 合流,exitCode 进 details", async () => {
    const { run } = makeTool(`console.log("on stdout"); console.error("on stderr")`)
    const result = await run({ command: "x" })
    expect(textOf(result)).toBe("on stdout\non stderr")
    expect(result.details).toEqual({ exitCode: 0 })
  })

  it("没有输出时返回 (no output)", async () => {
    const { run } = makeTool("")
    expect(textOf(await run({ command: "x" }))).toBe("(no output)")
  })

  it("CLIXML 块被剥掉,真报错留着", async () => {
    const js = `
console.log("done")
console.error('#< CLIXML\\n<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"/></Objs>')
console.error("Get-PnpDevice : real failure")
`
    const text = textOf(await makeTool(js).run({ command: "Get-PnpDevice" }))
    expect(text).toContain("done")
    expect(text).toContain("Get-PnpDevice : real failure")
    expect(text).not.toContain("CLIXML")
    expect(text).not.toContain("<Objs")
  })

  it("非零退出抛 Command exited with code,并带上已有输出", async () => {
    const { run } = makeTool(`console.log("partial output"); process.exitCode = 3`)
    await expect(run({ command: "x" })).rejects.toThrow("Command exited with code 3")
    await expect(run({ command: "x" })).rejects.toThrow("partial output")
  })

  it("输出边跑边喂进度:onUpdate 收到活尾巴", async () => {
    const exe = fakePowerShell(`console.log("step 1"); setTimeout(() => { console.log("step 2") }, 80)`)
    const tool = createPowerShellTool({ exe })
    const updates: string[] = []
    await tool.execute(
      "c1",
      { command: "x" },
      (partial) => updates.push(partial.content.map((part) => (part.type === "text" ? part.text : "")).join("")),
      { env: new NodeExecutionEnv({ cwd: createTempDir() }) },
      invocation,
      BACKGROUND_CONTEXT,
    )
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(updates[0]).toContain("step 1")
    expect(updates[0]).not.toContain("step 2")
    expect(updates.at(-1)).toContain("step 2")
  })

  it("超时抛 timed out(进程树被杀)", async () => {
    const { run } = makeTool(`setInterval(() => {}, 1000)`)
    await expect(run({ command: "Start-Sleep 60", timeout: 1 })).rejects.toThrow(/timed out/)
  })

  it("超时 / 中止时已经打出的输出跟着错误一起给,不只六个字", async () => {
    // 打 50 行再卡住:模型要能看到 "line 49",否则分不清脚本做了零件事还是做完了 99%。
    const { run, cwd } = makeTool(printThenHang(50))
    let message = ""
    await run({ command: "x", timeout: 1 }).catch((error: Error) => (message = error.message))
    expect(message).toContain("line 49")
    expect(message).toMatch(/timed out after 1 seconds/)

    rmSync(join(cwd, "ready.txt"), { force: true })
    const controller = new AbortController()
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
    const pending = run({ command: "x" }, context)
    await waitForFile(join(cwd, "ready.txt"))
    controller.abort()
    message = ""
    await pending.catch((error: Error) => (message = error.message))
    expect(message).toContain("line 49")
    expect(message).toContain("powershell was aborted")
  })

  it("中止时超长输出照样落临时文件:头部(往往是真报错)不能因为上下文已中止就丢", async () => {
    const { run, cwd } = makeTool(printThenHang(3000))
    const controller = new AbortController()
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
    const pending = run({ command: "x" }, context)
    await waitForFile(join(cwd, "ready.txt"))
    controller.abort()
    let message = ""
    await pending.catch((error: Error) => (message = error.message))
    expect(message).toContain("powershell was aborted")
    const spilled = /Full output: (\S+\.log)/.exec(message)?.[1]
    expect(spilled).toBeDefined()
    expect(readFileSync(spilled!, "utf8")).toContain("line 0\n")
  })

  it("截断时只留尾部,并把全文写进临时文件", async () => {
    const { run } = makeTool(`for (let i = 1; i <= 2500; i++) console.log("line " + i)`)
    const result = await run({ command: "x" })
    const text = textOf(result)
    expect(text).not.toContain("line 1\n")
    expect(text).toContain("line 2500")
    expect(text).toContain("[Showing lines 501-2500 of 2500. Full output: ")
    expect(result.details.truncation?.truncatedBy).toBe("lines")
    const fullOutputPath = result.details.fullOutputPath!
    expect(readFileSync(fullOutputPath, "utf8").split("\n")).toHaveLength(2500)
  })

  it("已经 abort 的上下文进门就抛,一个进程都不起", async () => {
    const { run } = makeTool(`console.log("should not run")`)
    const context = withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT)
    await expect(run({ command: "x" }, context)).rejects.toThrow("powershell was aborted")
  })

  it("PATH 上没有 pwsh 时报没装,而不是 spawn ENOENT", async () => {
    process.env.PATH = createTempDir()
    await expect(makeTool(undefined).run({ command: "Get-Date" })).rejects.toThrow(POWERSHELL_MISSING)
  })
})

// 真 PowerShell 的往返:非 ASCII 活着回来(三道编码钉子同时成立才会过),进程级 Bypass 生效。
describe.skipIf(process.platform !== "win32")("powershell 工具(真 PowerShell)", () => {
  it("UTF-8 往返", async () => {
    const { run } = makeTool(undefined)
    expect(textOf(await run({ command: "Write-Output 'héllo € 中文'" }))).toBe("héllo € 中文")
  })
})
