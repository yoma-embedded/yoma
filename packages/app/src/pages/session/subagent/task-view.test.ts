import { describe, expect, test } from "vitest"
import type { TaskView } from "@yoma-desktop/kernel"
import { dockTasks, sessionTasks, taskActive, taskElapsed, taskLook } from "./task-view"

const task = (id: string, input: Partial<TaskView> = {}): TaskView => ({
  id,
  parentID: "main",
  agent: "Explore",
  description: id,
  status: "running",
  background: false,
  startedAt: 1_000,
  turns: 1,
  usage: { totalTokens: 0, toolUses: 0, durationMs: 0 },
  outputFile: `/tmp/${id}.log`,
  ...input,
})

describe("子 agent 任务的读法", () => {
  test("后台在跑单成一档;终态与排队照内核的 status", () => {
    expect(taskLook(task("a", { background: true }))).toBe("background")
    expect(taskLook(task("a"))).toBe("running")
    expect(taskLook(task("a", { background: true, status: "completed" }))).toBe("completed")
    expect(taskLook(task("a", { status: "pending" }))).toBe("pending")
    expect([taskActive(task("a", { status: "pending" })), taskActive(task("a", { status: "killed" }))]).toEqual([
      true,
      false,
    ])
  })

  test("只列这个会话派出去的;在跑的在前,其余新的在前", () => {
    const list = sessionTasks(
      {
        old: task("old", { status: "completed", startedAt: 1 }),
        other: task("other", { parentID: "another" }),
        newer: task("newer", { status: "failed", startedAt: 9 }),
        live: task("live", { startedAt: 2 }),
        queued: task("queued", { status: "pending", startedAt: 3 }),
      },
      "main",
    )
    expect(list.map((item) => item.id)).toEqual(["queued", "live", "newer", "old"])
    expect(sessionTasks(undefined, "main")).toEqual([])
  })

  test("耗时:在跑的按走着的钟,结束的按结束时刻;整秒,过一分钟换成分秒", () => {
    expect(taskElapsed(task("a"), 13_900)).toBe("12 s")
    expect(taskElapsed(task("a", { status: "completed", endedAt: 126_000 }), 999_999)).toBe("2 min 05 s")
    // 内核重启前的终态视图没有 endedAt 时,退回 usage.durationMs(那是结束那一刻算的)。
    expect(
      taskElapsed(task("a", { status: "killed", usage: { totalTokens: 0, toolUses: 0, durationMs: 4_200 } }), 99_000),
    ).toBe("4 s")
  })

  test("坞只画没完事的:排队中 / 在跑 / 跑完但通知还排着;汇报完的与别的会话的不画", () => {
    const tasks = {
      live: task("live"),
      queued: task("queued", { status: "pending", startedAt: 2_000 }),
      reported: task("reported", { status: "completed" }),
      waiting: task("waiting", { status: "completed", startedAt: 5 }),
      other: task("other", { parentID: "another" }),
    }
    const rows = dockTasks(tasks, "main", [
      { kind: "notification", entryId: "n1", taskID: "waiting" },
      { kind: "prompt", entryId: "p1", text: "排队的消息", images: 0 },
      // taskID 认不出来的通知不该把谁点亮。
      { kind: "notification", entryId: "n2" },
    ])
    expect(rows.map((row) => [row.task.id, row.reporting])).toEqual([
      ["queued", false],
      ["live", false],
      ["waiting", true],
    ])
    // 在跑与排队中的按开始时间新的在前,汇报中的排在它们后面。
    expect(dockTasks(tasks, "main", undefined).map((row) => row.task.id)).toEqual(["queued", "live"])
  })
})
