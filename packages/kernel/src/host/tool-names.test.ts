/**
 * 工具名集合的运行时钉法。
 *
 * 真装配一遍工具(不跑、只构造)再逐名核对:内核增删工具或改名,这个测试立刻红 ——
 * 提醒去看 session-ui 的万能卡够不够用,以及 desktop 冒烟脚本里的期望清单。
 */

import { describe, expect, test } from "vitest"

import { TOOL_NAMES, diffToolNames } from "../types.ts"
import { createAgentTools } from "./session-manager.ts"
import { TOOL_CONTRACTS } from "./tools/contracts.ts"
import { createRegisteredTools } from "./tools/index.ts"

describe("工具名集合", () => {
  test("host 装配面 = TOOL_NAMES,逐字相同(连顺序)", () => {
    expect(createAgentTools().map((tool) => tool.name)).toEqual([...TOOL_NAMES])
    expect(diffToolNames(createAgentTools().map((tool) => tool.name))).toBeUndefined()
    expect(diffToolNames(["read", "bash", "edit", "write"])).toContain("TOOL_NAMES")
  })

  test("契约总表 = 登记的装配面,逐字相同(连顺序):漏登记契约的代价是守则静默不进提示词", () => {
    expect(TOOL_CONTRACTS.map((contract) => contract.name)).toEqual(createRegisteredTools().map((tool) => tool.name))
  })
})
