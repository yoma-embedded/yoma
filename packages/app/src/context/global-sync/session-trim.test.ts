import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@yoma-desktop/kernel"
import { trimSessions } from "./session-trim"

const session = (input: { id: string; created: number; updated?: number; archived?: number }) =>
  ({
    id: input.id,
    directory: "/tmp",
    title: input.id,
    time: {
      created: input.created,
      updated: input.updated ?? input.created,
      archived: input.archived,
    },
  }) satisfies Session

describe("trimSessions", () => {
  test("keeps the base window and recent sessions beyond the limit", () => {
    const now = 1_000_000
    const list = [
      session({ id: "a", created: now - 100_000 }),
      session({ id: "b", created: now - 90_000 }),
      session({ id: "c", created: now - 80_000 }),
      session({ id: "d", created: now - 70_000, updated: now - 1_000 }),
      session({ id: "e", created: now - 60_000, archived: now - 10 }),
    ]

    const result = trimSessions(list, { limit: 2, permission: {}, now })
    expect(result.map((x) => x.id)).toEqual(["a", "b", "c", "d"])
  })

  // 内核里会话之间没有父子关系,所以这里只剩三条留存理由:在 limit 内、在最近窗口内、
  // 或者还挂着未决权限请求(弹窗还开着的会话被裁掉会直接丢掉待回答的请求)。
  test("keeps stale sessions that still have a pending permission request", () => {
    const now = 1_000_000
    const list = [
      session({ id: "recent-1", created: now - 1_000 }),
      session({ id: "recent-2", created: now - 2_000 }),
      session({ id: "mid", created: now - 100_000 }),
      session({ id: "old-kept-by-permission", created: now - 20_000_000 }),
      session({ id: "old-trimmed", created: now - 20_000_000 }),
      session({ id: "older-trimmed", created: now - 30_000_000 }),
    ]

    const result = trimSessions(list, {
      limit: 2,
      permission: {
        "old-kept-by-permission": [{ id: "perm-1" } as PermissionRequest],
      },
      now,
    })

    expect(result.map((x) => x.id)).toEqual(["mid", "old-kept-by-permission", "recent-1", "recent-2"])
  })
})
