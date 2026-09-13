/**
 * killTree 的 Windows 分支:taskkill 的 spawn 失败是**异步**送到 'error' 事件的,try/catch 接不住;
 * 一个没人听的 'error' 是未捕获异常,整个内核进程跟着死。每次工具结束都会走到这里(cleanup 无条件
 * 杀树),所以这条监听是承重的。macOS 上跑不了 taskkill,把 child_process 换成假的:spawn 返回一个
 * 下一拍就 emit 'error' 的 EventEmitter,断言 (a) 有人在听 'error',(b) 进程没有冒出 uncaughtException。
 */

import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"

const spawned: Array<EventEmitter & { unref: () => void }> = []
const commands: string[] = []

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      const [command] = args
      if (!/taskkill(\.exe)?$/i.test(String(command))) return (actual.spawn as (...a: unknown[]) => unknown)(...args)
      const fake = Object.assign(new EventEmitter(), { unref: () => {} })
      spawned.push(fake)
      commands.push(String(command))
      process.nextTick(() => fake.emit("error", Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" })))
      return fake
    },
  }
})

const { killTree } = await import("../src/host/domain/engines.ts")

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor)
  spawned.length = 0
  commands.length = 0
})

describe("killTree on win32", () => {
  it("taskkill 起不来时不炸内核:'error' 有人听、退一步杀直接子进程,进程上没有 uncaughtException", async () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" })
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => uncaught.push(error)
    process.on("uncaughtException", onUncaught)
    const kill = vi.fn()
    try {
      killTree({ pid: 4242, kill } as never, "SIGKILL")
      expect(spawned).toHaveLength(1)
      expect(spawned[0]!.listenerCount("error")).toBeGreaterThan(0)
      // 让 nextTick 里的 'error' 真的发出来。
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(uncaught).toEqual([])
      // 吞掉错误不算修好:taskkill 没起来就至少把本体杀掉,否则探针被孤儿攥着。
      expect(kill).toHaveBeenCalledWith("SIGKILL")
    } finally {
      process.off("uncaughtException", onUncaught)
    }
  })

  it("taskkill 走 System32 的绝对路径,不靠 PATH", () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" })
    killTree({ pid: 1, kill: () => {} } as never, "SIGKILL")
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatch(/System32[\\/]taskkill\.exe$/)
  })
})
