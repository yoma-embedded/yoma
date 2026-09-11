import { describe, expect, test } from "vitest"
import { DRAFTS_TARGET, draftHref, migrateDrafts } from "./drafts"

/**
 * 草稿表是 localStorage 的老住户(yoma.global.dat 里的 `tabs`)。标签条拆掉之后它还住在
 * 同一个键上 —— 键字节一变,用户没发出去的草稿就全丢了,所以这里把字节和迁移都钉死。
 */
describe("drafts storage", () => {
  test("keeps the exact storage name and key", () => {
    expect(DRAFTS_TARGET).toEqual({ storage: "yoma.global.dat", key: "tabs", legacy: undefined })
  })

  test("keeps the draft route shape", () => {
    expect(draftHref("d1")).toBe("/new-session?draftId=d1")
    expect(draftHref("d 1")).toBe("/new-session?draftId=d%201")
  })
})

describe("drafts migration", () => {
  test("keeps draft records and drops the session tabs next to them", () => {
    expect(
      migrateDrafts([
        { type: "session", sessionId: "ses_1" },
        { type: "draft", draftID: "d1", directory: "/repo", server: { key: "local" } },
        { type: "draft", draftID: "d2", directory: "/repo", worktree: "/repo/wt" },
      ]),
    ).toEqual([
      { draftID: "d1", directory: "/repo" },
      { draftID: "d2", directory: "/repo", worktree: "/repo/wt" },
    ])
  })

  test("keeps already migrated records and skips broken ones", () => {
    expect(migrateDrafts([{ draftID: "d1", directory: "/repo" }])).toEqual([{ draftID: "d1", directory: "/repo" }])
    expect(migrateDrafts([{ draftID: "d1" }, { directory: "/repo" }, null, "nope"])).toEqual([])
    expect(migrateDrafts(undefined)).toBe(undefined)
    expect(migrateDrafts({})).toEqual({})
  })
})
