/**
 * ls 工具(host/tools/ls/session.ts)的验收。
 *
 * 这一组钉的是**文案**:三句错误("Path not found" / "Not a directory" / "Cannot read directory")
 * 与空态 "(empty directory)" 是模型已经学会的信号,换一个字就等于给它一套没见过的信号;
 * 加上两条 yoma 自有的决定 —— symlink 不加后缀(pi 那版 stat 跟随,指向目录的链接被印成 "name/",
 * 于是模型以为能 cd 进去),limit=0 钳到 1(pi 那版会让一个满的目录输出 "(empty directory)")。
 *
 * 排序只断言包含关系与全小写名字的顺序:localeCompare 对大小写混排的结果随 ICU/locale 抖。
 */

import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentHarnessToolInvocation, AgentToolResult } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import type { LsDetails, LsInput } from "../src/host/tools/ls/contract.ts"
import { createLsTool, formatEntry, sortEntryNames } from "../src/host/tools/ls/session.ts"

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

function createTempDir(): string {
  const dir = join(tmpdir(), `yoma-ls-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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

function makeTool(cwd: string) {
  const tool = createLsTool()
  return (
    params: LsInput = {},
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<AgentToolResult<LsDetails | undefined>> =>
    tool.execute("c1", params, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, context)
}

function textOf(result: AgentToolResult<LsDetails | undefined>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

describe("ls 工具", () => {
  it("列出 dotfile 与目录,目录带 / 后缀", async () => {
    const cwd = createTempDir()
    writeFileSync(join(cwd, "a.txt"), "a")
    writeFileSync(join(cwd, ".hidden-file"), "h")
    mkdirSync(join(cwd, ".hidden-dir"))
    mkdirSync(join(cwd, "src"))
    const lines = textOf(await makeTool(cwd)()).split("\n")
    expect(lines).toContain(".hidden-file")
    expect(lines).toContain(".hidden-dir/")
    expect(lines).toContain("src/")
    expect(lines).toContain("a.txt")
    expect(lines).toHaveLength(4)
  })

  it("path 相对会话 cwd 解析", async () => {
    const cwd = createTempDir()
    mkdirSync(join(cwd, "sub"))
    writeFileSync(join(cwd, "sub", "inner.txt"), "i")
    expect(textOf(await makeTool(cwd)({ path: "sub" }))).toBe("inner.txt")
  })

  it("不存在的路径报 Path not found 并带绝对路径", async () => {
    const cwd = createTempDir()
    await expect(makeTool(cwd)({ path: "nope" })).rejects.toThrow(`Path not found: ${join(cwd, "nope")}`)
  })

  it("不是目录报 Not a directory", async () => {
    const cwd = createTempDir()
    writeFileSync(join(cwd, "file.txt"), "f")
    await expect(makeTool(cwd)({ path: "file.txt" })).rejects.toThrow(`Not a directory: ${join(cwd, "file.txt")}`)
  })

  it("空目录返回 (empty directory),不带 details", async () => {
    const cwd = createTempDir()
    const result = await makeTool(cwd)()
    expect(textOf(result)).toBe("(empty directory)")
    expect(result.details).toBeUndefined()
  })

  it("到 limit 时截断并给翻倍建议", async () => {
    const cwd = createTempDir()
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(cwd, name), name)
    const result = await makeTool(cwd)({ limit: 2 })
    expect(textOf(result)).toBe("a.txt\nb.txt\n\n[2 entries limit reached. Use limit=4 for more]")
    expect(result.details).toEqual({ entryLimitReached: 2 })
  })

  it("limit=0 钳到 1,而不是把满目录说成空", async () => {
    const cwd = createTempDir()
    writeFileSync(join(cwd, "a.txt"), "a")
    writeFileSync(join(cwd, "b.txt"), "b")
    const text = textOf(await makeTool(cwd)({ limit: 0 }))
    expect(text).toContain("a.txt")
    expect(text).not.toContain("(empty directory)")
    expect(text).toContain("[1 entries limit reached. Use limit=2 for more]")
  })

  it("已经 abort 的上下文进门就抛", async () => {
    const cwd = createTempDir()
    const context = withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT)
    await expect(makeTool(cwd)({}, context)).rejects.toThrow("ls was aborted")
  })

  it("开跑之后点停止也要立刻结算:lstat 堵在死掉的网络盘上时用户不该等操作系统放弃", async () => {
    const cwd = createTempDir()
    // 一个永远不回来的 exists():冒充挂死的 SMB 映射盘。
    class HangingEnv extends NodeExecutionEnv {
      override exists(): ReturnType<NodeExecutionEnv["exists"]> {
        return new Promise(() => {})
      }
    }
    const controller = new AbortController()
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
    const pending = createLsTool().execute("c1", {}, () => {}, { env: new HangingEnv({ cwd }) }, invocation, context)
    setTimeout(() => controller.abort(), 50)
    const settled = await Promise.race([
      pending.then(
        () => "resolved",
        (error: Error) => error.message,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("still hanging after 1s"), 1000)),
    ])
    expect(settled).toBe("ls was aborted")
  })

  // Windows 上建目录符号链接要特权(开发者模式或管理员),建不了的机器会假红。
  describe.skipIf(process.platform === "win32")("符号链接", () => {
    it("指向目录的 symlink 不加任何后缀", async () => {
      const cwd = createTempDir()
      mkdirSync(join(cwd, "real"))
      symlinkSync(join(cwd, "real"), join(cwd, "link"))
      const lines = textOf(await makeTool(cwd)()).split("\n")
      expect(lines).toContain("real/")
      expect(lines).toContain("link")
    })

    it("把指向目录的 symlink 当 path 传进来时能列出目标内容", async () => {
      const cwd = createTempDir()
      mkdirSync(join(cwd, "real"))
      writeFileSync(join(cwd, "real", "inner.txt"), "i")
      symlinkSync(join(cwd, "real"), join(cwd, "link"))
      expect(textOf(await makeTool(cwd)({ path: "link" }))).toBe("inner.txt")
    })
  })

  it.skipIf(process.platform === "win32")("FIFO 这类非普通文件也列出来(串口设备节点就是这一类)", async () => {
    const dir = createTempDir()
    execFileSync("mkfifo", [join(dir, "fifo0")])
    writeFileSync(join(dir, "a.txt"), "a")
    const run = makeTool(dir)
    expect(textOf(await run({}))).toBe("a.txt\nfifo0")
  })

  it("formatEntry 只给目录加后缀", () => {
    expect(formatEntry({ name: "src", kind: "directory" })).toBe("src/")
    expect(formatEntry({ name: "a.txt", kind: "file" })).toBe("a.txt")
    expect(formatEntry({ name: "link", kind: "symlink" })).toBe("link")
  })

  it("sortEntryNames 大小写无关,且不改原数组", () => {
    const names = ["b.txt", "A.txt", "a.txt"]
    expect(sortEntryNames(names)).toContain("A.txt")
    expect(sortEntryNames(names).at(-1)).toBe("b.txt")
    expect(names).toEqual(["b.txt", "A.txt", "a.txt"])
  })
})
