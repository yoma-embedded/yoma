/**
 * bash 的两处宿主加码(shell-guidance.ts)。钉的是:描述里的"别在 shell 里递归扫"只在手上真有 grep / find / ls 时才加,
 * 点名的就是真有的那几个;主会话不补缺省超时;子 agent 没给 timeout(或给了 null)就补 120、给了的原样,且先跑工具自己
 * 的 prepareArguments;改过说明的参数结构照样过得了发动机真用的那道校验(pi-ai 的 validateToolArguments)。
 * 会话里真发给模型的描述在 subagents.test.ts 的 (h)。
 */
import { describe, expect, it } from "vitest"
import { validateToolArguments } from "@earendil-works/pi-ai"
import { createBashTool } from "@earendil-works/pi-agent-core"

import type { RegisteredTool } from "./tools/index.ts"
import { bashSearchNote, SUBAGENT_BASH_TIMEOUT_SECONDS, withDefaultTimeout, withShellGuidance } from "./shell-guidance.ts"

const bash = () => createBashTool() as unknown as RegisteredTool
const read = { name: "read", label: "read", description: "Read a file", parameters: {} } as unknown as RegisteredTool

/** 走发动机的那两步:先 prepareArguments,再按工具的参数结构校验。 */
function prepared(tool: RegisteredTool, args: Record<string, unknown>): unknown {
  const call = { type: "toolCall" as const, id: "c1", name: tool.name, arguments: tool.prepareArguments ? tool.prepareArguments(args) : args }
  return validateToolArguments(tool as never, call as never)
}

describe("bash 描述里的找文件引导", () => {
  it("手上有 grep / find / ls 才加,点名的是真有的那几个;别的工具原样", () => {
    const [guided, untouched] = withShellGuidance([bash(), read], {
      activeToolNames: ["read", "bash", "grep", "ls"],
      subagent: false,
    })
    expect(guided!.description).toContain(bashSearchNote(["grep", "ls"]))
    expect(guided!.description).toContain("use the grep, ls tools instead")
    expect(untouched).toBe(read)
    const [plain] = withShellGuidance([bash()], { activeToolNames: ["bash"], subagent: false })
    expect(plain!.description).not.toContain("recursive file searches")
  })

  it("主会话:不补缺省超时,没给 timeout 就是没有", () => {
    const [guided] = withShellGuidance([bash()], { activeToolNames: ["bash", "grep"], subagent: false })
    expect(guided!.description).not.toContain("stopped after")
    expect(prepared(guided!, { command: "ls" })).toEqual({ command: "ls" })
  })
})

describe("子 agent 的缺省超时", () => {
  const [guided] = withShellGuidance([bash()], { activeToolNames: ["bash", "grep"], subagent: true })

  it("没给 timeout 或给了 null 就补 120;给了的原样;都过得了发动机的校验", () => {
    expect(SUBAGENT_BASH_TIMEOUT_SECONDS).toBe(120)
    expect(prepared(guided!, { command: "ls" })).toEqual({ command: "ls", timeout: 120 })
    expect(prepared(guided!, { command: "ls", timeout: null })).toEqual({ command: "ls", timeout: 120 })
    expect(prepared(guided!, { command: "make", timeout: 900 })).toEqual({ command: "make", timeout: 900 })
    // 参数结构换了说明之后,校验照旧:缺 command 仍然拒
    expect(() => prepared(guided!, { timeout: 5 })).toThrow()
  })

  it("描述与参数说明跟着说实话(上游原文是\"没有缺省超时\")", () => {
    expect(guided!.description).toContain("commands without a timeout are stopped after 120 seconds")
    expect(JSON.stringify(guided!.parameters)).toContain("Timeout in seconds (default 120 in this agent)")
    expect(JSON.stringify(guided!.parameters)).not.toContain("no default timeout")
  })

  it("先跑工具自己的 prepareArguments,再补缺省", () => {
    const own = {
      ...bash(),
      prepareArguments: (raw: unknown) => ({ ...(raw as Record<string, unknown>), command: "echo normalized" }),
    } as RegisteredTool
    expect(withDefaultTimeout(own, 30).prepareArguments!({ command: "x" })).toEqual({ command: "echo normalized", timeout: 30 })
  })
})
