import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"
import { PassThrough, Readable, Writable } from "node:stream"
import {
  clampThinkingLevel,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { parseCliArgs } from "../src/cli/args.ts"
import { runCli } from "../src/cli/main.ts"
import { openCliSession, type CliSession, type CliSessionDependencies } from "../src/cli/session.ts"
import { createCliOutput, messageText, runInteractive, terminalText, type CliIO } from "../src/cli/terminal.ts"

let root: string
let cwd: string
let configDir: string
let homeDir: string
const sessions: CliSession[] = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "yoma-cli-test-")))
  cwd = join(root, "project")
  configDir = join(root, "config")
  homeDir = join(root, "home")
  await Promise.all([cwd, configDir, homeDir].map((dir) => mkdir(dir)))
})
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  await rm(root, { recursive: true, force: true })
})

function setup() {
  const faux = fauxProvider({ provider: "cli-faux", models: [{ id: "thinking", reasoning: true }, { id: "plain" }] })
  const models = createModels()
  models.setProvider(faux.provider)
  const dependencies: CliSessionDependencies = {
    homeDir,
    resolveModels: async (dir, options) => {
      expect(dir).toBe(configDir)
      const model = options?.provider
        ? models.getModel(options.provider, options.modelId ?? "thinking")
        : faux.getModel()
      if (!model) throw new Error("saved model unavailable")
      return { models, model }
    },
  }
  async function open(options: Parameters<typeof openCliSession>[0] = {}, extra: CliSessionDependencies = {}) {
    const session = await openCliSession({ cwd, configDir, ...options }, { ...dependencies, ...extra })
    sessions.push(session)
    return session
  }
  return { faux, models, dependencies, open }
}

function captureIO(input: Readable = Readable.from([])) {
  let stdout = ""
  let stderr = ""
  const signals = new EventEmitter()
  const io: CliIO = {
    input,
    signals,
    terminal: false,
    output: new Writable({
      write(chunk, _encoding, done) {
        stdout += chunk.toString()
        done()
      },
    }),
    error: new Writable({
      write(chunk, _encoding, done) {
        stderr += chunk.toString()
        done()
      },
    }),
  }
  return { io, stdout: () => stdout, stderr: () => stderr, signals }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition did not become true")
}

describe("CLI options", () => {
  it("parses explicit overrides, prompts and --", () => {
    expect(
      parseCliArgs(["-c", "--model", "provider/org/model", "--thinking", "max", "-p", "--", "-prompt"]),
    ).toMatchObject({ resume: "latest", model: "provider/org/model", thinking: "max", print: true, prompt: "-prompt" })
    expect(() => parseCliArgs(["--continue", "--session", "id"])).toThrow()
    expect(() => parseCliArgs(["--thinking", "typo"])).toThrow()
    expect(() => parseCliArgs(["--model", "missing-provider"])).toThrow()
    expect(() => parseCliArgs(["--unknown"])).toThrow()
  })

  it("help needs neither credentials nor a session; empty print does not create state", async () => {
    const output = captureIO()
    const neverResolve = async () => {
      throw new Error("must not resolve models")
    }
    expect(await runCli(["--help"], output.io, { resolveModels: neverResolve })).toBe(0)
    expect(output.stdout()).toContain("Yoma CLI")
    await expect(runCli(["-p", "--config-dir", configDir], output.io, { resolveModels: neverResolve })).rejects.toThrow(
      "提示词",
    )
    expect(await readdir(configDir)).toEqual([])
    await expect(runCli([], output.io)).rejects.toThrow("非交互")
  })
})

describe("direct Harness session", () => {
  it("runs exactly four real coding tools, loads project context and persists the tool loop", async () => {
    const { faux, open } = setup()
    await writeFile(join(cwd, "AGENTS.md"), "PROJECT_CONTEXT_MARKER")
    await mkdir(join(homeDir, ".agents", "skills", "test"), { recursive: true })
    await writeFile(
      join(homeDir, ".agents", "skills", "test", "SKILL.md"),
      "---\nname: test\ndescription: ISOLATED_SKILL_MARKER\n---\nTest skill",
    )
    const trace: string[] = []
    const session = await open(
      {},
      {
        onEvent: (event) => {
          if (event.type === "tool_execution_end") {
            expect(event.isError).toBe(false)
            trace.push(event.toolName)
          }
        },
      },
    )
    faux.setResponses([
      (context, options) => {
        expect(context.tools?.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"])
        expect(context.systemPrompt).toContain("PROJECT_CONTEXT_MARKER")
        expect(context.systemPrompt).toContain("ISOLATED_SKILL_MARKER")
        expect(options?.reasoning ?? "off").toBe(clampThinkingLevel(faux.getModel(), "max"))
        return fauxAssistantMessage(fauxToolCall("write", { path: "answer.txt", content: "before" }))
      },
      fauxAssistantMessage(
        fauxToolCall("edit", { path: "answer.txt", edits: [{ oldText: "before", newText: "after" }] }),
      ),
      fauxAssistantMessage(fauxToolCall("read", { path: "answer.txt" })),
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf CLI_OK" })),
      fauxAssistantMessage("done"),
    ])
    expect(await session.prompt("test tools")).toEqual({ status: "completed" })
    expect(trace).toEqual(["write", "edit", "read", "bash"])
    expect(await readFile(join(cwd, "answer.txt"), "utf8")).toBe("after")
    expect((await session.messages()).map((message) => message.role)).toHaveLength(10)
    expect(await readFile(session.metadata.path, "utf8")).toContain("CLI_OK")
  })

  it("restores history, model and thinking without sending a request; new CLI starts fresh", async () => {
    const { faux, open } = setup()
    const first = await open({ thinking: "off" })
    faux.setResponses([fauxAssistantMessage("remember this")])
    await first.prompt("my history")
    await first.setModel("cli-faux/plain")
    const id = first.metadata.id
    await first.close()
    const count = faux.state.callCount
    const resumed = await open({ resume: "latest" })
    expect(resumed.metadata.id).toBe(id)
    expect(resumed.status()).toContain("cli-faux/plain")
    expect(resumed.status()).toContain("思考：off")
    expect((await resumed.messages()).map(messageText)).toEqual(["my history", "remember this"])
    expect(faux.state.callCount).toBe(count)
    await resumed.close()
    const fresh = await open()
    expect(fresh.metadata.id).not.toBe(id)
    expect(await fresh.messages()).toEqual([])
  })

  it("explicit model/thinking override saved configuration and survive the next resume", async () => {
    const { open, faux } = setup()
    const first = await open({ model: "cli-faux/plain" })
    await first.close()
    const next = await open({ resume: first.metadata.id.slice(0, -2), model: "cli-faux/thinking", thinking: "high" })
    expect(next.status()).toContain("cli-faux/thinking")
    expect(next.status()).toContain(`思考：${clampThinkingLevel(faux.getModel(), "high")}`)
    await next.close()
    const last = await open({ resume: first.metadata.id })
    expect(last.status()).toBe(next.status())
    await last.setModel("cli-faux/plain")
    expect(last.status()).toContain("思考：off")
  })

  it("continue uses modification time and never chooses a different cwd with a colliding directory encoding", async () => {
    const { open } = setup()
    const first = await open()
    await first.close()
    const second = await open()
    await second.close()
    const later = new Date(Date.now() + 10_000)
    await utimes(first.metadata.path, later, later)
    const latest = await open({ resume: "latest" })
    expect(latest.metadata.id).toBe(first.metadata.id)
    const nested = join(cwd, "a", "b")
    const dashed = join(cwd, "a-b")
    await mkdir(nested, { recursive: true })
    await mkdir(dashed)
    const other = await open({ cwd: nested })
    await other.close()
    await expect(open({ cwd: dashed, resume: "latest" })).rejects.toThrow("没有匹配")
  })

  it("refuses concurrent writers, releases on failure/close, and does not silently replace an unavailable model", async () => {
    const { open } = setup()
    const first = await open()
    await expect(open({ resume: first.metadata.id })).rejects.toThrow("cli-lock")
    await first.close()
    await expect(open({ resume: first.metadata.id, model: "missing/model" })).rejects.toThrow("unavailable")
    const resumed = await open({ resume: first.metadata.id })
    await resumed.close()
    expect(await readdir(join(configDir, "cli", "sessions"))).toHaveLength(1)
  })

  it("reports provider failure as failure, does not auto-retry, and /retry adds no user message", async () => {
    const { open, faux } = setup()
    const session = await open()
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline failure" })])
    expect(await session.prompt("question")).toEqual({ status: "failed", error: "offline failure" })
    expect(faux.state.callCount).toBe(1)
    faux.setResponses([fauxAssistantMessage("retried")])
    expect(await session.retry()).toEqual({ status: "completed" })
    expect((await session.messages()).filter((message) => message.role === "user")).toHaveLength(1)
  })

  it("manual compaction persists a summary without deleting the original history", async () => {
    const { open, faux } = setup()
    const session = await open()
    faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")])
    await session.prompt("first question " + "context ".repeat(12_000))
    await session.prompt("second question")
    faux.setResponses([fauxAssistantMessage("CLI_SUMMARY"), fauxAssistantMessage("CLI_SUMMARY")])
    expect(await session.compact("keep facts")).toEqual({ status: "completed" })
    const disk = await readFile(session.metadata.path, "utf8")
    expect(disk).toContain('"type":"compaction"')
    expect(disk).toContain("CLI_SUMMARY")
    expect(disk).toContain("first question")
    await session.close()
    const restored = await open({ resume: session.metadata.id })
    expect(JSON.stringify(await restored.messages())).toContain("CLI_SUMMARY")
  })

  it("abort during async prompt preparation prevents the first model request", async () => {
    const { open, faux } = setup()
    const session = await open()
    const turn = session.prompt("cancel immediately")
    await session.abort()
    expect(await turn).toEqual({ status: "aborted" })
    expect(faux.state.callCount).toBe(0)
    faux.setResponses([fauxAssistantMessage("next")])
    expect(await session.prompt("new question")).toEqual({ status: "completed" })
  })

  it("stops a running real bash process and permits another turn", async () => {
    const { open, faux } = setup()
    const started = deferred()
    const session = await open(
      {},
      {
        onEvent: (event) => {
          if (event.type === "tool_execution_update" && JSON.stringify(event.partialResult).includes("CLI_RUNNING"))
            started.resolve()
        },
      },
    )
    faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "printf CLI_RUNNING; sleep 30" }))])
    const turn = session.prompt("long command")
    await started.promise
    expect(session.busy).toBe(true)
    expect(() => session.prompt("too early")).toThrow("正在执行")
    await session.abort()
    expect(await turn).toEqual({ status: "aborted" })
    expect(session.busy).toBe(false)
    faux.setResponses([fauxAssistantMessage("alive")])
    expect(await session.prompt("continue")).toEqual({ status: "completed" })
  }, 10_000)
})

describe("terminal entry", () => {
  it("print combines piped UTF-8 input, streams one answer, and keeps metadata off stdout", async () => {
    const { faux, dependencies } = setup()
    const bytes = Buffer.from("中文输入")
    const output = captureIO(Readable.from([bytes.subarray(0, 1), bytes.subarray(1)]))
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("中文输入")
        expect(JSON.stringify(context.messages)).toContain("summarize")
        return fauxAssistantMessage("中文回答")
      },
    ])
    expect(await runCli(["-p", "--cwd", cwd, "--config-dir", configDir, "summarize"], output.io, dependencies)).toBe(0)
    expect(output.stdout()).toBe("中文回答\n")
    expect(output.stderr()).toContain("会话：")
    expect(output.signals.listenerCount("SIGINT")).toBe(0)
  })

  it("print provider failure returns nonzero, not a false success", async () => {
    const { faux, dependencies } = setup()
    const output = captureIO()
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "broken provider" })])
    expect(await runCli(["-p", "--cwd", cwd, "--config-dir", configDir, "hello"], output.io, dependencies)).toBe(1)
    expect(output.stderr()).toContain("broken provider")
  })

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("print handles %s by cancelling the request and returning %i", async (signal, exitCode) => {
    const { faux, dependencies, open } = setup()
    const captured = captureIO()
    const entered = deferred()
    faux.setResponses([
      async (_context, options) => {
        entered.resolve()
        await new Promise<void>((done) => {
          if (options?.signal?.aborted) done()
          else options?.signal?.addEventListener("abort", () => done(), { once: true })
        })
        return fauxAssistantMessage("interrupted")
      },
    ])
    const running = runCli(["-p", "--cwd", cwd, "--config-dir", configDir, "hello"], captured.io, dependencies)
    await entered.promise
    captured.signals.emit(signal)
    expect(await running).toBe(exitCode)
    expect(captured.stderr()).toContain("[已停止]")
    expect(captured.signals.listenerCount(signal)).toBe(0)
    // 退出路径已释放写锁；恢复不再次请求模型。
    const resumed = await open({ resume: "latest" })
    expect(resumed.busy).toBe(false)
    expect(faux.state.callCount).toBe(1)
  })

  it("interactive Ctrl+C cancels instead of exiting; /history and /quit work afterwards", async () => {
    const { open, faux } = setup()
    const input = new PassThrough()
    const captured = captureIO(input)
    const output = createCliOutput(captured.io)
    const entered = deferred()
    const session = await open({}, { onEvent: output.event })
    faux.setResponses([
      async (_context, options) => {
        entered.resolve()
        await new Promise<void>((done) => {
          if (options?.signal?.aborted) done()
          else options?.signal?.addEventListener("abort", () => done(), { once: true })
        })
        return fauxAssistantMessage("cancelled")
      },
    ])
    const interactive = runInteractive(session, captured.io, output)
    input.write("first question\n")
    await entered.promise
    input.write("not queued\n")
    captured.signals.emit("SIGINT")
    await until(() => captured.stderr().includes("[已停止]"))
    expect(captured.stderr()).toContain("正在执行")
    faux.setResponses([fauxAssistantMessage("second answer")])
    input.write("second question\n")
    await until(() => captured.stdout().includes("second answer") && !session.busy)
    await new Promise((resolve) => setTimeout(resolve, 0))
    input.write("/history\n")
    await until(() => captured.stderr().includes("second answer"))
    input.write("/quit\n")
    await interactive
    expect((await session.messages()).filter((message) => message.role === "user")).toHaveLength(2)
    expect(captured.signals.listenerCount("SIGINT")).toBe(0)
  })

  it("EOF while busy cancels and closes, rather than leaving a tool running", async () => {
    const { open, faux } = setup()
    const input = new PassThrough()
    const captured = captureIO(input)
    const session = await open()
    faux.setResponses([fauxAssistantMessage("not reached")])
    const interactive = runInteractive(session, captured.io, createCliOutput(captured.io))
    input.write("question\n")
    input.end()
    await interactive
    expect(session.busy).toBe(false)
    expect(() => session.prompt("closed")).toThrow("已关闭")
  })

  it("strips terminal escape sequences without damaging CJK", () => {
    expect(terminalText("\x1b[31m中文\x1b[0m\x1b]52;c;YWJj\x07\r\x00\n")).toBe("中文\n")
  })
})
