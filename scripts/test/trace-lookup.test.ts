/**
 * `npm run trace` 找文件的那一半:按 id 前缀 / 路径 / 最近一个找会话,按 userData 找各次启动的轨迹,按文件头找子会话。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { childSessions, findSession, readHeader, traceFiles, userDataRoots } from "../trace-lookup.ts"

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 一个假的 userData:两个会话(一个是另一个的子 agent)+ 两次启动的日志目录。 */
function userData() {
  const root = mkdtempSync(path.join(tmpdir(), "yoma-userdata-"))
  roots.push(root)
  const project = path.join(root, "sessions", "--D--proj--")
  mkdirSync(project, { recursive: true })
  const parent = path.join(project, "2026-09-24T06-56-51-297Z_01a0d233-e461-7107-9408-2284891e1018.jsonl")
  const child = path.join(project, "2026-09-24T07-00-00-000Z_01a0d299-0000-7107-9408-000000000001.jsonl")
  writeFileSync(parent, `${JSON.stringify({ v: 4, kind: "header", id: "01a0d233-e461-7107-9408-2284891e1018" })}\n`)
  writeFileSync(
    child,
    `${JSON.stringify({ v: 4, kind: "header", id: "01a0d299-0000-7107-9408-000000000001", parentSessionId: "01a0d233-e461-7107-9408-2284891e1018" })}\n`,
  )
  // 让父会话是"最近改过的"那个
  const now = Date.now() / 1000
  utimesSync(child, now - 100, now - 100)
  utimesSync(parent, now, now)
  for (const run of ["20260924T065550", "20260924T071000"]) {
    mkdirSync(path.join(root, "logs", run), { recursive: true })
  }
  writeFileSync(path.join(root, "logs", "20260924T065550", "trace.jsonl"), "")
  writeFileSync(path.join(root, "logs", "20260924T065550", "trace.1.jsonl"), "")
  writeFileSync(path.join(root, "logs", "20260924T065550", "main.log"), "")
  return { root, parent, child }
}

describe("trace-lookup", () => {
  it("按 id 前缀找、按路径找、不给就取最近改过的", () => {
    const { root, parent, child } = userData()
    expect(findSession("01a0d299", [root])?.file).toBe(child)
    expect(findSession(undefined, [root])?.file).toBe(parent)
    const byPath = findSession(child, [])!
    expect(byPath.file).toBe(path.resolve(child))
    expect(path.resolve(byPath.root)).toBe(path.resolve(root))
    expect(findSession("nope", [root])).toBeUndefined()
  })

  it("轨迹:各次启动目录里的 trace.jsonl 与轮转出来的 trace.1.jsonl,旧的在前;别的日志不算", () => {
    const { root } = userData()
    expect(traceFiles(root)).toEqual([
      path.join(root, "logs", "20260924T065550", "trace.1.jsonl"),
      path.join(root, "logs", "20260924T065550", "trace.jsonl"),
    ])
    expect(traceFiles(path.join(root, "nope"))).toEqual([])
  })

  it("子会话按文件头的 parentSessionId 认;文件头只读开头", () => {
    const { parent, child } = userData()
    expect(readHeader(parent)).toMatchObject({ kind: "header" })
    expect(childSessions(parent, "01a0d233-e461-7107-9408-2284891e1018")).toEqual([
      { id: "01a0d299-0000-7107-9408-000000000001", file: child },
    ])
  })

  it("userData 的位置按平台算,只留存在的", () => {
    const { root } = userData()
    const appData = path.dirname(root)
    const name = path.basename(root)
    // 假的 APPDATA 下没有 com.yoma.desktop* 目录:一个都不返回
    expect(userDataRoots({ APPDATA: appData }, "win32").some((dir) => dir.endsWith(name))).toBe(false)
    expect(userDataRoots({ APPDATA: path.join(appData, "definitely-missing") }, "win32")).toEqual([])
  })
})
