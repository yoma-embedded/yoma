/**
 * 工具名集合的运行时钉法。
 *
 * 编译期钉法(details-check.ts 的 SameToolNames)在 my-pi 2026-08 精简后失效:
 * 它不再导出 ToolName 联合。这里改为真装配一遍工具(不跑、只构造)再逐名核对 ——
 * my-pi 增删工具或改名,这个测试立刻红,提醒去补/清 session-ui 渲染器、
 * 权限规则表和 types.ts 的 details 副本。
 */

import { describe, expect, test } from "bun:test"

import { NodeExecutionEnv } from "@yoma/my-pi/node"
import { createCodingToolDefinitions } from "@yoma/my-pi-coding-agent"

import { RETIRED_TOOL_NAMES, TOOL_NAMES } from "../types.ts"
import { createEmbeddedTools } from "./session-manager.ts"

describe("工具名集合", () => {
  test("my-pi 装配面 = TOOL_NAMES − RETIRED_TOOL_NAMES,逐字相同", () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() })
    const assembled = [...createCodingToolDefinitions(env), ...createEmbeddedTools(env)].map((t) => t.name)
    const retired: readonly string[] = RETIRED_TOOL_NAMES
    const live = TOOL_NAMES.filter((name) => !retired.includes(name))
    expect([...assembled].sort()).toEqual([...live].sort())
  })

  test("退役工具仍在视图词汇表里 —— 旧会话重放要认得", () => {
    const names: readonly string[] = TOOL_NAMES
    for (const retired of RETIRED_TOOL_NAMES) expect(names).toContain(retired)
  })
})
