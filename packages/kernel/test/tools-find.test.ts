/**
 * find 工具(host/tools/find/session.ts)的验收:用自带的真 rg --files 跑一棵小文件树。
 *
 * 移植自 pi 的 3302(glob 四种写法)、3303(嵌套 .gitignore 的作用域)、6104(路径相对化)与
 * tools.test.ts 里 find 的几条,再加换引擎后的决定:只出文件不出目录、limit 在 JS 侧杀进程、
 * `!` 与 `/` 开头的 pattern 当场拒。rg 缺席时集成用例跳过并警告;CI 上缺席直接红。
 */

import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path, { join } from "node:path"
import { fileURLToPath } from "node:url"

import { type AgentHarnessToolInvocation, type AgentToolResult, DEFAULT_MAX_BYTES } from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { exe } from "../src/host/domain/engines.ts"
import { FIND_CONTRACT, type FindDetails, type FindInput } from "../src/host/tools/find/contract.ts"
import { createFindTool, relativizeFindResultPath } from "../src/host/tools/find/session.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const enginesDir = path.resolve(here, "../../../engines")
const rgAvailable = existsSync(join(enginesDir, "bin", exe("rg")))
if (!rgAvailable) console.warn("engines/bin 里没有 rg,find 的集成用例跳过 —— npm run engines:rg")

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
}

function tempRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  tempDirs.push(root)
  return root
}

/** 一棵小仓库:深层 spec、隐藏文件、被忽略的目录、.git 里的诱饵、嵌套子仓库各一份。 */
function makeRepo(): string {
  const root = tempRoot("yoma-find")
  mkdirSync(join(root, "src", "deep"), { recursive: true })
  mkdirSync(join(root, ".hidden"), { recursive: true })
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
  mkdirSync(join(root, "nested", "sub"), { recursive: true })
  writeFileSync(join(root, "a.txt"), "a\n")
  writeFileSync(join(root, "app.js"), "1\n")
  writeFileSync(join(root, "src", "main.c"), "int main;\n")
  writeFileSync(join(root, "src", "deep", "x.spec.ts"), "x\n")
  writeFileSync(join(root, ".hidden", "h.txt"), "h\n")
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "m\n")
  writeFileSync(join(root, ".gitignore"), "node_modules/\n*.log\n")
  writeFileSync(join(root, "debug.log"), "log\n")
  // 嵌套子仓库:它自己的 .gitignore 只管自己那一棵,父级的 *.log 不该越界进去。
  writeFileSync(join(root, "nested", ".gitignore"), "sub/\n")
  writeFileSync(join(root, "nested", "keep.log"), "kept by nested repo\n")
  writeFileSync(join(root, "nested", "sub", "gone.txt"), "ignored by nested\n")
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" })
  execFileSync("git", ["init", "-q"], { cwd: join(root, "nested"), stdio: "pipe" })
  writeFileSync(join(root, ".git", "hello.txt"), "inside git\n")
  return root
}

function makeTool(cwd: string) {
  const tool = createFindTool({ enginesDir })
  return (params: FindInput, context: Context = BACKGROUND_CONTEXT): Promise<AgentToolResult<FindDetails>> =>
    tool.execute("c1", params, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, context)
}

function textOf(result: AgentToolResult<FindDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

function resultLines(result: AgentToolResult<FindDetails>): string[] {
  return textOf(result)
    .split("\n\n[")[0]!
    .split("\n")
    .filter(Boolean)
}

it("CI 上必须有 rg:没有就是工作流少了 engines:rg 那一步,不能静默跳过", () => {
  if (process.env.CI) expect(rgAvailable).toBe(true)
})

describe("find 契约与纯函数", () => {
  it("description 里的数字与内核的截断常量一致", () => {
    expect(FIND_CONTRACT.description).toContain(`${DEFAULT_MAX_BYTES / 1024}KB`)
    expect(FIND_CONTRACT.description).toContain("1000 results")
    expect(FIND_CONTRACT.description).toContain("Only files are returned")
  })

  it("relativizeFindResultPath:盘根与同名前缀的兄弟目录都不能按长度切(6104)", () => {
    const w = path.win32
    expect(relativizeFindResultPath("I:\\proj\\a.c", "I:\\proj", w)).toBe("a.c")
    expect(relativizeFindResultPath("I:\\a.c", "I:\\", w)).toBe("a.c")
    expect(relativizeFindResultPath("I:\\proj\\Models2\\x.c", "I:\\proj", w)).toBe("Models2/x.c")
    expect(relativizeFindResultPath("I:\\proj\\dir\\", "I:\\proj", w)).toBe("dir/")
    expect(relativizeFindResultPath("/p/src/a.c", "/p", path.posix)).toBe("src/a.c")
  })
})

describe.skipIf(!rgAvailable)("find 工具(真 rg --files)", () => {
  it("glob 四种写法(3302):basename、目录前缀 + **、前导 **、src/**/*.spec.ts", async () => {
    const run = makeTool(makeRepo())
    expect(resultLines(await run({ pattern: "*.c" }))).toEqual(["src/main.c"])
    expect(resultLines(await run({ pattern: "src/**" }))).toEqual(["src/deep/x.spec.ts", "src/main.c"])
    expect(resultLines(await run({ pattern: "**/x.spec.ts" }))).toEqual(["src/deep/x.spec.ts"])
    expect(resultLines(await run({ pattern: "src/**/*.spec.ts" }))).toEqual(["src/deep/x.spec.ts"])
  })

  it("隐藏文件进,.git/ 与 .gitignore 的目录不进,输出按路径排序", async () => {
    const run = makeTool(makeRepo())
    const lines = resultLines(await run({ pattern: "*" }))
    expect(lines).toContain(".hidden/h.txt")
    expect(lines).toContain("app.js")
    expect(lines.some((line) => line.startsWith(".git/"))).toBe(false)
    expect(lines.some((line) => line.startsWith("node_modules/"))).toBe(false)
    expect(lines).not.toContain("debug.log")
    expect([...lines].sort()).toEqual(lines)
  })

  it("嵌套子仓库(3303):子仓库自己的 .gitignore 生效,父级的规则不越界进去", async () => {
    const run = makeTool(makeRepo())
    const lines = resultLines(await run({ pattern: "*" }))
    expect(lines).not.toContain("nested/sub/gone.txt")
    expect(lines).toContain("nested/keep.log")
  })

  it("不在 git 仓库里也尊重 .gitignore(--no-require-git)", async () => {
    const root = tempRoot("yoma-find-plain")
    mkdirSync(join(root, "node_modules"), { recursive: true })
    writeFileSync(join(root, "node_modules", "x.js"), "x\n")
    writeFileSync(join(root, "app.js"), "1\n")
    writeFileSync(join(root, ".gitignore"), "node_modules/\n")
    const run = makeTool(root)
    expect(resultLines(await run({ pattern: "*.js" }))).toEqual(["app.js"])
  })

  it("到 limit 就停:只回 limit 条,带提示与 details", async () => {
    const run = makeTool(makeRepo())
    const result = await run({ pattern: "*", limit: 2 })
    expect(resultLines(result)).toHaveLength(2)
    expect(textOf(result)).toContain("2 results limit reached. Use limit=4")
    expect(result.details.resultLimitReached).toBe(2)
  })

  it("没命中是正常结果;没闭合的 [ 不炸,当作匹不到;glob 挑不掉 .gitignore 的活", async () => {
    const run = makeTool(makeRepo())
    expect(textOf(await run({ pattern: "*.nope" }))).toBe("No files found matching pattern")
    expect(textOf(await run({ pattern: "[" }))).toBe("No files found matching pattern")
    // rg 的 --glob 会把被忽略的目录放回来;这里 glob 在 JS 侧做,node_modules 里的 .js 仍然不出。
    expect(resultLines(await run({ pattern: "*.js" }))).toEqual(["app.js"])
  })

  it("! 与 / 开头的 pattern 当场拒;不存在的 path 也拒", async () => {
    const run = makeTool(makeRepo())
    await expect(run({ pattern: "!*.c" })).rejects.toThrow(/must not start with '!'/)
    await expect(run({ pattern: "/src/*.c" })).rejects.toThrow(/must be relative/)
    await expect(run({ pattern: "*", path: "nope" })).rejects.toThrow(/Path not found/)
    await expect(run({ pattern: "*", path: "a.txt" })).rejects.toThrow(/must be a directory/)
  })

  it("这一轮已被停掉:不起子进程,直接抛 aborted", async () => {
    const run = makeTool(makeRepo())
    await expect(run({ pattern: "*" }, withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT))).rejects.toThrow(
      "was aborted",
    )
  })
})
