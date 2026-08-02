import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { NormalizedProviderListResponse } from "@yoma-desktop/session-ui/context"
import { bootstrapDirectory, loadProjectsQuery, loadProvidersQuery, type Project } from "./bootstrap"
import type { Config, State, VcsCache } from "./types"
import type { Sdk } from "@/utils/server"
import { ServerScope } from "@/utils/server-scope"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const calls: string[] = []
    const [store, setStore] = createStore<State>({
      status: "loading",
      project: "",
      projectMeta: undefined,
      icon: undefined,
      provider_ready: true,
      provider,
      config: {},
      path: { directory: "/project" },
      session: [],
      sessionTotal: 0,
      session_status: {},
      session_working(id: string) {
        return (this.session_status[id]?.type ?? "idle") !== "idle"
      },
      permission: {},
      vcs: undefined,
      limit: 5,
      message: {},
      part: {},
      part_text_accum_delta: {},
    })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      global: {
        config: {} satisfies Config,
        path: { directory: "/project" },
        project: [{ directory: "/project", name: "project", lastOpened: 1 } satisfies Project],
        provider,
      },
      sdk: {
        vcs: {
          info: async () => {
            calls.push("vcs.info")
            return { root: "/project", branch: "main", dirty: false }
          },
        },
        model: {
          list: async () => {
            calls.push("model.list")
            return []
          },
        },
      } as unknown as Sdk,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {
        calls.push("loadSessions")
      },
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(store.path.directory).toBe("/project")
    expect(store.vcs).toEqual({ root: "/project", branch: "main", dirty: false })
    // 内核只剩这三件事要拉 —— agents / config / mcp / lsp / references / question 都没了。
    expect(calls.sort()).toEqual(["loadSessions", "model.list", "vcs.info"])
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as Sdk
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadProvidersQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "providers"])
    expect([...loadProvidersQuery(remote, "/repo", client).queryKey]).toEqual([
      "https://debian.example",
      "/repo",
      "providers",
    ])
    expect([...loadProvidersQuery(remote, null, client).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
    expect([...loadProjectsQuery(remote, client).queryKey]).toEqual(["https://debian.example", "project"])
  })
})
