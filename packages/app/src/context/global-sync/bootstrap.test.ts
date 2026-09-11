import { describe, expect, test } from "vitest"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { NormalizedProviderListResponse } from "@yoma-desktop/session-ui/context"
import { bootstrapDirectory, loadProjectsQuery, loadProvidersQuery, type Project } from "./bootstrap"
import type { Config, State, VcsCache } from "./types"
import type { Sdk } from "@/utils/kernel"
import { LOCAL_SCOPE } from "@/utils/scoped-key"

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
      vcs: undefined,
      limit: 5,
      message: {},
      part: {},
      part_text_accum_delta: {},
    })

    await bootstrapDirectory({
      directory: "/project",
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
  test("keeps the \"local\" first segment the multi-server scope used to supply", () => {
    const client = {} as Sdk

    expect([...loadProvidersQuery("/repo", client).queryKey]).toEqual([LOCAL_SCOPE, "/repo", "providers"])
    expect([...loadProvidersQuery(null, client).queryKey]).toEqual([LOCAL_SCOPE, null, "providers"])
    expect([...loadProjectsQuery(client).queryKey]).toEqual([LOCAL_SCOPE, "project"])
  })
})
