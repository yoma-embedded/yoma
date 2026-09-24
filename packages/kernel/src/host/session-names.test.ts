/**
 * 不打开会话读会话名(host/session-names.ts)。
 *
 * 头一组是**上游哨兵**:名字用真的 JsonlSessionRepo 写进去,再按字节读回来。packages/agent 一改 JSONL 的写法
 * (换了 namespace、换了字段顺序、换了事务的包法),这里先红 —— 否则表现是"重启之后侧栏里全是工程目录名",
 * 没有任何报错。后一组手搓文件,钉住扫描本身的边界:行跨块、超长行、转义过的同名字样、多条写的事务。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, test } from "vitest"
import { BACKGROUND_CONTEXT, JsonlSessionRepo, sessionName } from "@earendil-works/pi-agent-core"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"

import { readSessionName } from "./session-names.ts"

const ctx = BACKGROUND_CONTEXT
const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function repoIn(root: string) {
  return new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: path.join(root, "sessions") })
}

/** 一条用户消息;`text` 可以很长(撑出一条超过读块的行)。 */
function userMessage(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() }
}

describe("上游哨兵:真 repo 写的名字按字节读得回来", () => {
  test("setName 之后读得到;改名以后写的为准;删掉名字就是没有", async () => {
    const root = tempDir("yoma-names-")
    const session = await repoIn(root).create({ cwd: root }, ctx)
    const file = session.metadata.path
    expect(await readSessionName(file)).toBeUndefined()

    await session.setName("STM32 串口乱码排查", ctx)
    expect(await readSessionName(file)).toBe("STM32 串口乱码排查")

    const branch = await session.createBranch("main", null, ctx)
    await branch.appendMessage(userMessage("接着聊"), ctx)
    await session.setName("改过的名字 \"带引号\"", ctx)
    expect(await readSessionName(file)).toBe('改过的名字 "带引号"')

    await session.setName(undefined, ctx)
    expect(await readSessionName(file)).toBeUndefined()
    await session.close(ctx)
  })

  test("名字前后隔着超过读块的大消息(大段日志)也读得到", async () => {
    const root = tempDir("yoma-names-")
    const session = await repoIn(root).create({ cwd: root }, ctx)
    const branch = await session.createBranch("main", null, ctx)
    await branch.appendMessage(userMessage("日志:" + "x".repeat(3 * 1024 * 1024)), ctx)
    await session.setName("大日志之后起的名", ctx)
    await branch.appendMessage(userMessage("又一段:" + "y".repeat(2 * 1024 * 1024)), ctx)
    await session.close(ctx)
    expect(await readSessionName(session.metadata.path)).toBe("大日志之后起的名")
  })

  test("消息正文里出现同样的字样不算名字(JSONL 里是转义过的)", async () => {
    const root = tempDir("yoma-names-")
    const session = await repoIn(root).create({ cwd: root }, ctx)
    const branch = await session.createBranch("main", null, ctx)
    const forged = `{"kind":"value","op":"set","seq":99,"namespace":"${sessionName.namespace}","key":"","value":"伪造的名字"}`
    await branch.appendMessage(userMessage(`看看这一行:\n${forged}\n`), ctx)
    await session.close(ctx)
    expect(await readSessionName(session.metadata.path)).toBeUndefined()
  })
})

describe("扫描本身的边界", () => {
  const nameLine = (name: string, seq = 1) =>
    JSON.stringify({ kind: "value", op: "set", seq, namespace: sessionName.namespace, key: "", value: name })
  const header = JSON.stringify({ v: 4, kind: "header", id: "x", storageVersion: 1, createdAt: 0, cwd: "/w" })

  test("要找的那串字节正好跨在两个读块(1 MiB)之间", async () => {
    const file = path.join(tempDir("yoma-names-"), "s.jsonl")
    // 名字那一行从 1 MiB 前 45 字节开始;行首 `{"kind":"value","op":"set","seq":2,` 占 35 字节,
    // 于是 `"namespace":"pi.session.name"` 这 30 字节有 10 个在前一块、20 个在后一块。
    const start = (1 << 20) - 45
    const base = JSON.stringify({ kind: "usage", seq: 1, pad: "" }).length
    const pad = JSON.stringify({ kind: "usage", seq: 1, pad: "p".repeat(start - header.length - 2 - base) })
    expect(Buffer.byteLength(`${header}\n${pad}\n`)).toBe(start)
    writeFileSync(file, `${header}\n${pad}\n${nameLine("跨块的名字", 2)}\n`)
    expect(await readSessionName(file)).toBe("跨块的名字")
  })

  test("一行里是多条写的事务(数组)也认", async () => {
    const file = path.join(tempDir("yoma-names-"), "s.jsonl")
    const tx = `[${JSON.stringify({ kind: "usage", seq: 1 })},${nameLine("事务里的名字", 2)}]`
    writeFileSync(file, `${header}\n${tx}\n`)
    expect(await readSessionName(file)).toBe("事务里的名字")
  })

  test("没写完的最后一行(没有换行结尾)不算;文件不在、内容是乱的都只是没有名字", async () => {
    const dir = tempDir("yoma-names-")
    const torn = path.join(dir, "torn.jsonl")
    writeFileSync(torn, `${header}\n${nameLine("旧名")}\n${nameLine("写到一半", 2).slice(0, -5)}`)
    expect(await readSessionName(torn)).toBe("旧名")

    const garbage = path.join(dir, "garbage.jsonl")
    writeFileSync(garbage, `not json\n{"namespace":"${sessionName.namespace}" broken\n`)
    expect(await readSessionName(garbage)).toBeUndefined()
    expect(await readSessionName(path.join(dir, "missing.jsonl"))).toBeUndefined()
  })
})
