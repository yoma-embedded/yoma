/**
 * grep 工具(host/tools/grep/session.ts)的验收:用自带的真 rg 跑一棵小文件树。
 *
 * 移植自 pi 的 tools.test.ts / 3302 / 3303 那几组里与 grep 有关的断言,再加 yoma 自己的决定:
 * 输出路径相对会话 cwd(上游搜单文件时退化成 basename)、.git/ 不进、到 limit 就杀 rg。
 * rg 住在 engines/bin(npm run engines:rg),缺席时这组跳过并警告;CI 上缺席直接红。
 */

import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path, { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  type AgentHarnessToolInvocation,
  type AgentToolResult,
  DEFAULT_MAX_BYTES,
  GREP_MAX_LINE_LENGTH,
} from "@earendil-works/pi-agent-core"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { exe } from "../src/host/domain/engines.ts"
import { GREP_CONTRACT, type GrepDetails, type GrepInput } from "../src/host/tools/grep/contract.ts"
import { createGrepTool, toRelativePosix } from "../src/host/tools/grep/session.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const enginesDir = path.resolve(here, "../../../engines")
const rgAvailable = existsSync(join(enginesDir, "bin", exe("rg")))
if (!rgAvailable) console.warn("engines/bin 里没有 rg,grep 的集成用例跳过 —— npm run engines:rg")

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

/** 一棵带 .gitignore 的小仓库:隐藏目录、被忽略的目录与文件、.git 里的诱饵各一份。 */
function makeRepo(): string {
  const root = join(tmpdir(), `yoma-grep-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(root, "src", "deep"), { recursive: true })
  mkdirSync(join(root, ".hidden"), { recursive: true })
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(root, "a.txt"), "hello world\nsecond hello\nthird line\n")
  writeFileSync(join(root, "lit.txt"), "arr[0] = 1\n")
  writeFileSync(join(root, "src", "main.c"), "int main() { return 0; }\n// TODO: hello\n")
  writeFileSync(join(root, "src", "deep", "x.spec.ts"), "describe('hello')\n")
  writeFileSync(join(root, ".hidden", "h.txt"), "hello hidden\n")
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "hello module\n")
  writeFileSync(join(root, "ignored.txt"), "hello ignored\n")
  writeFileSync(join(root, ".gitignore"), "node_modules/\nignored.txt\n")
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" })
  writeFileSync(join(root, ".git", "hello.txt"), "hello inside git\n")
  tempDirs.push(root)
  return root
}

function makeTool(cwd: string) {
  const tool = createGrepTool({ enginesDir })
  return (params: GrepInput, context: Context = BACKGROUND_CONTEXT): Promise<AgentToolResult<GrepDetails>> =>
    tool.execute("c1", params, () => {}, { env: new NodeExecutionEnv({ cwd }) }, invocation, context)
}

function textOf(result: AgentToolResult<GrepDetails>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

/** 正文里的匹配行(去掉尾部 [通知])。 */
function matchLines(result: AgentToolResult<GrepDetails>): string[] {
  return textOf(result)
    .split("\n\n[")[0]!
    .split("\n")
    .filter(Boolean)
}

it("CI 上必须有 rg:没有就是工作流少了 engines:rg 那一步,不能静默跳过", () => {
  if (process.env.CI) expect(rgAvailable).toBe(true)
})

describe("grep 契约", () => {
  it("description 里的数字与内核的截断常量一致(契约门不许 import 它们,只能靠这条钉)", () => {
    expect(GREP_CONTRACT.description).toContain(`${DEFAULT_MAX_BYTES / 1024}KB`)
    expect(GREP_CONTRACT.description).toContain(`${GREP_MAX_LINE_LENGTH} chars`)
    expect(GREP_CONTRACT.description).toContain("100 matches")
  })

  it("summary:pattern 加 glob", () => {
    expect(GREP_CONTRACT.summary({})).toBe("")
    expect(GREP_CONTRACT.summary({ pattern: "TODO" })).toBe("TODO")
    expect(GREP_CONTRACT.summary({ pattern: "TODO", glob: "*.c" })).toBe("TODO in *.c")
  })

  it("toRelativePosix:相对根 + 正斜杠,根自己是 '.'", () => {
    expect(toRelativePosix("/p", "/p/src/a.c")).toBe("src/a.c")
    expect(toRelativePosix("/p", "/p")).toBe(".")
    expect(toRelativePosix("/p", "rel/x")).toBe("rel/x")
  })
})

describe.skipIf(!rgAvailable)("grep 工具(真 rg)", () => {
  it("匹配行是 <相对路径>:<行号>: <文本>,隐藏目录进、.git 与 .gitignore 不进", async () => {
    const run = makeTool(makeRepo())
    const lines = matchLines(await run({ pattern: "hello" }))
    expect(lines).toContain("a.txt:1: hello world")
    expect(lines).toContain("a.txt:2: second hello")
    expect(lines).toContain("src/main.c:2: // TODO: hello")
    expect(lines).toContain(".hidden/h.txt:1: hello hidden")
    expect(lines.some((line) => line.startsWith(".git/"))).toBe(false)
    expect(lines.some((line) => line.startsWith("node_modules/"))).toBe(false)
    expect(lines.some((line) => line.startsWith("ignored.txt"))).toBe(false)
  })

  it("没命中是正常结果,不是错误", async () => {
    const run = makeTool(makeRepo())
    expect(textOf(await run({ pattern: "zzz-nothing" }))).toBe("No matches found")
  })

  it("到 limit 就停:只回 limit 条,带提示与 details", async () => {
    const run = makeTool(makeRepo())
    const result = await run({ pattern: "hello", limit: 2 })
    expect(matchLines(result)).toHaveLength(2)
    expect(textOf(result)).toContain("2 matches limit reached. Use limit=4")
    expect(result.details.matchLimitReached).toBe(2)
  })

  it("ignoreCase 与 literal 各自生效", async () => {
    const run = makeTool(makeRepo())
    expect(textOf(await run({ pattern: "HELLO WORLD" }))).toBe("No matches found")
    expect(matchLines(await run({ pattern: "HELLO WORLD", ignoreCase: true }))).toEqual(["a.txt:1: hello world"])
    // 正则里 arr[0] 是字符类,匹不到 "arr[0]";literal 才是字面量。
    expect(textOf(await run({ pattern: "arr[0]" }))).toBe("No matches found")
    expect(matchLines(await run({ pattern: "arr[0]", literal: true }))).toEqual(["lit.txt:1: arr[0] = 1"])
  })

  it("glob 只搜命中的文件(锚定写法也认,且挑不掉 .gitignore 的活);path 指向单个文件时路径照样相对 cwd", async () => {
    const run = makeTool(makeRepo())
    expect(matchLines(await run({ pattern: "hello", glob: "*.c" }))).toEqual(["src/main.c:2: // TODO: hello"])
    expect(matchLines(await run({ pattern: "hello", glob: "src/**/*.ts" }))).toEqual([
      "src/deep/x.spec.ts:1: describe('hello')",
    ])
    expect(textOf(await run({ pattern: "hello", glob: "*.js" }))).toBe("No matches found")
    expect(matchLines(await run({ pattern: "hello", path: "a.txt" }))).toEqual([
      "a.txt:1: hello world",
      "a.txt:2: second hello",
    ])
  })

  it("context 行用 <路径>-<行号>- 形状,夹着匹配行", async () => {
    const run = makeTool(makeRepo())
    const lines = matchLines(await run({ pattern: "second", context: 1 }))
    expect(lines).toEqual(["a.txt-1- hello world", "a.txt:2: second hello", "a.txt-3- third line"])
  })

  it("重叠上下文只输出一次,相邻命中仍保留匹配标记", async () => {
    const run = makeTool(makeRepo())
    expect(matchLines(await run({ pattern: "hello", path: "a.txt", context: 1 }))).toEqual([
      "a.txt:1: hello world", "a.txt:2: second hello", "a.txt-3- third line",
    ])
  })

  it("密集命中不让重复上下文挤掉后面的证据,不同文件的同行号各自保留", async () => {
    const root = makeRepo()
    for (const name of ["dense-a.txt", "dense-b.txt"]) {
      writeFileSync(join(root, name), Array.from({ length: 100 }, (_, i) => `evidence ${i + 1}`).join("\n"))
    }
    const result = await makeTool(root)({ pattern: "evidence", glob: "dense-*.txt", context: 10, limit: 300 })
    const lines = matchLines(result)
    expect(lines).toHaveLength(200)
    expect(new Set(lines).size).toBe(200)
    expect(lines).toContain("dense-a.txt:100: evidence 100")
    expect(lines).toContain("dense-b.txt:100: evidence 100")
    expect(lines.every(line => /^dense-[ab]\.txt:\d+: evidence \d+$/.test(line))).toBe(true)
    expect(result.details?.truncation).toBeUndefined()
  })

  it("flag 形状的 pattern 当文本搜,不当 rg 的参数", async () => {
    const run = makeTool(makeRepo())
    expect(textOf(await run({ pattern: "--pre=./x.sh" }))).toBe("No matches found")
  })

  it("坏正则把 rg 的报错原样透出;不存在的 path 在起子进程之前就拒", async () => {
    const run = makeTool(makeRepo())
    await expect(run({ pattern: "(" })).rejects.toThrow(/regex|parse/i)
    await expect(run({ pattern: "x", path: "nope" })).rejects.toThrow(/Path not found/)
  })

  it("不在 git 仓库里也尊重 .gitignore(--no-require-git)", async () => {
    const root = join(tmpdir(), `yoma-grep-plain-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(root, "node_modules"), { recursive: true })
    tempDirs.push(root)
    writeFileSync(join(root, "node_modules", "x.js"), "hello module\n")
    writeFileSync(join(root, "app.js"), "hello app\n")
    writeFileSync(join(root, ".gitignore"), "node_modules/\n")
    const run = makeTool(root)
    expect(matchLines(await run({ pattern: "hello" }))).toEqual(["app.js:1: hello app"])
  })

  // Windows 上建目录符号链接要特权,建不了的机器会假红。
  it.skipIf(process.platform === "win32")("path 是指向目录的符号链接:当目录搜,路径相对会话 cwd", async () => {
    const root = makeRepo()
    symlinkSync(join(root, "src"), join(root, "link"), "dir")
    const run = makeTool(root)
    // 上一版 lstat 答 "symlink" → 当单文件搜:rg 拿到一个目录参数照样递归,但 glob 锚点挪到会话 cwd,
    // 这里 glob 写成相对 link 的形状就匹不到了。
    expect(matchLines(await run({ pattern: "hello", path: "link", glob: "deep/*.ts" }))).toEqual([
      "link/deep/x.spec.ts:1: describe('hello')",
    ])
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "一个读不动的目录不该丢掉全部命中:结果照给,尾部说明不全",
    async () => {
      const root = makeRepo()
      mkdirSync(join(root, "locked"))
      writeFileSync(join(root, "locked", "secret.txt"), "hello locked\n")
      chmodSync(join(root, "locked"), 0o000)
      try {
        const run = makeTool(root)
        const result = await run({ pattern: "hello" })
        expect(matchLines(result)).toContain("a.txt:1: hello world")
        expect(textOf(result)).toContain("partial results:")
        expect(result.details.partial).toBe(true)
      } finally {
        chmodSync(join(root, "locked"), 0o755)
      }
    },
  )

  it("这一轮已被停掉:不起子进程,直接抛 aborted", async () => {
    const run = makeTool(makeRepo())
    await expect(run({ pattern: "hello" }, withAbortSignal(AbortSignal.abort(), BACKGROUND_CONTEXT))).rejects.toThrow(
      "was aborted",
    )
  })
})
