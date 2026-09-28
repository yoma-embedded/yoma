import { afterEach, describe, expect, test } from "vitest"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { inspectProject, saveMemory } from "../../domain/project/store.ts"
import type { MemoryInput } from "../../domain/project/model.ts"
import type { ProjectInput } from "./contract.ts"
import { createProjectTool } from "./session.ts"

const roots: string[] = []
async function workspace() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "yoma-project-tool-")))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const memory = (title: string): MemoryInput => ({
  title,
  content: `${title} 的结论`,
  kind: "experience",
  confidence: "verified",
  evidence: "hw-20260928.log",
  scope: "",
  enabled: true,
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

function toolFor(root: string, sessionID = "s1") {
  const tool = createProjectTool({ sessionID })
  // 契约的 action 是 .map() 拼出来的联合,Static 推导塌成 never:这里按字面量写,交给 execute 前转一下。
  type Input = Omit<ProjectInput, "action"> & { action: "inspect" | "configure" | "search" | "remember" | "forget" }
  return (input: Input) =>
    tool.execute(
      "c1",
      input as ProjectInput,
      () => {},
      { env: new NodeExecutionEnv({ cwd: root }) },
      invocation,
      BACKGROUND_CONTEXT,
    )
}

describe("project 工具的 revision", () => {
  test("同一批里并行的几条 remember 拿同一个 revision:都记上,自己的写入不算冲突", async () => {
    const root = await workspace()
    const run = toolFor(root)
    const { revision } = await inspectProject(root)
    const results = await Promise.allSettled([
      run({ action: "remember", revision, memory: memory("根因") }),
      run({ action: "remember", revision, memory: memory("交接") }),
      run({ action: "remember", revision, memory: memory("接线") }),
    ])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])
    expect((await inspectProject(root)).memories.map((item) => item.title).sort()).toEqual(["交接", "接线", "根因"])
  })

  test("中间夹着别人的改动(界面、别的会话):照旧冲突,不替模型盖过去", async () => {
    const root = await workspace()
    const run = toolFor(root)
    const { revision } = await inspectProject(root)
    await run({ action: "remember", revision, memory: memory("我的") })
    const mine = (await inspectProject(root)).revision
    await saveMemory(root, mine, memory("用户在界面上加的"), "user")
    await expect(run({ action: "remember", revision, memory: memory("又一条") })).rejects.toThrow("已变化")
  })

  test("别的会话写过之后,本会话拿旧 revision 仍然冲突", async () => {
    const root = await workspace()
    const { revision } = await inspectProject(root)
    await toolFor(root, "other")({ action: "remember", revision, memory: memory("别人的") })
    await expect(toolFor(root, "mine")({ action: "remember", revision, memory: memory("我的") })).rejects.toThrow("已变化")
  })
})
