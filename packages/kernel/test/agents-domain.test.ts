/**
 * 子 agent 的领域层(host/domain/agents/)验收:定义的解析与合并、工具池、结果提取、通知的形状
 * (docs/子agent-设计方案-v0.4-20260918.md §4、§5.3、§6.4)。
 *
 * 通知 XML 与结果取法钉的是**逐字**形状:它们照 CC,是模型已经学会的信号,换一个字就是一套没见过的信号。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { afterEach, describe, expect, it } from "vitest"

import { BUILTIN_AGENTS, DEFAULT_AGENT_TYPE } from "../src/host/domain/agents/builtin.ts"
import { EMPTY_RESULT_MARKER, lastAssistantText } from "../src/host/domain/agents/finalize.ts"
import { agentDirectories, loadAgentProfiles, parseAgentMarkdown } from "../src/host/domain/agents/load.ts"
import {
  formatTaskNotification,
  notificationSummary,
  parseTaskNotification,
} from "../src/host/domain/agents/notification.ts"
import type { AgentDiagnostic } from "../src/host/domain/agents/profile.ts"
import {
  describeAgentTools,
  HARDWARE_TOOL_NAMES,
  resolveAgentTools,
  SUBAGENT_TOOL_NAMES,
} from "../src/host/domain/agents/select.ts"
import { TOOL_NAMES } from "../src/types.ts"

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "yoma-agents-"))
  roots.push(dir)
  return dir
}

function writeAgent(dir: string, file: string, text: string): string {
  mkdirSync(dir, { recursive: true })
  const full = path.join(dir, file)
  writeFileSync(full, text)
  return full
}

function parse(text: string) {
  const diagnostics: AgentDiagnostic[] = []
  const profile = parseAgentMarkdown(text, "/x/agent.md", "project", diagnostics)
  return { profile, diagnostics }
}

describe("parseAgentMarkdown", () => {
  it("读出与 CC 同名的 frontmatter 字段,正文就是系统提示词", () => {
    const { profile, diagnostics } = parse(`---
name: reviewer
description: Reviews firmware diffs before they are flashed
tools: read, grep, find
disallowedTools: [bash]
model: deepseek/deepseek-v4-flash
thinking: high
maxTurns: 8
background: true
skills: [hal-style]
initialPrompt: Start with git diff
color: blue
---

You review diffs.
Be strict.
`)
    expect(diagnostics).toEqual([])
    expect(profile).toEqual({
      name: "reviewer",
      description: "Reviews firmware diffs before they are flashed",
      prompt: "You review diffs.\nBe strict.",
      tools: ["read", "grep", "find"],
      disallowedTools: ["bash"],
      model: "deepseek/deepseek-v4-flash",
      thinkingLevel: "high",
      maxTurns: 8,
      background: true,
      skills: ["hal-style"],
      initialPrompt: "Start with git diff",
      color: "blue",
      source: "project",
      filePath: "/x/agent.md",
    })
  })

  it("没有 frontmatter、或 frontmatter 里没有 name:静默跳过(agents 目录里常有说明文档)", () => {
    expect(parse("# 这个目录放 agent 定义\n")).toEqual({ profile: undefined, diagnostics: [] })
    expect(parse("---\ndescription: 只有描述\n---\n正文")).toEqual({ profile: undefined, diagnostics: [] })
  })

  it("name 不合法或缺 description:整个跳过并说明原因", () => {
    const badName = parse("---\nname: has space\ndescription: d\n---\n")
    expect(badName.profile).toBeUndefined()
    expect(badName.diagnostics[0]?.message).toContain("agent skipped")
    const noDescription = parse("---\nname: x\n---\nbody")
    expect(noDescription.profile).toBeUndefined()
    expect(noDescription.diagnostics[0]?.message).toContain("description is required")
  })

  it("字段写错只忽略那个字段,agent 照常加载(CC 同款)", () => {
    const { profile, diagnostics } = parse(`---
name: sloppy
description: d
model: gpt4
thinking: extreme
maxTurns: 0
background: "yes"
tools: 42
---
body`)
    expect(profile).toMatchObject({ name: "sloppy", description: "d", prompt: "body" })
    for (const key of ["model", "thinkingLevel", "maxTurns", "background", "tools"] as const) {
      expect(profile![key]).toBeUndefined()
    }
    expect(diagnostics.map((d) => d.message.split(" ")[0])).toEqual(["tools", "model", "thinking", "maxTurns", "background"])
  })

  it("CC 有、yoma 没有对应能力的键:记一条诊断,不生效", () => {
    const { profile, diagnostics } = parse(`---
name: cc-port
description: d
permissionMode: acceptEdits
isolation: worktree
mcpServers: [github]
effort: high
---
body`)
    expect(profile?.name).toBe("cc-port")
    expect(diagnostics.map((d) => d.message)).toEqual([
      "permissionMode is not supported (Yoma has no permission modes); ignored",
      "isolation is not supported (worktree isolation is not implemented yet); ignored",
      "mcpServers is not supported (Yoma has no MCP); ignored",
      'effort is not supported (use "thinking" instead); ignored',
    ])
  })

  it("frontmatter 不是合法 YAML:跳过并报原因", () => {
    const { profile, diagnostics } = parse("---\nname: [unclosed\n---\nbody")
    expect(profile).toBeUndefined()
    expect(diagnostics[0]?.message).toContain("not valid YAML")
  })

  it("BOM 与 CRLF 都认", () => {
    const { profile } = parse("﻿---\r\nname: win\r\ndescription: saved by Notepad\r\n---\r\nline one\r\nline two\r\n")
    expect(profile).toMatchObject({ name: "win", description: "saved by Notepad", prompt: "line one\r\nline two" })
  })
})

describe("loadAgentProfiles", () => {
  it("内建 < 用户 < 项目(外层先、内层后);同名覆盖不改位置", async () => {
    const root = tempRoot()
    const configDir = path.join(root, "config")
    const cwd = path.join(root, "work", "proj", "sub")
    mkdirSync(cwd, { recursive: true })
    writeAgent(path.join(configDir, "agents"), "explore.md", "---\nname: Explore\ndescription: user explore\nmodel: deepseek/deepseek-v4-flash\n---\ncheap explore")
    writeAgent(path.join(root, "work", ".yoma", "agents"), "reviewer.md", "---\nname: reviewer\ndescription: outer\n---\nouter")
    const inner = writeAgent(path.join(cwd, ".yoma", "agents"), "reviewer.md", "---\nname: reviewer\ndescription: inner\n---\ninner")

    const { profiles, diagnostics } = await loadAgentProfiles({ cwd, configDir, homeDir: root })
    expect(diagnostics).toEqual([])
    expect(profiles.map((p) => p.name)).toEqual(["general-purpose", "Explore", "datasheet", "reviewer"])
    expect(profiles[1]).toMatchObject({ description: "user explore", source: "user", model: "deepseek/deepseek-v4-flash" })
    expect(profiles[3]).toMatchObject({ description: "inner", source: "project", filePath: inner })
  })

  it("祖先链走到 home 为止、不含 home;configDir 就在祖先链上时只读一次", async () => {
    const root = tempRoot()
    const home = path.join(root, "home")
    const cwd = path.join(home, "proj")
    mkdirSync(cwd, { recursive: true })
    // home 之上那一层的定义不该被读到(开发机真实的 ~/.yoma/agents 就是这么被挡住的)
    writeAgent(path.join(root, ".yoma", "agents"), "leak.md", "---\nname: leak\ndescription: above home\n---\n")

    const dirs = agentDirectories({ cwd, configDir: path.join(cwd, ".yoma"), homeDir: home })
    expect(dirs).toEqual([{ dir: path.join(cwd, ".yoma", "agents"), source: "user" }])

    const { profiles } = await loadAgentProfiles({ cwd, configDir: path.join(root, "config"), homeDir: home })
    expect(profiles.map((p) => p.name)).not.toContain("leak")
  })

  it("目录不存在不报错;坏文件的诊断带路径", async () => {
    const root = tempRoot()
    const cwd = path.join(root, "proj")
    mkdirSync(cwd)
    const bad = writeAgent(path.join(cwd, ".yoma", "agents"), "bad.md", "---\nname: bad name\ndescription: d\n---\n")
    const { profiles, diagnostics } = await loadAgentProfiles({ cwd, configDir: path.join(root, "none"), homeDir: root })
    expect(profiles.map((p) => p.name)).toEqual(BUILTIN_AGENTS.map((p) => p.name))
    expect(diagnostics).toEqual([expect.objectContaining({ path: bad })])
  })
})

describe("内建 agent", () => {
  it("缺省类型是 CC 的 general-purpose;三份定义各有提示词", () => {
    expect(DEFAULT_AGENT_TYPE).toBe("general-purpose")
    expect(BUILTIN_AGENTS.map((p) => p.name)).toEqual(["general-purpose", "Explore", "datasheet"])
    for (const profile of BUILTIN_AGENTS) expect(profile.prompt.length).toBeGreaterThan(200)
  })

  it("Explore 与 datasheet 是一次性的;Explore 不灌项目上下文", () => {
    const explore = BUILTIN_AGENTS.find((p) => p.name === "Explore")!
    expect(explore).toMatchObject({ oneShot: true, omitContextFiles: true })
    expect(BUILTIN_AGENTS.find((p) => p.name === "datasheet")?.oneShot).toBe(true)
    expect(BUILTIN_AGENTS.find((p) => p.name === "general-purpose")?.oneShot).toBeUndefined()
  })
})

describe("resolveAgentTools", () => {
  const all = [...TOOL_NAMES]

  it("缺省(全集):去掉子 agent 四件与五个硬件工具,其余按全集顺序", () => {
    const { tools, unknown } = resolveAgentTools(all, { tools: ["*"] })
    expect(tools).toEqual(all.filter((name) => !SUBAGENT_TOOL_NAMES.includes(name) && !HARDWARE_TOOL_NAMES.includes(name)))
    expect(tools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "toolchain", "datasheet", "netlist", "stm32config"])
    expect(unknown).toEqual([])
  })

  it("定义无权放开硬黑名单与硬件层;白名单按全集顺序,点了不存在的名字进 unknown", () => {
    const { tools, unknown } = resolveAgentTools(all, { tools: ["flash", "agent", "grep", "read", "no-such-tool"] })
    expect(tools).toEqual(["read", "grep"])
    expect(unknown).toEqual(["no-such-tool"])
  })

  it("黑名单优先于白名单", () => {
    expect(resolveAgentTools(all, { tools: ["read", "grep"], disallowedTools: ["grep"] }).tools).toEqual(["read"])
  })

  it("内建 Explore 与 datasheet 的实际工具集", () => {
    const explore = BUILTIN_AGENTS.find((p) => p.name === "Explore")!
    expect(resolveAgentTools(all, explore).tools).toEqual(["read", "bash", "grep", "find", "ls", "powershell", "datasheet", "netlist"])
    const datasheet = BUILTIN_AGENTS.find((p) => p.name === "datasheet")!
    expect(resolveAgentTools(all, datasheet).tools).toEqual(["read", "grep", "find", "ls", "datasheet"])
  })
})

describe("describeAgentTools(CC getToolsDescription)", () => {
  it("四种写法", () => {
    expect(describeAgentTools({})).toBe("All tools")
    expect(describeAgentTools({ tools: ["*"] })).toBe("All tools")
    expect(describeAgentTools({ disallowedTools: ["edit", "write"] })).toBe("All tools except edit, write")
    expect(describeAgentTools({ tools: ["read", "grep"] })).toBe("read, grep")
    expect(describeAgentTools({ tools: ["read", "grep"], disallowedTools: ["grep"] })).toBe("read")
    expect(describeAgentTools({ tools: ["grep"], disallowedTools: ["grep"] })).toBe("None")
  })
})

describe("lastAssistantText(CC finalizeAgentTool / extractPartialResult)", () => {
  const user = { role: "user", content: "task", timestamp: 1 } as AgentMessage
  const say = (text: string) => fauxAssistantMessage([fauxText(text)]) as AgentMessage
  const callOnly = fauxAssistantMessage([fauxToolCall("grep", { pattern: "x" })]) as AgentMessage

  it("取最后一条 assistant 的文字", () => {
    expect(lastAssistantText([user, say("first"), say("final answer")])).toBe("final answer")
  })

  it("最后一条是纯工具调用(比如命中 maxTurns)时往前找最近一条带文字的", () => {
    expect(lastAssistantText([user, say("partial finding"), callOnly])).toBe("partial finding")
  })

  it("一句文字都没有时交 undefined,由调用方换成占位句", () => {
    expect(lastAssistantText([user, callOnly])).toBeUndefined()
    expect(EMPTY_RESULT_MARKER).toBe("(Subagent completed but returned no output.)")
  })
})

describe("formatTaskNotification(CC enqueueAgentNotification 的形状)", () => {
  it("完成:字段齐全时逐行对上", () => {
    expect(
      formatTaskNotification({
        taskID: "s-1",
        toolCallID: "call-9",
        outputFile: "/tmp/yoma/p/tasks/s-1.output",
        status: "completed",
        description: "Trace clock tree",
        result: "SYSCLK 168 MHz",
        usage: { totalTokens: 1200, toolUses: 7, durationMs: 5300 },
      }),
    ).toBe(`<task-notification>
<task-id>s-1</task-id>
<tool-use-id>call-9</tool-use-id>
<output-file>/tmp/yoma/p/tasks/s-1.output</output-file>
<status>completed</status>
<summary>Agent "Trace clock tree" completed</summary>
<result>SYSCLK 168 MHz</result>
<usage><total_tokens>1200</total_tokens><tool_uses>7</tool_uses><duration_ms>5300</duration_ms></usage>
</task-notification>`)
  })

  it("可选段缺席时整行不出;失败与被停的 summary 照 CC", () => {
    expect(formatTaskNotification({ taskID: "s-2", outputFile: "/o", status: "killed", description: "d" })).toBe(`<task-notification>
<task-id>s-2</task-id>
<output-file>/o</output-file>
<status>killed</status>
<summary>Agent "d" was stopped</summary>
</task-notification>`)
    expect(notificationSummary("failed", "d", "rate limited")).toBe('Agent "d" failed: rate limited')
    expect(notificationSummary("failed", "d")).toBe('Agent "d" failed: Unknown error')
  })

  it("parseTaskNotification 是它的逆:字段齐全、多行结果、缺席的可选段都读得回来", () => {
    const full = {
      taskID: "s-1",
      toolCallID: "call-9",
      outputFile: "/tmp/yoma/p/tasks/s-1.output",
      status: "completed" as const,
      description: "Trace clock tree",
      result: "第一行\n第二行 <result>嵌套</result>\n<total_tokens>1</total_tokens>",
      usage: { totalTokens: 1200, toolUses: 7, durationMs: 5300 },
    }
    expect(parseTaskNotification(formatTaskNotification(full))).toEqual({
      taskID: "s-1",
      toolCallID: "call-9",
      outputFile: "/tmp/yoma/p/tasks/s-1.output",
      status: "completed",
      summary: 'Agent "Trace clock tree" completed',
      result: full.result,
      usage: full.usage,
    })
    expect(
      parseTaskNotification(
        formatTaskNotification({ taskID: "s-2", outputFile: "/o", status: "failed", description: "d", error: "boom" }),
      ),
    ).toEqual({ taskID: "s-2", outputFile: "/o", status: "failed", summary: 'Agent "d" failed: boom' })
  })
})
