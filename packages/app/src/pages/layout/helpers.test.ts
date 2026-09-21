import { describe, expect, test } from "vitest"
import { type Session } from "@yoma-desktop/kernel"
import {
  closeHomeProject,
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  homeProjectDirectories,
  latestRootSession,
  sortedRootSessions,
  toggleHomeProjectSelection,
} from "./helpers"
import { pathKey } from "@/utils/path-key"

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">): Session => ({
  title: "",
  time: { created: 0, updated: 0, archived: undefined },
  ...input,
})

describe("layout workspace helpers", () => {
  test("normalizes trailing slash in workspace key", () => {
    expect(String(pathKey("/tmp/demo///"))).toBe("/tmp/demo")
    expect(String(pathKey("C:\\tmp\\demo\\\\"))).toBe("C:/tmp/demo")
  })

  test("preserves posix and drive roots in workspace key", () => {
    expect(String(pathKey("/"))).toBe("/")
    expect(String(pathKey("///"))).toBe("/")
    expect(String(pathKey("C:\\"))).toBe("C:/")
    expect(String(pathKey("C://"))).toBe("C:/")
    expect(String(pathKey("C:///"))).toBe("C:/")
  })

  test("keeps local first while preserving known order", () => {
    const result = effectiveWorkspaceOrder("/root", ["/root", "/b", "/c"], ["/root", "/c", "/a", "/b"])
    expect(result).toEqual(["/root", "/c", "/b"])
  })

  test("finds the latest root session across workspaces", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/root" },
          session: [session({ id: "root", directory: "/root", time: { created: 1, updated: 1, archived: undefined } })],
        },
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "workspace",
              directory: "/workspace",
              time: { created: 2, updated: 2, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("workspace")
  })

  test("子 agent 的会话(带 parentID)不算根会话:侧栏、首页、最近会话都不列", () => {
    const store = {
      path: { directory: "/workspace" },
      session: [
        session({ id: "main", directory: "/workspace", time: { created: 1, updated: 1, archived: undefined } }),
        session({
          id: "child",
          directory: "/workspace",
          parentID: "main",
          time: { created: 9, updated: 9, archived: undefined },
        }),
      ],
    }
    expect(sortedRootSessions(store, 120_000).map((item) => item.id)).toEqual(["main"])
    expect(latestRootSession([store], 120_000)?.id).toBe("main")
  })

  test("ignores archived sessions when finding latest root session", () => {
    const result = latestRootSession(
      [
        {
          path: { directory: "/workspace" },
          session: [
            session({
              id: "archived",
              directory: "/workspace",
              time: { created: 40, updated: 40, archived: 40 },
            }),
            session({
              id: "root",
              directory: "/workspace",
              time: { created: 30, updated: 30, archived: undefined },
            }),
          ],
        },
      ],
      120_000,
    )

    expect(result?.id).toBe("root")
  })

  test("formats fallback project display name", () => {
    expect(displayName({ worktree: "/tmp/app" })).toBe("app")
    expect(displayName({ worktree: "/tmp/app", name: "My App" })).toBe("My App")
    expect(displayName({ worktree: "/" })).toBe("/")
  })

  test("toggles the selected home project", () => {
    expect(toggleHomeProjectSelection(undefined, "/home/luke/repos/amazon")).toEqual({
      directory: "/home/luke/repos/amazon",
    })
    expect(toggleHomeProjectSelection({ directory: "/home/luke/repos/other" }, "/home/luke/repos/amazon")).toEqual({
      directory: "/home/luke/repos/amazon",
    })
    expect(toggleHomeProjectSelection({ directory: "/home/luke/repos/amazon" }, "/home/luke/repos/amazon")).toEqual({})
  })

  test("closing the selected home project clears the selection", () => {
    const closed: string[] = []

    expect(closeHomeProject({ directory: "/other" }, { close: (d) => closed.push(d) }, "/shared")).toEqual({
      directory: "/other",
    })
    expect(closed).toEqual(["/shared"])
    expect(closeHomeProject({ directory: "/shared" }, { close: (d) => closed.push(d) }, "/shared")).toEqual({})
    expect(closed).toEqual(["/shared", "/shared"])
  })

  test("preserves picker order when adding multiple projects", () => {
    expect(homeProjectDirectories(["/first", "/second"])).toEqual(["/first", "/second"])
    expect(homeProjectDirectories("/only")).toEqual(["/only"])
    expect(homeProjectDirectories(null)).toEqual([])
  })

  test("extracts api error message and fallback", () => {
    expect(errorMessage({ data: { message: "boom" } }, "fallback")).toBe("boom")
    expect(errorMessage(new Error("broken"), "fallback")).toBe("broken")
    expect(errorMessage("unknown", "fallback")).toBe("fallback")
  })
})
