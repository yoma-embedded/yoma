import { describe, expect, test } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createProjects } from "./projects"

describe("createProjects", () => {
  test("writes into the literal \"local\" bucket the old multi-server store used", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({ projects: {}, lastProject: {} })
      const projects = createProjects({ store, setStore })

      projects.open("/repo")
      expect(projects.list()).toEqual([{ worktree: "/repo", expanded: true }])
      expect(store.projects).toEqual({ local: [{ worktree: "/repo", expanded: true }] })

      projects.touch("/repo")
      expect(store.lastProject).toEqual({ local: "/repo" })
      expect(projects.last()).toBe("/repo")
      dispose()
    })
  })

  test("adopts a bucket persisted by an earlier session", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        projects: { local: [{ worktree: "/repo", expanded: false }] },
        lastProject: { local: "/repo" },
      })
      const projects = createProjects({ store, setStore })

      expect(projects.list()).toEqual([{ worktree: "/repo", expanded: false }])
      projects.expand("/repo")
      expect(projects.list()).toEqual([{ worktree: "/repo", expanded: true }])
      projects.collapse("/repo")
      expect(projects.list()).toEqual([{ worktree: "/repo", expanded: false }])
      dispose()
    })
  })

  test("newest project goes first, move reorders, close removes", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({ projects: {}, lastProject: {} })
      const projects = createProjects({ store, setStore })

      projects.open("/a")
      projects.open("/b")
      projects.open("/a")
      expect(projects.list().map((project) => project.worktree)).toEqual(["/b", "/a"])

      projects.move("/b", 1)
      expect(projects.list().map((project) => project.worktree)).toEqual(["/a", "/b"])

      projects.close("/a")
      expect(projects.list().map((project) => project.worktree)).toEqual(["/b"])
      dispose()
    })
  })
})
