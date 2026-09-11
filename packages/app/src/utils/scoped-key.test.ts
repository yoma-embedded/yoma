import { describe, expect, test } from "vitest"
import { LOCAL_SCOPE, ScopedKey, SessionRouteKey, SessionStateKey, migrateLegacySessionStateKeys } from "./scoped-key"

const NUL = String.fromCharCode(0)

/**
 * 这些断言钉的是**用户硬盘上已有的字节**。多服务器拆掉以后 scope 参数消失了,但键的形状
 * 一个字符都不能动 —— 改了就等于把用户的草稿、行评论、文件视图、已读状态全部作废。
 * 任何一条挂了,不要改断言,去改实现。
 */
describe("scoped key bytes", () => {
  test("scope prefix is the literal \"local\"", () => {
    expect(LOCAL_SCOPE).toBe("local")
  })

  test("session state key keeps the local\\0<dir>/<session> shape", () => {
    const route = SessionRouteKey.fromRoute("cmVwbw", "session-1")
    expect(String(route)).toBe("cmVwbw/session-1")
    expect(String(SessionStateKey.from(route))).toBe(`local${NUL}cmVwbw/session-1`)
  })

  test("workspace-only session state key has no trailing slash", () => {
    expect(String(SessionStateKey.from(SessionRouteKey.fromRoute("cmVwbw")))).toBe(`local${NUL}cmVwbw`)
  })

  test("session state key round-trips back to its route", () => {
    expect(String(SessionStateKey.route(`local${NUL}cmVwbw/session-1`))).toBe("cmVwbw/session-1")
    expect(String(SessionStateKey.route("cmVwbw/session-1"))).toBe("cmVwbw/session-1")
  })

  test("leftover remote entries are recognised as not local", () => {
    expect(SessionStateKey.isLocal(`local${NUL}cmVwbw/session-1`)).toBe(true)
    expect(SessionStateKey.isLocal("cmVwbw/session-1")).toBe(true)
    expect(SessionStateKey.isLocal(`https://debian.example${NUL}cmVwbw/session-1`)).toBe(false)
  })

  test("scoped keys join on NUL after the local prefix", () => {
    expect(String(ScopedKey.from("/home/luke/repo", "ses_1"))).toBe(`local${NUL}/home/luke/repo${NUL}ses_1`)
    expect(ScopedKey.prefix("/home/luke/repo")).toBe(`local${NUL}/home/luke/repo${NUL}`)
    expect(String(ScopedKey.from("notification"))).toBe(`local${NUL}notification`)
  })

  test("rejects parts carrying the separator", () => {
    expect(() => ScopedKey.from("bad\0directory")).toThrow("Scoped key part cannot contain null bytes")
  })

  test("migrates unscoped session state keys under the local prefix", () => {
    expect(
      migrateLegacySessionStateKeys({
        "cmVwbw/session-1": { all: [] },
        [`local${NUL}cmVwbw/session-2`]: { all: ["review"] },
      }),
    ).toEqual({
      [`local${NUL}cmVwbw/session-1`]: { all: [] },
      [`local${NUL}cmVwbw/session-2`]: { all: ["review"] },
    })
  })

  test("leaves an already migrated map untouched", () => {
    const value = { [`local${NUL}cmVwbw/session-1`]: { all: [] } }
    expect(migrateLegacySessionStateKeys(value)).toBe(value)
  })
})
