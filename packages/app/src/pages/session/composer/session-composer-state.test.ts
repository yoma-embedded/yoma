import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@yoma-desktop/kernel"
import { sessionPermissionRequest } from "./session-request-tree"

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

describe("sessionPermissionRequest", () => {
  test("returns the current session permission", () => {
    const permissions = {
      root: [permission("perm-root", "root")],
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(permissions, "root")?.id).toBe("perm-root")
  })

  test("returns undefined without a permission on this session", () => {
    const permissions = {
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(permissions, "root")).toBeUndefined()
  })

  test("returns undefined without a session", () => {
    const permissions = {
      root: [permission("perm-root", "root")],
    }

    expect(sessionPermissionRequest(permissions, undefined)).toBeUndefined()
  })

  test("skips filtered permissions", () => {
    const permissions = {
      root: [permission("perm-a", "root"), permission("perm-b", "root")],
    }

    expect(sessionPermissionRequest(permissions, "root", (item) => item.id !== "perm-a")?.id).toBe("perm-b")
  })

  test("returns undefined when every permission is filtered out", () => {
    const permissions = {
      root: [permission("perm-a", "root"), permission("perm-b", "root")],
    }

    expect(sessionPermissionRequest(permissions, "root", () => false)).toBeUndefined()
  })
})
