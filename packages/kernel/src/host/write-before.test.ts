/**
 * write 工具交代它覆盖掉了什么(write-before.ts):在真文件系统上跑上游的 write,看 details.before。
 * 时间线的「本轮改动」靠这一份算 diff —— 记错了(覆盖说成新建、旧内容是写完之后的)屏幕上就是一份假 diff。
 */

import { afterEach, describe, expect, test } from "vitest"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { type AgentHarnessToolInvocation, createWriteTool } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { createAgentTools } from "./session-manager.ts"
import { WRITE_BEFORE_LIMIT, withOverwrittenContent } from "./write-before.ts"

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

function workspace() {
  const root = join(tmpdir(), `yoma-write-before-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  tempDirs.push(root)
  const tool = withOverwrittenContent(createWriteTool())
  const write = (path: string, content: string) =>
    tool.execute(
      "c1",
      { path, content },
      () => {},
      { env: new NodeExecutionEnv({ cwd: root }) },
      invocation,
      BACKGROUND_CONTEXT,
    )
  return { root, write }
}

describe("withOverwrittenContent", () => {
  test("新建的文件记 before: null,文件照常写出", async () => {
    const { root, write } = workspace()
    const result = await write("src/main.c", "int main(void) { return 0; }\n")
    expect(result.details).toEqual({ before: null })
    expect(readFileSync(join(root, "src/main.c"), "utf8")).toBe("int main(void) { return 0; }\n")
    expect(result.content).toEqual([{ type: "text", text: "Successfully wrote to src/main.c" }])
  })

  test("覆盖已有文件时记下的是写之前的内容,不是写之后的", async () => {
    const { root, write } = workspace()
    writeFileSync(join(root, "config.h"), "#define BAUD 9600\n")
    const result = await write("config.h", "#define BAUD 115200\n")
    expect(result.details).toEqual({ before: "#define BAUD 9600\n" })
    expect(readFileSync(join(root, "config.h"), "utf8")).toBe("#define BAUD 115200\n")
  })

  test("绝对路径与 @ 前缀和上游同解:覆盖不会被说成新建", async () => {
    const { root, write } = workspace()
    writeFileSync(join(root, "a.txt"), "old\n")
    expect((await write(join(root, "a.txt"), "mid\n")).details).toEqual({ before: "old\n" })
    expect((await write("@a.txt", "new\n")).details).toEqual({ before: "mid\n" })
    expect(existsSync(join(root, "@a.txt"))).toBe(false)
  })

  test("旧文件过大就不记(会话文件不为每次覆盖多存一份大文件),写入不受影响", async () => {
    const { root, write } = workspace()
    writeFileSync(join(root, "big.log"), "x".repeat(WRITE_BEFORE_LIMIT + 1))
    const result = await write("big.log", "trimmed\n")
    expect(result.details).toBeUndefined()
    expect(readFileSync(join(root, "big.log"), "utf8")).toBe("trimmed\n")
  })

  test("被覆盖的是二进制文件时不记", async () => {
    const { root, write } = workspace()
    writeFileSync(join(root, "blob.bin"), Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 0, 0, 1))
    expect((await write("blob.bin", "text now\n")).details).toBeUndefined()
  })

  test("写失败照旧抛出,不被这一层吞掉", async () => {
    const { root, write } = workspace()
    mkdirSync(join(root, "dir"))
    await expect(write("dir", "x")).rejects.toThrow()
  })
})

test("交给 agent 的 write 就是包过的那一个", async () => {
  const root = join(tmpdir(), `yoma-write-before-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  tempDirs.push(root)
  const tool = createAgentTools().find((item) => item.name === "write")!
  const result = await tool.execute(
    "c1",
    { path: "new.txt", content: "hi\n" },
    () => {},
    { env: new NodeExecutionEnv({ cwd: root }) },
    invocation,
    BACKGROUND_CONTEXT,
  )
  expect(result.details).toEqual({ before: null })
})
