import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"

import { acquireRoleLock, backoffSeconds } from "./daemon.ts"
import { Temp } from "./testkit.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

describe("daemon 护具", () => {
  test("同角色第二个实例被拒;释放后能再抢到", async () => {
    const clone = temp.dir("lock-")
    const first = await acquireRoleLock(clone, "runner")
    expect(first.ok).toBe(true)
    const second = await acquireRoleLock(clone, "runner")
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.detail).toContain("已有实例")

    if (first.ok) await first.release()
    const third = await acquireRoleLock(clone, "runner")
    expect(third.ok).toBe(true)
    if (third.ok) await third.release()
  })

  test("不同角色互不干扰", async () => {
    const clone = temp.dir("lock-")
    const runner = await acquireRoleLock(clone, "runner")
    const mother = await acquireRoleLock(clone, "mother")
    expect(runner.ok).toBe(true)
    expect(mother.ok).toBe(true)
  })

  test("持有者已死的尸体锁被接管 —— 崩溃不需要人工清锁", async () => {
    const clone = temp.dir("lock-")
    const stale = await acquireRoleLock(clone, "runner")
    expect(stale.ok).toBe(true)
    // 模拟持有者崩溃:锁文件在,pid 已经不存在(用一个几乎不可能活着的 pid)。
    writeFileSync(path.join(clone, ".yoma-lock", "runner.pid"), "999999999\n")
    const takeover = await acquireRoleLock(clone, "runner")
    expect(takeover.ok).toBe(true)
  })

  test("锁目录自带 .gitignore(pullReset 的 clean 不会把锁清掉)", async () => {
    const clone = temp.dir("lock-")
    await acquireRoleLock(clone, "runner")
    expect(await Bun.file(path.join(clone, ".yoma-lock", ".gitignore")).text()).toContain("*")
  })

  test("blocked 退避指数上升并封顶;恢复即回到轮询间隔", () => {
    expect(backoffSeconds(15, 0)).toBe(15)
    expect(backoffSeconds(15, 1)).toBe(30)
    expect(backoffSeconds(15, 3)).toBe(120)
    expect(backoffSeconds(15, 10)).toBe(600)
  })
})
