/** Windows 使用验收:真系统 PowerShell 5.1、真 native 子进程,不依赖 .cmd 假引擎。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"
import { createPowerShellTool } from "../src/host/tools/powershell/session.ts"
import type { PowerShellDetails, PowerShellInput } from "../src/host/tools/powershell/contract.ts"

const dirs: string[] = []
const spills: string[] = []
const childPids = new Set<number>()
// 在 Electron/Node 产品运行时验工具时,测试用的命令行子程序仍须是 console Node。
// electron.exe 是 GUI 程序,PS 5.1 的 & 调用不等待它,不能拿它冒充编译器。
const nativeNode = process.env.YOMA_TEST_NODE ?? process.execPath
const invocation: AgentHarnessToolInvocation = {
  invocationId: "windows-acceptance",
  operationId: "windows-acceptance",
  turnId: "windows-acceptance",
  getMemo: async () => undefined,
  setMemo: async () => {},
}
function ps(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}
function text(result: AgentToolResult<PowerShellDetails>) {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "yoma-ps-windows-"))
  dirs.push(root)
  const cwd = join(root, "中文 工程 [1] & 引号'")
  mkdirSync(cwd)
  const tool = createPowerShellTool()
  const context = { env: new NodeExecutionEnv({ cwd }) }
  const run = (params: PowerShellInput, signal?: AbortSignal, update: (value: string) => void = () => {}) =>
    tool.execute(
      "windows",
      params,
      (value) => update(text(value)),
      context,
      invocation,
      signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
    )
  return { cwd, run }
}
async function until(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Windows child did not reach the expected state")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const pid of childPids) {
    try {
      process.kill(pid)
    } catch {}
    await until(() => !alive(pid), 2000)
  }
  childPids.clear()
  for (const file of spills.splice(0)) rmSync(file, { force: true })
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe.skipIf(process.platform !== "win32")("Windows PowerShell 使用回归", () => {
  it("不继承 PS7 的同名模块,Get-FileHash 可以自动加载且不改宿主环境", async () => {
    const { cwd, run } = setup()
    const modules = join(cwd, "PS7 Modules")
    const utility = join(modules, "Microsoft.PowerShell.Utility")
    mkdirSync(utility, { recursive: true })
    writeFileSync(join(utility, "Microsoft.PowerShell.Utility.psd1"),
      "@{ ModuleVersion='99.0'; PowerShellVersion='99.0'; RootModule='utility.psm1'; FunctionsToExport=@('Get-FileHash') }")
    writeFileSync(join(utility, "utility.psm1"), "function Get-FileHash { throw 'wrong module loaded' }")
    const inherited = `${modules};${process.env.PSModulePath ?? ""}`
    vi.stubEnv("PSModulePath", inherited)
    vi.stubEnv("YOMA_PS_ENV_MARKER", "retained")
    const file = join(cwd, "hash [1].txt")
    writeFileSync(file, "abc")
    const result = await run({ command: `$ErrorActionPreference='Stop'; @{ hash=(Get-FileHash -LiteralPath ${ps(file)}).Hash; marker=$env:YOMA_PS_ENV_MARKER; modules=$env:PSModulePath } | ConvertTo-Json -Compress` })
    const value = JSON.parse(text(result))
    expect(value.hash).toBe("BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD")
    expect(value.marker).toBe("retained")
    expect(value.modules).not.toContain(modules)
    expect(process.env.PSModulePath).toBe(inherited)
  })

  it("隐藏的 cmdlet 错误仍失败,成功的空结果不误报失败", async () => {
    const { run } = setup()
    await expect(run({ command: "Get-Process yoma-process-that-does-not-exist -ErrorAction SilentlyContinue | Select-Object Name" }))
      .rejects.toThrow("Command exited with code 1")
    const result = await run({ command: "Get-Process | Where-Object ProcessName -eq yoma-process-that-does-not-exist | Select-Object Name" })
    expect(result.details.exitCode).toBe(0)
  })

  it("中文特殊字符路径、UTF-8 文件与多行脚本往返", async () => {
    const { cwd, run } = setup()
    const file = join(cwd, "测量 [1] & '$.txt")
    writeFileSync(file, "héllo € 中文 😀\n第二行", "utf8")
    const result = await run({
      command: `
$content = [string](Get-Content -LiteralPath ${ps(file)} -Raw -Encoding UTF8)
@{ cwd = (Get-Location).Path; content = $content; major = $PSVersionTable.PSVersion.Major } | ConvertTo-Json -Compress`,
    })
    expect(JSON.parse(text(result))).toEqual({ cwd, content: "héllo € 中文 😀\n第二行", major: 5 })
  })

  it("UTF-8 中文能经管道传入外部程序 stdin", async () => {
    const { cwd, run } = setup()
    const file = join(cwd, "stdin.mjs")
    writeFileSync(
      file,
      `let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => text += s); process.stdin.on('end', () => console.log(JSON.stringify(text.trimEnd())))`,
    )
    const result = await run({ command: `${ps("héllo € 中文 😀")} | & ${ps(nativeNode)} ${ps(file)}` })
    expect(JSON.parse(text(result))).toBe("héllo € 中文 😀")
  })

  it("调用外部程序保留中文、空格及字面量 shell 符号", async () => {
    const { cwd, run } = setup()
    const file = join(cwd, "argv.mjs")
    writeFileSync(file, "console.log(JSON.stringify(process.argv.slice(2)))")
    // PS 5.1 的 native 参数引用对带空格的尾部反斜杠有损;工具描述给出 / 或 \\. 的目录写法。
    const args = ["中文 参数", "a&b;[x]", "$HOME $(exit 7)", "C:/测 试/尾部/", "C:\\测 试\\尾部\\."]
    const result = await run({ command: `& ${ps(nativeNode)} ${ps(file)} ${args.map(ps).join(" ")}` })
    expect(JSON.parse(text(result))).toEqual(args)
  })

  it("stderr 宿主流可读,非终止错误与警告没有被 CLIXML 清理吞掉", async () => {
    const { run } = setup()
    const output = text(
      await run({
        command: `$VerbosePreference='Continue'; Write-Verbose '详细 中文'; Write-Warning '警告 中文'; Write-Error '错误 中文'; Write-Output '完成'`,
      }),
    )
    for (const message of ["详细 中文", "警告 中文", "错误 中文", "完成"]) expect(output).toContain(message)
    expect(output).not.toMatch(/CLIXML|<Objs|_x000D_/)
  })

  it("显式外部退出码保留,throw 与交互输入会失败", async () => {
    const { cwd, run } = setup()
    const file = join(cwd, "exit.mjs")
    writeFileSync(file, "console.log('编译失败前的输出'); process.exitCode = 7")
    await expect(run({ command: `& ${ps(nativeNode)} ${ps(file)}; exit $LASTEXITCODE` })).rejects.toThrow(
      /编译失败前的输出[\s\S]*Command exited with code 7/,
    )
    await expect(run({ command: `throw '终止 中文'` })).rejects.toThrow(/终止 中文/)
    await expect(run({ command: "Read-Host 'input'", timeout: 10 })).rejects.toThrow(/Command exited with code 1/)
  }, 20_000)

  it("每次调用重置 cwd 与环境,不污染后续调用", async () => {
    const { cwd, run } = setup()
    await run({ command: "$env:YOMA_PS_ISOLATION_TEST='first'; Set-Location .." })
    const value = JSON.parse(
      text(
        await run({
          command: "@{ cwd=(Get-Location).Path; value=$env:YOMA_PS_ISOLATION_TEST } | ConvertTo-Json -Compress",
        }),
      ),
    )
    expect(value).toEqual({ cwd, value: process.env.YOMA_PS_ISOLATION_TEST ?? null })
  })

  it.skipIf(!process.versions.electron)(
    "GUI 程序用 Start-Process 等待并读取真实退出码",
    async () => {
      const { cwd, run } = setup()
      const script = join(cwd, "gui.mjs")
      const output = join(cwd, "gui-output.txt")
      writeFileSync(
        script,
        `import { writeFileSync } from 'node:fs'; setTimeout(() => { writeFileSync(${JSON.stringify(output)}, 'GUI 已完成\\n' + process.cwd()); process.exitCode = 7 }, 250)`,
      )
      await expect(
        run({
          command: `
$ErrorActionPreference = 'Stop'
$child = Start-Process -FilePath ${ps(process.execPath)} -ArgumentList ${ps(`"${script}"`)} -WorkingDirectory ([WildcardPattern]::Escape(${ps(cwd)})) -Wait -PassThru -WindowStyle Hidden
Get-Content -LiteralPath ${ps(output)} -Encoding UTF8
exit $child.ExitCode`,
        }),
      ).rejects.toThrow(/GUI 已完成[\s\S]*Command exited with code 7/)
      expect(readFileSync(output, "utf8")).toBe(`GUI 已完成\n${cwd}`)
    },
    15_000,
  )

  it("可以运行含中文的 UTF-8 BOM .ps1 文件", async () => {
    const { cwd, run } = setup()
    const script = join(cwd, "脚本 [1].ps1")
    writeFileSync(script, "\uFEFFparam([string]$Value)\nWrite-Output ('脚本:' + $Value)")
    expect(text(await run({ command: `& ${ps(script)} -Value '中文 参数'` }))).toBe("脚本:中文 参数")
  })

  it("运行中先收到第一段输出,最终输出包含第二段", async () => {
    const { run } = setup()
    const updates: string[] = []
    const result = await run(
      { command: "Write-Output 'first'; Start-Sleep -Milliseconds 350; Write-Output 'second'" },
      undefined,
      (value) => updates.push(value),
    )
    expect(updates.some((value) => value.includes("first") && !value.includes("second"))).toBe(true)
    expect(text(result)).toContain("second")
  })

  it("超长输出截尾但全文仍可读取", async () => {
    const { run } = setup()
    const result = await run({ command: "1..2105 | ForEach-Object { '中文行 ' + $_ }" })
    if (result.details.fullOutputPath) spills.push(result.details.fullOutputPath)
    expect(result.details.truncation?.truncated).toBe(true)
    expect(text(result)).toContain("中文行 2105")
    expect(text(result)).not.toContain("中文行 1\r\n")
    expect(readFileSync(result.details.fullOutputPath!, "utf8")).toContain("中文行 1")
  })

  it.each(["timeout", "abort"] as const)(
    "%s 保留部分输出并终止真实子进程",
    async (mode) => {
      const { cwd, run } = setup()
      const script = join(cwd, "child.mjs")
      const ready = join(cwd, "ready.txt")
      const completed = join(cwd, "completed.txt")
      writeFileSync(
        script,
        `import { writeFileSync } from 'node:fs'; console.log('child 已启动'); writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => writeFileSync(${JSON.stringify(completed)}, 'finished'), 5000);`,
      )
      const controller = new AbortController()
      const pending = run(
        { command: `& ${ps(nativeNode)} ${ps(script)}`, timeout: mode === "timeout" ? 3 : 10 },
        controller.signal,
      ).then(
        () => "unexpected success",
        (error: Error) => error.message,
      )
      await until(() => existsSync(ready))
      const pid = Number(readFileSync(ready, "utf8"))
      childPids.add(pid)
      if (mode === "abort") controller.abort()
      const message = await pending
      expect(message).toContain("child 已启动")
      expect(message).toContain(mode === "timeout" ? "timed out" : "was aborted")
      await until(() => !alive(pid), 2000)
      childPids.delete(pid)
      // 等过原定完成时刻;确认后台没有继续工作,不能只断言一次 kill 被调用。
      await new Promise((resolve) => setTimeout(resolve, 5200))
      expect(existsSync(completed)).toBe(false)
    },
    20_000,
  )
})
