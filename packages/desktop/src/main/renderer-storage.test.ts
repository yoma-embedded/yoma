import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { flushRendererStorage, type FlushIpc, type FlushWindow } from "./renderer-storage"

function fakeIpc() {
  const listeners = new Set<(event: { sender: unknown }) => void>()
  const ipc: FlushIpc = {
    on: (_channel, listener) => listeners.add(listener),
    off: (_channel, listener) => listeners.delete(listener),
  }
  return { ipc, listeners, ack: (sender: unknown) => [...listeners].forEach((listener) => listener({ sender })) }
}
const fakeWindow = (id: string, alive = true) => {
  const sent: string[] = []
  const win: FlushWindow = {
    alive: () => alive,
    send: (channel) => sent.push(channel),
    owns: (sender) => sender === id,
  }
  return { win, sent }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("flushRendererStorage", () => {
  test("问每个活着的窗口,等到回执就走,监听器不留", async () => {
    const host = fakeIpc()
    const a = fakeWindow("a")
    let done = false
    const flushed = flushRendererStorage([a.win], host.ipc).then(() => (done = true))
    expect(a.sent).toEqual(["storage-flush"])
    await vi.advanceTimersByTimeAsync(10)
    expect(done).toBe(false)
    host.ack("a")
    await flushed
    expect(host.listeners.size).toBe(0)
  })

  test("别的窗口的回执不算数", async () => {
    const host = fakeIpc()
    const a = fakeWindow("a")
    let done = false
    void flushRendererStorage([a.win], host.ipc, 500).then(() => (done = true))
    host.ack("someone-else")
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(false)
  })

  test("页面不回话(卡死):等到超时为止,不挡重启", async () => {
    const host = fakeIpc()
    let done = false
    void flushRendererStorage([fakeWindow("a").win], host.ipc, 500).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(host.listeners.size).toBe(0)
  })

  test("页面已经挂了的窗口不问;一个窗口都没有时立刻走", async () => {
    const host = fakeIpc()
    const dead = fakeWindow("dead", false)
    await flushRendererStorage([dead.win], host.ipc)
    expect(dead.sent).toEqual([])
    await flushRendererStorage([], host.ipc)
  })
})
