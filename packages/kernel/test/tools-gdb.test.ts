/**
 * gdb 工具(host/tools/gdb/{contract,servers,mi-session,target,session}.ts)的验收。纯函数层在 gdb-mi.test.ts /
 * gdb-eval-policy.test.ts,这里是有进程的那一半,四层由假到真:
 *
 * 1. 契约与纯函数:动作 / 确认门 / summary、server argv 与能力表、connect 解析、gdb 二进制定位、镜像校验。
 * 2. **假 gdb**(一段说 MI3 的 JS,由 fixtures/fake-exe.ts 包成可执行文件):按需制造真 gdb 造不出来的病态 ——
 *    乱序、无 token 异步、命令中途 EOF、挂起、裸写 stdout、孤儿孙进程;以及工具壳的整条链
 *    (start → break → exec → 停止报告 → eval → stop / dispose),不接任何目标。
 * 3. 冷启动:没有会话时每个动作说什么。
 * 4. **真 QEMU + 真 gdb**(本机 PATH 上有 qemu-system-arm 与 arm-none-eabi-gdb 时才跑,CI 上跳过并 warn):
 *    对 fixtures/gdb/fixture.elf attach、断点、continue、HardFault 现场解码、单步表、中止、收尸。
 *    cwd 用夹具目录:DWARF 里的编译期路径在别的机器上,正好走一遍源码路径映射。
 */

import { execSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { claimProbe, probeLockFile, releaseProbe } from "../src/host/domain/engines.ts"
import { bindExecutionEnv } from "../src/host/domain/execution-env.ts"
import { ELF_MACHINE, RUN_CONTROL_OPS } from "../src/host/domain/gdb/index.ts"
import { confirmNeeded } from "../src/host/tools/contracts.ts"
import { FLASH_STATE_FILE, readFlashState, sha256File } from "../src/host/tools/flash/session.ts"
import {
  EXEC_OPS,
  GDB_ACTIONS,
  GDB_CONTRACT,
  type GdbDetails,
  type GdbInput,
  gdbSummary,
} from "../src/host/tools/gdb/contract.ts"
import { GdbSession } from "../src/host/tools/gdb/mi-session.ts"
import {
  buildServerArgv,
  findOnPath,
  parseConnect,
  pickFreePort,
  SERVER_CAPS,
  serverBinary,
} from "../src/host/tools/gdb/servers.ts"
import { createGdbTool, type GdbTool } from "../src/host/tools/gdb/session.ts"
import { displayFrame, elfMachineOf, locationOf, resolveGdbPath, verifyImage } from "../src/host/tools/gdb/target.ts"
import { fakeExeName, writeFakeExe } from "./fixtures/fake-exe.ts"

// ─── 脚手架 ──────────────────────────────────────────────────────────────────

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "gdb")
const FIXTURE_ELF = join(FIXTURE_DIR, "fixture.elf")

const tempDirs: string[] = []
const openSessions: GdbSession[] = []
const openTools: GdbTool[] = []

function createTempDir(prefix = "yoma-gdb-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const tool of openTools.splice(0)) await tool.dispose().catch(() => undefined)
  for (const session of openSessions.splice(0)) await session.stop().catch(() => undefined)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(join(FIXTURE_DIR, ".yoma"), { recursive: true, force: true })
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

type Update = (partial: AgentToolResult<GdbDetails>) => void

function makeTool(cwd: string, gdbPath?: string) {
  const tool = createGdbTool(gdbPath ? { gdbPath } : {})
  openTools.push(tool)
  const run = (params: GdbInput, context: Context = BACKGROUND_CONTEXT, onUpdate: Update = () => {}) =>
    tool.execute("c1", params, onUpdate, { env: new NodeExecutionEnv({ cwd }) }, invocation, context)
  return { tool, run }
}

function textOf(result: AgentToolResult<GdbDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

/** 探针锁落到临时文件:别让这些用例和开发机上真实的 ~/.yoma/probe.lock 互相污染。 */
process.env.YOMA_PROBE_LOCK = join(tmpdir(), `yoma-probe-gdb-${process.pid}.lock`)

/**
 * 假 gdb:说 MI3。`-fake-*` 那组是给 GdbSession 层的病态;其余按真 gdb 的形状回复,让工具壳整条链跑得起来。
 * 运行时行为(continue 之后停不停、interrupt 理不理)从 mode 文件读,测试随时改。
 */
function writeFakeGdb(dir: string): { gdbPath: string; setMode: (mode: Record<string, unknown>) => void } {
  const modeFile = join(dir, "mode.json")
  writeFileSync(modeFile, "{}")
  const js = String.raw`import { spawn } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
const MODE = ${JSON.stringify(modeFile)}
const CMDLOG = ${JSON.stringify(join(dir, "commands.log"))}
const PIDFILE = ${JSON.stringify(join(dir, "gdb.pid"))}
const mode = () => { try { return JSON.parse(readFileSync(MODE, "utf8")) } catch { return {} } }
writeFileSync(PIDFILE, String(process.pid))
writeFileSync(${JSON.stringify(join(dir, "gdb-env.json"))}, JSON.stringify({ marker: process.env.YOMA_ENV_TEST }))
let buf = ""
const out = (s) => process.stdout.write(s)
out('=thread-group-added,id="i1"\n(gdb) \n')
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    handle(line)
  }
})
process.stdin.on("end", () => process.exit(0))
const FRAME = 'frame={addr="0x08000280",func="main",args=[],file="main.c",fullname="/nowhere/main.c",line="150"}'
let temporary = false
function handle(line) {
  const m = /^(\d+)(.*)$/.exec(line)
  if (!m) return
  const token = m[1]
  const cmd = m[2]
  appendFileSync(CMDLOG, cmd + "\n")
  const done = (rest) => out(token + "^done" + (rest || "") + "\n(gdb) \n")
  if (cmd === "-gdb-exit") { out(token + "^exit\n"); process.exit(0) }
  else if (cmd === "-gdb-show mi-async") done(mode().miAsync === "off" ? ',value="off"' : ',value="on"')
  else if (cmd.startsWith("-gdb-set")) done()
  else if (cmd === "-fake-console") out('~"hello "\n~"world\\n"\n' + token + "^done\n(gdb) \n")
  else if (cmd === "-fake-error") out(token + '^error,msg="No symbol \\"x\\" in current context."\n(gdb) \n')
  else if (cmd === "-fake-slow") { /* 永不回复 */ }
  else if (cmd === "-fake-stop") {
    // 真实顺序:异步记录先到,结果记录后到
    out('*stopped,reason="breakpoint-hit",bkptno="2",frame={addr="0x08001a3e",func="ring_push",args=[],file="uart.c",line="37"},thread-id="1"\n')
    out(token + "^done\n(gdb) \n")
  }
  else if (cmd === "-fake-double") out(token + "^running\n(gdb) \n" + token + '^error,msg="Command aborted."\n(gdb) \n')
  else if (cmd === "-fake-wrong-token") out("99999^done\n(gdb) \n" + token + "^done\n(gdb) \n")
  else if (cmd === "-fake-foreign") out("r0             0x0                 0\n" + token + "^done\n(gdb) \n")
  else if (cmd === "-fake-chunked") {
    const big = "x".repeat(40000)
    out(token + '^done,value="' + big.slice(0, 10000))
    setTimeout(() => out(big.slice(10000, 25000)), 5)
    setTimeout(() => out(big.slice(25000) + '"\n(gdb) \n'), 10)
  }
  else if (cmd.startsWith("-fake-grandchild ")) {
    const pidfile = cmd.slice("-fake-grandchild ".length)
    const kid = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" })
    writeFileSync(pidfile, String(kid.pid))
    out(token + "^done\n(gdb) \n")
  }
  else if (cmd === "-fake-die") process.exit(3)
  else if (cmd === "-fake-exited") {
    out('=thread-exited,id="1",group-id="i1"\n=thread-group-exited,id="i1",exit-code="0"\n')
    out(token + "^done\n(gdb) \n")
  }
  else if (cmd.startsWith("-target-select")) {
    if (mode().connect === "refuse") { out(token + '^error,msg="localhost:1: Connection refused."\n(gdb) \n'); return }
    out('*stopped,frame={addr="0x08000274",func="Reset_Handler",args=[],file="main.c",fullname="/nowhere/main.c",line="287"},thread-id="1",stopped-threads="all"\n')
    out(token + "^connected\n(gdb) \n")
  }
  else if (cmd.startsWith("-file-exec-and-symbols")) done()
  else if (cmd === "-file-list-exec-source-files") {
    const src = mode().sources
    done(src ? ',files=[{file="main.c",fullname="' + src + '",debug-fully-read="true"}]' : ",files=[]")
  }
  else if (cmd.startsWith("-data-read-memory-bytes")) out(token + '^error,msg="Cannot access memory at address 0xe000ed00"\n(gdb) \n')
  else if (cmd.startsWith("-break-insert")) {
    const at = cmd.split(" ").pop()
    if (at === "nope") { out(token + '^error,msg="Function \\"nope\\" not defined."\n(gdb) \n'); return }
    temporary = cmd.split(" ").includes("-t")
    done(',bkpt={number="1",type="breakpoint",disp="' + (temporary ? "del" : "keep") + '",enabled="y",addr="0x08000274",func="' + at + '",file="main.c",fullname="/nowhere/main.c",line="148",thread-groups=["i1"],times="0",original-location="' + at + '"}')
  }
  else if (cmd.startsWith("-break-delete")) done()
  // 真 gdb 对软件与硬件的写观察点都回 wpt=;硬/软只在 -break-info 的 type 里
  else if (cmd.startsWith("-break-watch")) done(',wpt={number="2",exp="g_state"}')
  else if (cmd.startsWith("-break-info")) {
    const n = cmd.split(" ")[1]
    done(',BreakpointTable={nr_rows="1",nr_cols="6",hdr=[],body=[bkpt={number="' + n + '",type="' + (mode().watchType || "hw watchpoint") + '",disp="keep",enabled="y",what="g_state"}]}')
  }
  else if (/^-exec-(continue|next|step|finish|step-instruction)$/.test(cmd)) {
    out(token + "^running\n(gdb) \n" + '*running,thread-id="all"\n')
    const m2 = mode()
    if (m2.resume === "hang") return
    const delay = m2.stopAfterMs === undefined ? 30 : m2.stopAfterMs
    if (m2.resume === "exit") {
      // 目标跑完退出:没有 *stopped,只有这两条通知(真 gdb 实测)
      setTimeout(() => out('=thread-exited,id="1",group-id="i1"\n=thread-group-exited,id="i1",exit-code="0"\n'), delay)
      return
    }
    const reason = cmd === "-exec-continue"
      ? 'reason="breakpoint-hit",disp="' + (temporary ? "del" : "keep") + '",bkptno="1"'
      : cmd === "-exec-finish"
        ? 'reason="function-finished"' + (m2.finishValue === undefined ? "" : ',gdb-result-var="$1",return-value="' + m2.finishValue + '"')
        : 'reason="end-stepping-range"'
    setTimeout(() => {
      out("*stopped," + reason + "," + FRAME + ',thread-id="1",stopped-threads="all"\n')
      // 临时断点命中后 gdb 自己删掉它(真 gdb 实测的顺序:*stopped 之后紧跟 =breakpoint-deleted)
      if (temporary && cmd === "-exec-continue") { out('=breakpoint-deleted,id="1"\n'); temporary = false }
    }, delay)
  }
  else if (cmd === "-exec-interrupt") {
    done()
    if (mode().interrupt === "ignore") return
    setTimeout(() => out('*stopped,reason="signal-received",signal-name="SIGINT",frame={addr="0x08000290",func="loop",args=[],file="main.c",fullname="/nowhere/main.c",line="160"},thread-id="1",stopped-threads="all"\n'), 20)
  }
  else if (cmd.startsWith("-stack-list-frames")) done(',stack=[frame={level="0",addr="0x08000280",func="main",file="main.c",fullname="/nowhere/main.c",line="150"}]')
  else if (cmd.startsWith("-stack-list-variables")) done(',variables=[{name="i",value="3"},{name="cfg",type="gpio_cfg_t"},{name="p",value="<optimized out>"}]')
  else if (cmd.startsWith("-data-evaluate-expression")) done(',value="42"')
  else if (cmd.startsWith("-interpreter-exec console")) {
    if (cmd.includes("nosuch")) { out(token + '^error,msg="No symbol \\"nosuch\\" in current context."\n(gdb) \n'); return }
    if (cmd.includes("monitor reset")) {
      // OpenOCD 的失败不走 ^error:当普通文本吐在 ^done 下面(审稿实测)
      out('~"' + (mode().reset === "fail" ? "Error: timed out while waiting for target halted" : "target halted due to debug-request, current mode: Thread") + '\\n"\n')
      done()
      return
    }
    out('~"$1 = 2\\n"\n')
    done()
  }
  else done()
}
`
  const gdbPath = writeFakeExe(dir, "fake-gdb", js)
  return { gdbPath, setMode: (mode) => writeFileSync(modeFile, JSON.stringify(mode)) }
}

/** 假 gdb 收到过的命令(不含 token),按序。 */
function fakeCommands(dir: string): string[] {
  const file = join(dir, "commands.log")
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 假 openocd:打 OpenOCD 的就绪串、真的在 gdb 端口上听(waitForServerReady 要 TCP 探到)、写下自己的 pid、
 * 活到被杀 —— gdb 退出它也不退,正好检验 stop / 崩溃重起 / 宿主退出会不会收它。
 */
function installFakeOpenocd(dir: string): { pidFile: string } {
  const pidFile = join(dir, "openocd.pid")
  writeFakeExe(
    dir,
    "openocd",
    String.raw`import net from "node:net"
import { writeFileSync } from "node:fs"
const c = process.argv.indexOf("-c")
const port = Number(/gdb_port (\d+)/.exec(process.argv[c + 1])[1])
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
writeFileSync(${JSON.stringify(join(dir, "server-env.json"))}, JSON.stringify({ marker: process.env.YOMA_ENV_TEST }))
const srv = net.createServer((sock) => sock.on("error", () => {}))
srv.listen(port, "127.0.0.1", () => console.error("Info : Listening on port " + port + " for gdb connections"))
setInterval(() => {}, 1000)
`,
  )
  return { pidFile }
}

function makeSession(dir: string, gdbPath: string): GdbSession {
  const session = new GdbSession({
    gdbPath,
    cwd: dir,
    logFile: join(dir, "s.log"),
    miFile: join(dir, "s.mi"),
    stopsFile: join(dir, "s.jsonl"),
  })
  openSessions.push(session)
  return session
}

async function fakeSession(): Promise<{
  session: GdbSession
  dir: string
  setMode: (m: Record<string, unknown>) => void
}> {
  const dir = createTempDir()
  const { gdbPath, setMode } = writeFakeGdb(dir)
  const session = makeSession(dir, gdbPath)
  await session.spawnGdb()
  return { session, dir, setMode }
}

// ─── 第一层:契约与纯函数 ─────────────────────────────────────────────────────

describe("契约", () => {
  it("六个动作都在 schema 的 union 里;exec 的 op 覆盖 eval 闸门会转发的每一个", () => {
    const union = (GDB_CONTRACT.parameters.properties.action as { anyOf: { const: string }[] }).anyOf.map(
      (x) => x.const,
    )
    expect(union).toEqual([...GDB_ACTIONS])
    for (const op of RUN_CONTROL_OPS) expect(EXEC_OPS).toContain(op)
  })

  it("确认门按效果判:写目标的 eval、起探针程序的 start、复位的 exec 问;其余不问;描述里一个字都不提确认", () => {
    expect(confirmNeeded("gdb", { action: "eval", command: "monitor reset halt", write: true })?.label).toBe("调试器")
    expect(confirmNeeded("gdb", { action: "eval", command: "monitor reset halt" })).toBeUndefined()
    expect(confirmNeeded("gdb", { action: "exec", op: "reset-halt" })?.label).toBe("调试器")
    expect(confirmNeeded("gdb", { action: "exec", op: "reset-run" })?.label).toBe("调试器")
    expect(confirmNeeded("gdb", { action: "exec", op: "continue" })).toBeUndefined()
    expect(confirmNeeded("gdb", { action: "start", server: "jlink", chip: "STM32G431CB" })?.label).toBe("调试器")
    expect(confirmNeeded("gdb", { action: "start", server: "openocd", config: ["x.cfg"] })?.label).toBe("调试器")
    expect(confirmNeeded("gdb", { action: "start", server: "qemu", machine: "m" })).toBeUndefined()
    expect(confirmNeeded("gdb", { action: "start", connect: "localhost:3333" })).toBeUndefined()
    expect(confirmNeeded("gdb", { action: "break", at: "main" })).toBeUndefined()
    expect(GDB_CONTRACT.description).not.toMatch(/confirm|ask the user|permission/i)
  })

  it("summary 在参数还没拼完时也给得出话", () => {
    expect(gdbSummary({ action: "start", server: "openocd", elfPath: "build/fw.elf" })).toBe(
      "start openocd build/fw.elf",
    )
    expect(gdbSummary({ action: "start", connect: "localhost:3333" })).toBe("start connect localhost:3333")
    expect(gdbSummary({ action: "start" })).toBe("start")
    expect(gdbSummary({ action: "break", at: "main.c:42", condition: "x > 1" })).toBe("break at main.c:42 if x > 1")
    expect(gdbSummary({ action: "break", watch: "g_state", mode: "rw" })).toBe("break watch g_state (rw)")
    expect(gdbSummary({ action: "break", remove: "all" })).toBe("break remove all")
    expect(gdbSummary({ action: "break" })).toBe("break")
    expect(gdbSummary({ action: "exec" })).toBe("exec continue")
    expect(gdbSummary({ action: "exec", op: "next", count: 3 })).toBe("exec next ×3")
    expect(gdbSummary({ action: "eval", command: "p x", write: true })).toBe("eval p x (write)")
    expect(gdbSummary({ action: "eval" })).toBe("eval")
    expect(gdbSummary({ action: "stop" })).toBe("stop")
    expect(gdbSummary({})).toBe("")
  })
})

describe("项目执行环境", () => {
  it("GDB选择、server选择与两次spawn使用同一份项目快照,不污染宿主PATH", async () => {
    const originalPath = process.env.PATH
    for (const marker of ["project-A", "project-B"]) {
      const cwd = createTempDir()
      const { gdbPath } = writeFakeGdb(cwd)
      installFakeOpenocd(cwd)
      const variables: NodeJS.ProcessEnv = { ...process.env, YOMA_GDB: gdbPath, YOMA_ENV_TEST: marker }
      const pathKey = Object.keys(variables).find((key) => key.toLowerCase() === "path") ?? "PATH"
      variables[pathKey] = cwd + delimiter + (variables[pathKey] ?? "")
      const env = bindExecutionEnv(new NodeExecutionEnv({ cwd, shellEnv: variables }), variables)
      const tool = createGdbTool()
      openTools.push(tool)
      await tool.execute(
        "start",
        { action: "start", server: "openocd", config: ["fake.cfg"], elfPath: FIXTURE_ELF },
        () => {},
        { env },
        invocation,
        BACKGROUND_CONTEXT,
      )
      expect(JSON.parse(readFileSync(join(cwd, "gdb-env.json"), "utf8"))).toEqual({ marker })
      expect(JSON.parse(readFileSync(join(cwd, "server-env.json"), "utf8"))).toEqual({ marker })
      await tool.dispose()
    }
    expect(process.env.PATH).toBe(originalPath)
  }, 30_000)
})

describe("buildServerArgv", () => {
  it("qemu", () => {
    expect(buildServerArgv({ server: "qemu", port: 4242, machine: "netduinoplus2", elfPath: "/tmp/a.elf" })).toEqual([
      "qemu-system-arm",
      "-machine",
      "netduinoplus2",
      "-kernel",
      "/tmp/a.elf",
      "-semihosting-config",
      "enable=on,target=native",
      "-nographic",
      "-serial",
      "none",
      "-monitor",
      "none",
      "-S",
      "-gdb",
      "tcp::4242",
    ])
  })

  it("openocd 把每个 config 展开成一个 -f,并把 gdb 端口写死", () => {
    expect(
      buildServerArgv({ server: "openocd", port: 3333, config: ["interface/stlink.cfg", "target/stm32g4x.cfg"] }),
    ).toEqual(["openocd", "-f", "interface/stlink.cfg", "-f", "target/stm32g4x.cfg", "-c", "gdb_port 3333"])
  })

  it("jlink 用 -device 接芯片名并静默起服", () => {
    const argv = buildServerArgv({ server: "jlink", port: 2331, chip: "STM32G431CB" })
    expect(argv).toContain("-nogui")
    expect(argv).toContain("STM32G431CB")
    expect(argv).toContain("2331")
  })

  it("external 不起进程", () => {
    expect(buildServerArgv({ server: "external", port: 3333 })).toEqual([])
  })

  it("缺参数时的报错要说清楚缺什么", () => {
    expect(() => buildServerArgv({ server: "openocd", port: 1 })).toThrow(/needs config/)
    expect(() => buildServerArgv({ server: "jlink", port: 1 })).toThrow(/needs chip/)
    expect(() => buildServerArgv({ server: "qemu", port: 1 })).toThrow(/needs machine/)
    expect(() => buildServerArgv({ server: "qemu", port: 1, machine: "m" })).toThrow(/needs elfPath/)
  })

  it("server 二进制按候选名在 PATH 上找,J-Link 优先命令行版;一个都没有就用第一个名字让 ENOENT 说话", () => {
    const dir = createTempDir()
    writeFakeExe(dir, "JLinkGDBServer", "")
    expect(serverBinary("jlink", { PATH: dir })).toBe(join(dir, fakeExeName("JLinkGDBServer")))
    writeFakeExe(dir, "JLinkGDBServerCLExe", "")
    expect(serverBinary("jlink", { PATH: dir })).toBe(join(dir, fakeExeName("JLinkGDBServerCLExe")))
    expect(serverBinary("openocd", { PATH: dir })).toBe("openocd")
  })
})

describe("服务器能力表", () => {
  it("QEMU 的观察点会挂死模拟器,所以标成不支持;也没有就绪串,只能轮询端口", () => {
    expect(SERVER_CAPS.qemu.watchpoints).toBe("none")
    expect(SERVER_CAPS.qemu.readyRe).toBeUndefined()
    expect(SERVER_CAPS.qemu.rttHint).toBeUndefined()
  })

  it("OpenOCD 的就绪串只认 gdb 那一行 —— 4444/6666 会在目标没连上时先绑好", () => {
    const re = SERVER_CAPS.openocd.readyRe!
    expect(re.test("Info : Listening on port 3333 for gdb connections")).toBe(true)
    expect(re.test("Info : Listening on port 4444 for telnet connections")).toBe(false)
  })

  it("能持探针的 server 都带 RTT 指路", () => {
    expect(SERVER_CAPS.jlink.rttHint).toContain("19021")
    expect(SERVER_CAPS.openocd.rttHint).toContain("rtt server start")
  })
})

describe("parseConnect / pickFreePort", () => {
  it("三种写法都收;裸端口不会被贪婪成 host 909 + port 0(阁楼的坑)", () => {
    expect(parseConnect("localhost:3333")).toEqual({ host: "localhost", port: 3333 })
    expect(parseConnect(":1234")).toEqual({ host: "localhost", port: 1234 })
    expect(parseConnect("192.168.1.5:2331")).toEqual({ host: "192.168.1.5", port: 2331 })
    expect(parseConnect("9090")).toEqual({ host: "localhost", port: 9090 })
  })

  it("坏的写法要报错而不是默默连错地方", () => {
    for (const bad of ["not a port", "localhost:", "host:0", "host:70000", ""]) {
      expect(() => parseConnect(bad), bad).toThrow(/could not parse/)
    }
  })

  it("端口是内核分配的,两个会话可以并存", async () => {
    const a = await pickFreePort()
    const b = await pickFreePort()
    expect(a).toBeGreaterThan(1024)
    expect(b).toBeGreaterThan(1024)
  })
})

describe("gdb 二进制与 ELF", () => {
  it("显式路径 > YOMA_GDB > 按架构在 PATH 上找;找不到时指向工具链,不指向 engines:build", () => {
    expect(resolveGdbPath(ELF_MACHINE.ARM, "/opt/gdb").gdbPath).toBe("/opt/gdb")
    expect(resolveGdbPath(undefined, undefined, { YOMA_GDB: "/opt/mygdb", PATH: "" }).gdbPath).toBe("/opt/mygdb")
    const dir = createTempDir()
    writeFakeExe(dir, "arm-none-eabi-gdb", "")
    writeFakeExe(dir, "gdb", "")
    expect(resolveGdbPath(ELF_MACHINE.ARM, undefined, { PATH: dir }).gdbPath).toBe(
      join(dir, fakeExeName("arm-none-eabi-gdb")),
    )
    expect(resolveGdbPath(ELF_MACHINE.RISCV, undefined, { PATH: dir }).gdbPath).toBe(join(dir, fakeExeName("gdb")))
    expect(() => resolveGdbPath(ELF_MACHINE.ARM, undefined, { PATH: createTempDir() })).toThrow(
      /tried arm-none-eabi-gdb, gdb-multiarch, gdb on PATH[\s\S]*toolchain install[\s\S]*Do NOT run[\s\S]*not an engine/,
    )
  })

  it("从真 ELF 的头认出 ARM;不是 ELF 或读不到就是 undefined", async () => {
    expect(await elfMachineOf(FIXTURE_ELF)).toBe(ELF_MACHINE.ARM)
    const dir = createTempDir()
    const notElf = join(dir, "x.bin")
    writeFileSync(notElf, "hello")
    expect(await elfMachineOf(notElf)).toBeUndefined()
    expect(await elfMachineOf(join(dir, "missing.elf"))).toBeUndefined()
  })

  it("locationOf 只在文件真在本机时才给编辑器位置", () => {
    expect(locationOf({ func: "main", fullname: join(FIXTURE_DIR, "main.c"), line: "148" })).toEqual({
      path: join(FIXTURE_DIR, "main.c"),
      line: 148,
    })
    expect(locationOf({ func: "main", fullname: "/nowhere/main.c", line: "148" })).toBeUndefined()
    expect(locationOf({ func: "main", fullname: FIXTURE_DIR, line: "1" })).toBeUndefined()
    expect(locationOf({ func: "main", line: "148" })).toBeUndefined()
    expect(locationOf(undefined)).toBeUndefined()
  })

  it("displayFrame:映射后的 fullname 在工程根底下就用它(相对化),否则退回 file", () => {
    const frame = { func: "main", file: "/build-host/src/main.c", fullname: join(FIXTURE_DIR, "main.c"), line: "1" }
    expect(displayFrame(frame, FIXTURE_DIR).file).toBe("main.c")
    expect(displayFrame({ ...frame, fullname: "/elsewhere/main.c" }, FIXTURE_DIR).file).toBe("/build-host/src/main.c")
    expect(displayFrame({ ...frame, fullname: undefined, file: join(FIXTURE_DIR, "a", "b.c") }, FIXTURE_DIR).file).toBe(
      join("a", "b.c"),
    )
  })
})

describe("verifyImage", () => {
  it("没有烧录记录:放行但标 UNVERIFIED;记录匹配:verified;不匹配:拒", async () => {
    const cwd = createTempDir()
    const none = await verifyImage(cwd, FIXTURE_ELF)
    expect(none.ok).toBe(true)
    expect(none.note).toContain("UNVERIFIED")

    mkdirSync(join(cwd, ".yoma"), { recursive: true })
    const good = { elfPath: FIXTURE_ELF, sha256: await sha256File(FIXTURE_ELF), at: Date.now() - 120_000 }
    writeFileSync(join(cwd, FLASH_STATE_FILE), JSON.stringify(good))
    const ok = await verifyImage(cwd, FIXTURE_ELF)
    expect(ok.ok).toBe(true)
    expect(ok.note).toMatch(/verified against the last flash \(\d+ min ago\)/)

    writeFileSync(
      join(cwd, FLASH_STATE_FILE),
      JSON.stringify({ ...good, sha256: "0".repeat(64), elfPath: "/other/fw.elf" }),
    )
    const bad = await verifyImage(cwd, FIXTURE_ELF)
    expect(bad.ok).toBe(false)
    expect(bad.note).toContain("MISMATCH")
    expect(bad.note).toContain("/other/fw.elf")
  })
})

// ─── 第二层:假 gdb ──────────────────────────────────────────────────────────
// 假 gdb 靠一份 POSIX shell 包装脚本维持进程组语义;Windows 没有 chmod/sh,这一层只在 Linux/mac 上跑。

const describeFakeGdb = process.platform === "win32" ? describe.skip : describe

describeFakeGdb("GdbSession(假 gdb)", () => {
  it("启动握手全部通过,并且回读校验 mi-async", async () => {
    const { session } = await fakeSession()
    await session.hygiene()
    expect(session.running).toBe(true)
  })

  it("mi-async 设不上就拒绝启动 —— 否则第一条 continue 之后 gdb 不再读 stdin", async () => {
    const { session, setMode } = await fakeSession()
    setMode({ miAsync: "off" })
    await expect(session.hygiene()).rejects.toThrow(/mi-async/)
  })

  it("收集 console 流并拼成一条输出", async () => {
    const { session } = await fakeSession()
    const r = await session.send("-fake-console")
    expect(r.class).toBe("done")
    expect(r.output).toBe("hello world\n")
  })

  it("^error 不是异常,是数据", async () => {
    const { session } = await fakeSession()
    const r = await session.send("-fake-error")
    expect(r.class).toBe("error")
    expect(r.raw).toContain("No symbol")
  })

  it("异步 *stopped 先于结果记录到达时,waiter 照样命中", async () => {
    const { session } = await fakeSession()
    const waiter = session.expectStop()
    await session.send("-fake-stop")
    const stopped = await waiter
    expect(stopped?.class).toBe("stopped")
    expect(session.state).toBe("halted")
    expect(session.lastStop?.reason).toBe("breakpoint-hit")
    expect(session.lastStop?.bkptno).toBe("2")
    expect(session.lastStop?.frame?.func).toBe("ring_push")
  })

  it("目标跑完退出时没有 *stopped,只有 =thread-group-exited —— 等停的一方也要被叫醒", async () => {
    const { session } = await fakeSession()
    const waiter = session.expectStop()
    await session.send("-fake-exited")
    await waiter
    expect(session.state).toBe("exited")
    expect(session.lastStop?.reason).toBe("exited with code 0")
  })

  it("一个 token 收到两条 ^ 记录时只 resolve 一次,不产生未处理的 rejection", async () => {
    const { session } = await fakeSession()
    const r = await session.send("-fake-double")
    expect(r.class).toBe("running")
    const next = await session.send("-fake-console")
    expect(next.output).toBe("hello world\n")
  })

  it("token 对不上的结果记录被丢弃,不会污染下一条命令", async () => {
    const { session } = await fakeSession()
    const r = await session.send("-fake-wrong-token")
    expect(r.class).toBe("done")
  })

  it("非 MI 的裸行不会让解析崩掉,而且记进转录", async () => {
    const { session, dir } = await fakeSession()
    const r = await session.send("-fake-foreign")
    expect(r.class).toBe("done")
    expect(readFileSync(join(dir, "s.log"), "utf8")).toContain("[foreign]")
  })

  it("40000 字符的 record 分三段到达也要还原成一条", async () => {
    const { session } = await fakeSession()
    const r = await session.send("-fake-chunked")
    expect(r.class).toBe("done")
    expect(String(r.results?.value)).toHaveLength(40000)
  })

  it("不回复的命令按超时收场,而不是永远挂着;超时之后队列没坏", async () => {
    const { session } = await fakeSession()
    await expect(session.send("-fake-slow", 200)).rejects.toThrow(/did not answer/)
    expect((await session.send("-fake-console")).output).toBe("hello world\n")
  })

  it("gdb 中途死掉时,在飞的命令被拒绝而不是永远挂着", async () => {
    const { session } = await fakeSession()
    const dead = session.send("-fake-die", 5_000).catch((e: Error) => e.message)
    expect(await dead).toMatch(/gdb (exited|is not running)|did not answer/)
    expect(session.running).toBe(false)
  })

  it("命令严格串行:交叉发出的两条命令各自拿到自己的回复", async () => {
    const { session } = await fakeSession()
    const [a, b] = await Promise.all([session.send("-fake-console"), session.send("-fake-error")])
    expect(a.output).toBe("hello world\n")
    expect(b.class).toBe("error")
  })

  it("stop 之后杀掉整个进程组 —— 孙进程不能变孤儿", async () => {
    const { session, dir } = await fakeSession()
    const pidfile = join(dir, "kid.pid")
    await session.send(`-fake-grandchild ${pidfile}`)
    const kid = Number(readFileSync(pidfile, "utf8"))
    expect(kid).toBeGreaterThan(0)
    expect(() => process.kill(kid, 0)).not.toThrow()
    await session.stop()
    await new Promise((r) => setTimeout(r, 300))
    await expect
      .poll(() => {
        try {
          process.kill(kid, 0)
          // Linux orphan zombies still have a PID, but no longer execute or hold devices.
          if (process.platform === "linux") {
            return /\) Z /.test(readFileSync(`/proc/${kid}/stat`, "utf8"))
          }
          return false
        } catch (error) {
          return ["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")
        }
      })
      .toBe(true)
  })

  it("停止事件逐行落进 stops jsonl —— 自动压缩之后还查得到", async () => {
    const { session, dir } = await fakeSession()
    const waiter = session.expectStop()
    await session.send("-fake-stop")
    await waiter
    await session.stop()
    const rows = readFileSync(join(dir, "s.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ n: 1, reason: "breakpoint-hit", func: "ring_push", file: "uart.c", line: "37" })
  })

  it("stop 之后再 send 是明确的拒绝,不是挂着", async () => {
    const { session } = await fakeSession()
    await session.stop()
    await expect(session.send("-fake-console")).rejects.toThrow(/not running/)
  })
})

// ─── 第三层:冷启动 ──────────────────────────────────────────────────────────

describe("gdb 工具 — 冷启动(不需要任何二进制)", () => {
  it("没有会话时 status 是数据,不是异常", async () => {
    const { run } = makeTool(createTempDir())
    const r = await run({ action: "status" })
    expect(textOf(r)).toContain("no session")
    expect(r.details?.state).toBe("no-session")
  })

  it("没有会话时其他动作报错要带上填好的下一步调用", async () => {
    const { run } = makeTool(createTempDir())
    await expect(run({ action: "eval", command: "p 1" })).rejects.toThrow(/server:"qemu"/)
    await expect(run({ action: "break", at: "main" })).rejects.toThrow(/action:"start"/)
  })

  it("start 缺 elfPath 时说明为什么非要不可", async () => {
    const { run } = makeTool(createTempDir())
    await expect(run({ action: "start", server: "qemu", machine: "m" })).rejects.toThrow(/needs elfPath/)
  })

  it("同时给 server 和 connect 时不猜,而是说清楚两者选一;既没有 server 也没有 connect 同理", async () => {
    const { run } = makeTool(createTempDir())
    await expect(
      run({ action: "start", server: "openocd", connect: "localhost:3333", elfPath: FIXTURE_ELF }),
    ).rejects.toThrow(/Pass server to launch one, or connect alone/)
    await expect(run({ action: "start", elfPath: FIXTURE_ELF })).rejects.toThrow(/either connect/)
  })

  it("ELF 不存在;server 参数不全的报错在拿探针之前就发出", async () => {
    const cwd = createTempDir()
    const { run } = makeTool(cwd)
    await expect(
      run({ action: "start", server: "qemu", machine: "m", elfPath: join(cwd, "nope.elf") }),
    ).rejects.toThrow(/ELF file not found/)
    await expect(run({ action: "start", server: "openocd", elfPath: FIXTURE_ELF })).rejects.toThrow(/needs config/)
    expect(existsSync(probeLockFile())).toBe(false)
  })

  it("stop 在没有会话时也不报错", async () => {
    const { run } = makeTool(createTempDir())
    expect(textOf(await run({ action: "stop" }))).toContain("no gdb session")
  })
})

// ─── 第二层(续):工具壳 + 假 gdb,整条链 ──────────────────────────────────

describeFakeGdb("gdb 工具 + 假 gdb", () => {
  async function attached(mode: Record<string, unknown> = {}) {
    const cwd = createTempDir()
    const { gdbPath, setMode } = writeFakeGdb(cwd)
    setMode(mode)
    const { tool, run } = makeTool(cwd, gdbPath)
    const started = await run({
      action: "start",
      connect: "localhost:3333",
      elfPath: FIXTURE_ELF,
      allowUnverified: true,
    })
    return { cwd, tool, run, setMode, started }
  }

  it("start:attach、认不出 Cortex-M 时说清楚、UNVERIFIED 镜像照常放行", async () => {
    const { started } = await attached()
    const text = textOf(started)
    expect(text).toContain("attached to localhost:3333 via external")
    expect(text).toContain("not a Cortex-M")
    expect(text).toContain("UNVERIFIED")
    expect(text).toContain("halted (initial attach)")
    expect(started.details).toMatchObject({ action: "start", state: "halted", epoch: 1, stopId: 1 })
    // 编译期路径 /nowhere/main.c 在本机不存在:不给编辑器位置
    expect(started.details?.path).toBeUndefined()
  })

  it("start:编译期路径本机不存在时按后缀映射到工程目录,并真的发了 set substitute-path", async () => {
    const cwd = createTempDir()
    mkdirSync(join(cwd, "src"), { recursive: true })
    writeFileSync(join(cwd, "src", "main.c"), "int main(void) { return 0; }\n")
    const { gdbPath, setMode } = writeFakeGdb(cwd)
    setMode({ sources: "/build-host/proj/src/main.c" })
    const { run } = makeTool(cwd, gdbPath)
    const r = await run({ action: "start", connect: "localhost:3333", elfPath: FIXTURE_ELF, allowUnverified: true })
    expect(textOf(r)).toContain(
      `source paths: 1 of 1 compile-time paths do not exist here; mapped /build-host/proj → ${cwd}`,
    )
    expect(fakeCommands(cwd)).toContain(`-interpreter-exec console "set substitute-path /build-host/proj ${cwd}"`)
  })

  it("start:编译期路径本机不存在也映射不上时明说,行号不能当真", async () => {
    const cwd = createTempDir()
    const { gdbPath, setMode } = writeFakeGdb(cwd)
    setMode({ sources: "/build-host/proj/src/main.c" })
    const { run } = makeTool(cwd, gdbPath)
    const r = await run({ action: "start", connect: "localhost:3333", elfPath: FIXTURE_ELF, allowUnverified: true })
    expect(textOf(r)).toContain("could not be mapped")
    expect(fakeCommands(cwd).some((c) => c.includes("substitute-path"))).toBe(false)
  })

  it("start:镜像与烧录记录不符时拒绝并把会话收掉;allowUnverified 放行", async () => {
    const cwd = createTempDir()
    const { gdbPath } = writeFakeGdb(cwd)
    mkdirSync(join(cwd, ".yoma"), { recursive: true })
    writeFileSync(
      join(cwd, FLASH_STATE_FILE),
      JSON.stringify({ elfPath: "/other.elf", sha256: "0".repeat(64), at: Date.now() }),
    )
    const { run } = makeTool(cwd, gdbPath)
    const refused = await run({ action: "start", connect: "localhost:3333", elfPath: FIXTURE_ELF })
    expect(textOf(refused)).toContain("MISMATCH")
    expect(refused.details?.state).toBe("no-session")
    expect((await run({ action: "status" })).details?.state).toBe("no-session")
    const allowed = await run({
      action: "start",
      connect: "localhost:3333",
      elfPath: FIXTURE_ELF,
      allowUnverified: true,
    })
    expect(allowed.details?.state).toBe("halted")
  })

  it("start:连不上 server 时把 gdb 的话原样带出来,并且不留下会话", async () => {
    const cwd = createTempDir()
    const { gdbPath, setMode } = writeFakeGdb(cwd)
    setMode({ connect: "refuse" })
    const { run } = makeTool(cwd, gdbPath)
    await expect(run({ action: "start", connect: "localhost:1", elfPath: FIXTURE_ELF })).rejects.toThrow(
      /Connection refused/,
    )
    expect((await run({ action: "status" })).details?.state).toBe("no-session")
  })

  it("start 幂等:再调一次是复用而不是报错(自动压缩之后模型会这么干);同一批里两条 start 也只起一个 gdb", async () => {
    const { run } = await attached()
    const [a, b] = await Promise.all([
      run({ action: "start", connect: "localhost:3333", elfPath: FIXTURE_ELF }),
      run({ action: "start", connect: "localhost:3333", elfPath: FIXTURE_ELF }),
    ])
    expect(textOf(a)).toContain("already attached")
    expect(textOf(b)).toContain("already attached")
  })

  it("break → exec continue → 停止报告(帧、locals、聚合类型不当 optimized out、show 表达式)", async () => {
    const { run } = await attached()
    const br = await run({ action: "break", at: "main" })
    expect(textOf(br)).toMatch(/breakpoint 1 at 0x08000274/)
    expect(textOf(br)).toContain("breakpoints:\n  1 break main @ 0x08000274")

    const updates: string[] = []
    const go = await run({ action: "exec", op: "continue", show: ["g_ticks"] }, BACKGROUND_CONTEXT, (u) =>
      updates.push(textOf(u)),
    )
    const text = textOf(go)
    expect(text).toContain("breakpoint-hit breakpoint 1")
    expect(text).toContain("#0 main() at main.c:150")
    expect(text).toContain('locals: i=3, cfg: gpio_cfg_t(用 eval "p cfg" 展开), p=<optimized out>')
    expect(text).toContain("1 个局部变量是 <optimized out>")
    expect(text).toContain("g_ticks = 42")
    expect(text).toContain("目标已暂停")
    expect(go.details).toMatchObject({ action: "exec", state: "halted", stopId: 2 })
  })

  it("exec 拒绝会写目标的 show 表达式 —— 它每次停止都会被求值", async () => {
    const { run } = await attached()
    await run({ action: "break", at: "main" })
    await expect(run({ action: "exec", op: "continue", show: ["g_ticks", "g_scenario = 6"] })).rejects.toThrow(
      /WRITE the target[\s\S]*g_scenario = 6/,
    )
  })

  it("没有断点的 continue 被拦下,理由说清楚不是挂死;expectRunning 放行", async () => {
    const { run, setMode } = await attached()
    await expect(run({ action: "exec", op: "continue" })).rejects.toThrow(/no breakpoints/)
    setMode({ resume: "hang" })
    const r = await run({
      action: "exec",
      op: "continue",
      expectRunning: true,
      waitMs: 200,
      onTimeout: "leave-running",
    })
    expect(textOf(r)).toContain("left RUNNING")
    expect(r.details?.state).toBe("running")
  })

  it("超时默认 interrupt:停住的目标能恢复,报告说明这一下是工具打断的,不是崩溃", async () => {
    const { run, setMode } = await attached()
    await run({ action: "break", at: "main" })
    setMode({ resume: "hang" })
    const r = await run({ action: "exec", op: "continue", waitMs: 200 })
    expect(textOf(r)).toContain("this halt was mine, not a crash")
    expect(textOf(r)).toContain("signal-received")
    expect(r.details?.state).toBe("halted")
  })

  it("interrupt 也不落地时,说清楚是哪一种(这里认不出 Cortex-M,所以是连接本身没了)", async () => {
    const { run, setMode } = await attached()
    await run({ action: "break", at: "main" })
    setMode({ resume: "hang", interrupt: "ignore" })
    const r = await run({ action: "exec", op: "continue", waitMs: 200 })
    expect(textOf(r)).toContain("did not land")
    expect(textOf(r)).toContain("DHCSR is unreadable")
    expect(r.details?.state).toBe("running")
  })

  it("用户按停止:等停止的 exec 立刻收手并把目标 interrupt 住", async () => {
    const { run, setMode } = await attached()
    await run({ action: "break", at: "main" })
    setMode({ resume: "hang" })
    const controller = new AbortController()
    const pending = run(
      { action: "exec", op: "continue", waitMs: 30_000 },
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    )
    setTimeout(() => controller.abort(), 100)
    const startedAt = Date.now()
    await expect(pending).rejects.toThrow(/aborted[\s\S]*interrupted/)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect((await run({ action: "status" })).details?.state).toBe("halted")
  })

  it("单步 count + show 一次调用给出一张表", async () => {
    const { run } = await attached()
    const r = await run({ action: "exec", op: "next", count: 3, show: ["g_ticks"] })
    const text = textOf(r)
    expect(text).toContain("steps: main.c:150 g_ticks=42 | main.c:150 g_ticks=42")
    expect(text).toContain("end-stepping-range")
  })

  it("断点插不进去时 gdb 的话原样带出,并说明 pending 断点是故意关掉的", async () => {
    const { run } = await attached()
    await expect(run({ action: "break", at: "nope" })).rejects.toThrow(
      /not defined[\s\S]*pending breakpoints are disabled on purpose/,
    )
  })

  it("watch 走硬件观察点并进预算表;remove 之后表清空", async () => {
    const { run } = await attached()
    const w = await run({ action: "break", watch: "g_state", mode: "rw" })
    expect(textOf(w)).toContain("watchpoint 2 on g_state")
    expect(textOf(w)).not.toContain("SOFTWARE")
    expect(textOf(w)).toContain("2 watch g_state")
    expect(textOf(await run({ action: "break", remove: "2" }))).toContain("none armed")
    await expect(run({ action: "break", remove: "x" })).rejects.toThrow(/not a breakpoint number/)
    await expect(run({ action: "break", at: "main", watch: "g" })).rejects.toThrow(/not both/)
  })

  it("eval:只读放行、错误是数据、闸门三种拒绝各说各的话", async () => {
    const { run } = await attached()
    expect(textOf(await run({ action: "eval", command: "p 1+1" }))).toContain("$1 = 2")
    expect(textOf(await run({ action: "eval", command: "p nosuch" }))).toContain("gdb reported an error: No symbol")
    await expect(run({ action: "eval", command: "shell ls" })).rejects.toThrow(/refused[\s\S]*corrupts the MI stream/)
    await expect(run({ action: "eval", command: "continue" })).rejects.toThrow(/use gdb exec op:"continue"/)
    await expect(run({ action: "eval", command: "set variable x = 1" })).rejects.toThrow(/write: true/)
    await expect(run({ action: "eval", command: "p x = 1" })).rejects.toThrow(/WRITING/)
    await expect(run({ action: "eval" })).rejects.toThrow(/needs command/)
    expect(textOf(await run({ action: "eval", command: "set variable x = 1", write: true }))).toContain("$1 = 2")
  })

  it("eval load 成功后更新 flash-state —— 否则下一次 start 会把刚 load 的镜像报成不符", async () => {
    const { run, cwd } = await attached()
    expect(await readFlashState(cwd)).toBeUndefined()
    const r = await run({ action: "eval", command: "load", write: true })
    expect(textOf(r)).toContain(`recorded ${FIXTURE_ELF}`)
    const state = await readFlashState(cwd)
    expect(state?.elfPath).toBe(FIXTURE_ELF)
    expect(state?.sha256).toBe(await sha256File(FIXTURE_ELF))
  })

  it("status 与 stop:stop 之后 status 回到 no-session,转录文件留着", async () => {
    const { run, cwd } = await attached()
    const st = textOf(await run({ action: "status" }))
    expect(st).toContain(`elf: ${FIXTURE_ELF}`)
    expect(st).toContain("server: external (localhost:3333)")
    expect(st).toContain("session log:")
    const stopped = await run({ action: "stop" })
    expect(textOf(stopped)).toContain("gdb session closed")
    const log = /Session log: (.+)/.exec(textOf(stopped))![1]!
    expect(existsSync(log)).toBe(true)
    expect(log.startsWith(join(cwd, ".yoma", "gdb"))).toBe(true)
    expect((await run({ action: "status" })).details?.state).toBe("no-session")
  })

  it("会话关掉时 dispose 收掉 gdb;之后的动作被拒", async () => {
    const { run, tool } = await attached()
    await tool.dispose()
    await new Promise((r) => setTimeout(r, 200))
    expect((await run({ action: "status" })).details?.state).toBe("no-session")
    await expect(run({ action: "start", connect: "localhost:3333", elfPath: FIXTURE_ELF })).rejects.toThrow(/closing/)
  })

  it("dispose 打断正在等停止的 exec,不等它跑完超时", async () => {
    const { run, tool, setMode } = await attached()
    await run({ action: "break", at: "main" })
    setMode({ resume: "hang" })
    const pending = run({ action: "exec", op: "continue", waitMs: 30_000 }).catch((e: Error) => e.message)
    await new Promise((r) => setTimeout(r, 100))
    const startedAt = Date.now()
    await tool.dispose()
    expect(Date.now() - startedAt).toBeLessThan(8_000)
    expect(await pending).toMatch(/aborted/)
  })

  it("watch:硬/软观察点按 -break-info 的 type 判 —— MI 对两者都回 wpt=,阁楼的启发式把每个写观察点都报成 SOFTWARE", async () => {
    const { run, setMode, cwd } = await attached()
    const hw = await run({ action: "break", watch: "g_state" })
    expect(textOf(hw)).toContain("watchpoint 2 on g_state")
    expect(textOf(hw)).not.toContain("SOFTWARE")
    expect(fakeCommands(cwd)).toContain("-break-info 2")
    await run({ action: "break", remove: "2" })
    setMode({ watchType: "watchpoint" })
    expect(textOf(await run({ action: "break", watch: "g_state" }))).toContain("SOFTWARE watchpoint")
  })

  it("临时断点命中后 gdb 发 =breakpoint-deleted:预算表跟着清空,「没断点别 continue」的门随之生效", async () => {
    const { run } = await attached()
    await run({ action: "break", at: "main", temporary: true })
    expect(textOf(await run({ action: "exec", op: "continue" }))).toContain("breakpoint-hit")
    expect(textOf(await run({ action: "break" }))).toContain("none armed")
    await expect(run({ action: "exec", op: "continue" })).rejects.toThrow(/no breakpoints/)
  })

  it("对已经停住的目标 exec interrupt / wait 直接给停止报告,不发 -exec-interrupt(否则是一份假的 WFI 诊断)", async () => {
    const { run, cwd } = await attached()
    expect(textOf(await run({ action: "exec", op: "interrupt" }))).toContain("already halted")
    expect(textOf(await run({ action: "exec", op: "wait" }))).toContain("already halted")
    expect(fakeCommands(cwd)).not.toContain("-exec-interrupt")
  })

  it("目标退出之后:exec 明说没东西可跑、eval 标注值来自 ELF、start 收掉旧会话重来而不是复用", async () => {
    const { run, setMode } = await attached()
    await run({ action: "break", at: "main" })
    setMode({ resume: "exit" })
    const go = await run({ action: "exec", op: "continue" })
    expect(textOf(go)).toContain("exited with code 0")
    expect(go.details?.state).toBe("exited")
    await expect(run({ action: "exec", op: "continue" })).rejects.toThrow(/has exited/)
    expect(textOf(await run({ action: "eval", command: "p g_iter" }))).toContain("target is gone")
    setMode({})
    const again = await run({ action: "start", connect: "localhost:3333", elfPath: FIXTURE_ELF, allowUnverified: true })
    expect(textOf(again)).toContain("restarted from scratch")
    expect(again.details?.state).toBe("halted")
  })

  it("信号在排队期间就已中止:写目标的 eval 一个字都不发给 gdb", async () => {
    const { run, cwd } = await attached()
    const before = fakeCommands(cwd).length
    await expect(
      run(
        { action: "eval", command: "set variable x = 1", write: true },
        withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT),
      ),
    ).rejects.toThrow(/aborted before it ran/)
    expect(fakeCommands(cwd).length).toBe(before)
  })

  it("status 不排队:exec 等停止的时候 status 立刻回答,并说目标在跑", async () => {
    const { run, setMode } = await attached()
    await run({ action: "break", at: "main" })
    setMode({ resume: "hang" })
    const pending = run({ action: "exec", op: "continue", waitMs: 3_000, onTimeout: "leave-running" })
    await new Promise((r) => setTimeout(r, 100))
    const startedAt = Date.now()
    const st = await run({ action: "status" })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(textOf(st)).toContain("RUNNING")
    expect(st.details?.state).toBe("running")
    await pending
  })

  it("exec finish 把返回值贴在停止行上", async () => {
    const { run, setMode } = await attached()
    setMode({ finishValue: "9" })
    // 假 gdb 的 finish 停止记录带 return-value(真 gdb 16.3 实测形状)
    const r = await run({ action: "exec", op: "finish" })
    expect(textOf(r)).toContain("returned 9 ($1)")
  })

  it("宿主退出带走 server:openocd / qemu 不能被 launchd 接管继续攥着探针", async () => {
    const dir = createTempDir()
    const sleeper = join(dir, "sleeper.mjs")
    writeFileSync(sleeper, "setInterval(() => {}, 1000)\n")
    // 按测试文件自己的位置找源码:根上的 `npm test` 里 cwd 是仓库根,不是 packages/kernel。
    const kernelDir = fileURLToPath(new URL("..", import.meta.url))
    const serversModule = join(kernelDir, "src", "host", "tools", "gdb", "servers.ts")
    const script = join(dir, "host.ts")
    writeFileSync(
      script,
      [
        `import { spawnServer } from ${JSON.stringify(serversModule)}`,
        `const server = spawnServer([${JSON.stringify(process.execPath)}, ${JSON.stringify(sleeper)}], 0, ${JSON.stringify(dir)})`,
        `console.log("SERVER_PID=" + server.child.pid)`,
        // 故意不 stop:退出钩子(killOnHostExit)负责收尸。
        `setTimeout(() => process.kill(process.pid, "SIGTERM"), 300)`,
        `setInterval(() => {}, 1000)`,
      ].join("\n"),
    )
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: kernelDir,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => (out += chunk))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => (out += chunk))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        resolve()
      }, 8_000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
    const pid = Number(/SERVER_PID=(\d+)/.exec(out)?.[1])
    expect(pid, out).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 300))
    expect(alive(pid)).toBe(false)
  })

  describe("假 openocd:探针租约、server 收尸、崩溃重起、keepServer、reset", () => {
    let savedPath: string | undefined
    beforeEach(() => {
      savedPath = process.env.PATH
    })
    afterEach(() => {
      process.env.PATH = savedPath
      releaseProbe("flash")
    })

    async function attachedViaOpenocd() {
      const cwd = createTempDir()
      const { gdbPath, setMode } = writeFakeGdb(cwd)
      const { pidFile } = installFakeOpenocd(cwd)
      // serverBinary 按 process.env.PATH 找 openocd:把假的排在最前
      process.env.PATH = `${cwd}${delimiter}${savedPath ?? ""}`
      const { tool, run } = makeTool(cwd, gdbPath)
      const startParams: GdbInput = {
        action: "start",
        server: "openocd",
        config: ["target/fake.cfg"],
        elfPath: FIXTURE_ELF,
        allowUnverified: true,
      }
      const started = await run(startParams)
      return {
        cwd,
        tool,
        run,
        setMode,
        started,
        startParams,
        gdbPath,
        openocdPid: () => Number(readFileSync(pidFile, "utf8")),
      }
    }

    it("start 起 openocd 并攥住探针租约;stop 放租约、杀 server(删掉 releaseProbe 或杀树全绿是审稿抓到的缺口)", async () => {
      const { run, started, openocdPid } = await attachedViaOpenocd()
      expect(textOf(started)).toContain("via openocd")
      expect(textOf(started)).toContain("server log: ")
      expect(existsSync(probeLockFile())).toBe(true)
      expect(claimProbe("flash", "test")?.owner).toBe("gdb")
      const pid = openocdPid()
      expect(alive(pid)).toBe(true)
      await run({ action: "stop" })
      await new Promise((r) => setTimeout(r, 300))
      expect(alive(pid)).toBe(false)
      expect(existsSync(probeLockFile())).toBe(false)
      expect(claimProbe("flash", "test")).toBeUndefined()
    })

    it("gdb 崩了再 start:旧 openocd 先被收掉,不留下两个抢一个探针的 server", async () => {
      const { run, cwd, openocdPid, startParams } = await attachedViaOpenocd()
      const first = openocdPid()
      process.kill(Number(readFileSync(join(cwd, "gdb.pid"), "utf8")), "SIGKILL")
      await new Promise((r) => setTimeout(r, 300))
      expect((await run({ action: "status" })).details?.state).toBe("no-session")
      // gdb 崩了不等于 server 死了 —— 这正是要收的那个
      expect(alive(first)).toBe(true)
      const again = await run(startParams)
      expect(again.details?.state).toBe("halted")
      await new Promise((r) => setTimeout(r, 300))
      expect(alive(first)).toBe(false)
      const second = openocdPid()
      expect(second).not.toBe(first)
      expect(alive(second)).toBe(true)
      await run({ action: "stop" })
      await new Promise((r) => setTimeout(r, 300))
      expect(alive(second)).toBe(false)
    })

    it("stop keepServer:交接命令写真正用的 gdb 路径,租约仍归 server;再 stop 一次才放", async () => {
      const { run, openocdPid, gdbPath } = await attachedViaOpenocd()
      const stopped = await run({ action: "stop", keepServer: true })
      expect(textOf(stopped)).toContain(`${gdbPath} ${FIXTURE_ELF} -ex`)
      expect(textOf(stopped)).toContain("still owns the debug probe")
      expect(stopped.details?.connection).toBeUndefined()
      expect(existsSync(probeLockFile())).toBe(true)
      expect(alive(openocdPid())).toBe(true)
      await run({ action: "stop" })
      await new Promise((r) => setTimeout(r, 300))
      expect(alive(openocdPid())).toBe(false)
      expect(existsSync(probeLockFile())).toBe(false)
    })

    it("reset:server 报错时不宣布复位、不 bump epoch;成功但没有停止记录时明说旧报告已过期", async () => {
      const { run, setMode } = await attachedViaOpenocd()
      setMode({ reset: "fail" })
      const failed = await run({ action: "exec", op: "reset-halt" })
      expect(textOf(failed)).toContain("may NOT have happened")
      expect(failed.details?.epoch).toBe(1)
      setMode({})
      const ok = await run({ action: "exec", op: "reset-halt" })
      expect(textOf(ok)).toContain("epoch is now 2")
      expect(textOf(ok)).toContain("no stop record came back")
      expect(ok.details?.epoch).toBe(2)
    })
  })
})

// ─── 第四层:真 gdb + QEMU ───────────────────────────────────────────────────

const GDB_BIN = process.env.YOMA_GDB || findOnPath("arm-none-eabi-gdb") || findOnPath("gdb-multiarch")
const QEMU_BIN = findOnPath("qemu-system-arm")
const HAS_E2E = !!GDB_BIN && !!QEMU_BIN && existsSync(FIXTURE_ELF) && process.platform !== "win32"
if (!HAS_E2E) console.warn("[tools-gdb.test] 没有 arm-none-eabi-gdb + qemu-system-arm,跳过真 QEMU 那一层")

describe.skipIf(!HAS_E2E)("端到端(QEMU + 真 gdb)", () => {
  const startParams: GdbInput = {
    action: "start",
    server: "qemu",
    machine: "netduinoplus2",
    elfPath: FIXTURE_ELF,
    allowUnverified: true,
  }

  function qemuStrays(): string[] {
    const ps = execSync("ps -o pid=,command= -A || true", { encoding: "utf8" })
    return ps.split("\n").filter((l) => l.includes("netduinoplus2") && l.includes(FIXTURE_ELF))
  }

  async function killStrays(): Promise<void> {
    for (const line of qemuStrays()) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (pid > 0) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // 已经没了
        }
      }
    }
  }

  afterEach(killStrays)

  /**
   * 夹具的 DWARF 里写的是编译那台机器上的绝对路径。那条路径在本机**可能存在**(编译它的检出还在),也可能不存在;
   * 两种都是真实情况,各自的正确行为不同:存在就原样用、不存在就按后缀映射到 cwd(映射那一支由假 gdb 那层钉死)。
   */
  function dwarfMainExists(attachReport: string): boolean {
    const reported = /at (\S+main\.c):\d+/.exec(attachReport)?.[1]
    return reported !== undefined && existsSync(reported)
  }

  it("attach 之后认出 Cortex-M4,预算按「不知道」处理,并把探针/RTT 的限制说清楚;编译期路径按本机情况处理", async () => {
    const { run } = makeTool(FIXTURE_DIR)
    const r = await run(startParams)
    const text = textOf(r)
    expect(text).toContain("core: Cortex-M4")
    expect(text).toContain("breakpoint budget unknown")
    expect(text).not.toMatch(/\d+ hardware breakpoints/)
    expect(text).toContain("qemu does not support watchpoints")
    if (dwarfMainExists(text)) expect(text).not.toContain("source paths:")
    else expect(text).toContain(`source paths: 1 of 1 compile-time paths do not exist here; mapped`)
    expect(r.details?.state).toBe("halted")
    expect(r.details?.connection).toMatch(/^localhost:\d+$/)
  }, 30_000)

  it("断点 → continue → 停止报告;编辑器位置指向一个本机真实存在的 main.c", async () => {
    const { run } = makeTool(FIXTURE_DIR)
    const attach = textOf(await run(startParams))
    const br = await run({ action: "break", at: "main" })
    expect(textOf(br)).toMatch(/breakpoint 1 at 0x[0-9a-f]+/)
    expect(textOf(br)).toMatch(/main\.c:1\d\d/)

    const go = await run({ action: "exec", op: "continue", waitMs: 15_000 })
    const text = textOf(go)
    expect(text).toContain("breakpoint-hit")
    expect(text).toMatch(/#0 main\(\) at \S*main\.c:\d+/)
    // 映射到了夹具目录就该相对化成裸的 main.c;DWARF 路径本机就在的话原样给(它不在 cwd 底下,剥不掉)
    if (!dwarfMainExists(attach)) expect(text).toMatch(/#0 main\(\) at main\.c:\d+/)
    expect(go.details?.path).toMatch(/main\.c$/)
    expect(existsSync(go.details!.path!)).toBe(true)
    expect(go.details?.line).toBeGreaterThan(100)
  }, 40_000)

  it("HardFault 自动解码:CFSR、BFAR、MSP/PSP 选择、栈上的 PC", async () => {
    const { run } = makeTool(FIXTURE_DIR)
    await run(startParams)
    await run({ action: "break", at: "main" })
    await run({ action: "exec", op: "continue", waitMs: 15_000 })
    // SC_BADPTR = 6:往未映射的 0xF0000000 写
    await run({ action: "eval", command: "set variable g_scenario = 6", write: true })
    await run({ action: "break", remove: "1" })
    await run({ action: "break", at: "hardfault_report" })
    const fault = await run({ action: "exec", op: "continue", waitMs: 15_000 })
    const text = textOf(fault)
    expect(text).toContain("PRECISERR")
    expect(text).toContain("BFAR=0xf0000000")
    expect(text).toContain("PSP")
    expect(text).toContain("EXC_RETURN=0xfffffffd")
    // 出事 PC 带符号与源码行;入栈的 xPSR 说明出事时在线程模式
    expect(text).toMatch(/出事 PC 0x[0-9a-f]{8} = main \+ \d+ in section \.text \(\S*main\.c:\d+\)/)
    expect(text).toMatch(/xpsr=0x[0-9a-f]{8}\(线程模式\)/)
  }, 60_000)

  it("exec finish 从函数里出来时把返回值贴在停止行上", async () => {
    const { run } = makeTool(FIXTURE_DIR)
    await run(startParams)
    await run({ action: "break", at: "main" })
    await run({ action: "exec", op: "continue", waitMs: 15_000 })
    // SC_BREAKPOINT = 1:breakpoint_target(i) 循环 5 次
    await run({ action: "eval", command: "set variable g_scenario = 1", write: true })
    await run({ action: "break", remove: "1" })
    await run({ action: "break", at: "breakpoint_target" })
    await run({ action: "exec", op: "continue", waitMs: 15_000 })
    const done = await run({ action: "exec", op: "finish", waitMs: 15_000 })
    expect(textOf(done)).toMatch(/function-finished returned \d+ \(\$\d+\)/)
  }, 60_000)

  it("qemu 上拒绝观察点,并指出替代方案", async () => {
    const { run } = makeTool(FIXTURE_DIR)
    await run(startParams)
    await expect(run({ action: "break", watch: "g_canary" })).rejects.toThrow(/no watchpoint support/)
  }, 30_000)

  it("单步 count + show 一次调用给出一张表", async () => {
    const { run } = makeTool(FIXTURE_DIR)
    await run(startParams)
    await run({ action: "break", at: "main" })
    await run({ action: "exec", op: "continue", waitMs: 15_000 })
    const stepped = await run({ action: "exec", op: "next", count: 3, show: ["g_scenario"], waitMs: 10_000 })
    const text = textOf(stepped)
    expect(text).toContain("steps:")
    expect(text).toContain("g_scenario=")
  }, 40_000)

  it("eval:只读表达式放行,写要 write:true", async () => {
    const { run } = makeTool(FIXTURE_DIR)
    await run(startParams)
    expect(textOf(await run({ action: "eval", command: "p sizeof(int)" }))).toContain("= 4")
    await expect(run({ action: "eval", command: "p g_scenario = 6" })).rejects.toThrow(/WRITING/)
  }, 30_000)

  it("用户按停止时正在跑的目标被 interrupt 住,会话仍可用", async () => {
    const { run } = makeTool(FIXTURE_DIR)
    await run(startParams)
    await run({ action: "break", at: "main" })
    await run({ action: "exec", op: "continue", waitMs: 15_000 })
    // SC_INFLOOP = 8:永远自旋(hello 场景 500 ms 内就跑完退出了,等不到中止);hardfault_report 永远不命中
    await run({ action: "eval", command: "set variable g_scenario = 8", write: true })
    await run({ action: "break", remove: "1" })
    await run({ action: "break", at: "hardfault_report" })
    const controller = new AbortController()
    const pending = run(
      { action: "exec", op: "continue", waitMs: 20_000 },
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    )
    setTimeout(() => controller.abort(), 500)
    const startedAt = Date.now()
    await expect(pending).rejects.toThrow(/aborted[\s\S]*interrupted/)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    const status = await run({ action: "status" })
    expect(status.details?.state).toBe("halted")
    expect(textOf(status)).toContain("signal-received")
  }, 40_000)

  it("stop 之后 qemu 和 gdb 都不留下;dispose 同样", async () => {
    const { run, tool } = makeTool(FIXTURE_DIR)
    await run(startParams)
    expect(qemuStrays().length).toBeGreaterThan(0)
    await run({ action: "stop" })
    await new Promise((r) => setTimeout(r, 500))
    expect(qemuStrays()).toEqual([])

    await run(startParams)
    expect(qemuStrays().length).toBeGreaterThan(0)
    await tool.dispose()
    await new Promise((r) => setTimeout(r, 500))
    expect(qemuStrays()).toEqual([])
  }, 60_000)
})
