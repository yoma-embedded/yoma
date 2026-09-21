import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createNamespaceStorage, NAMESPACE_FLUSH_DELAY, type NamespaceDriver } from "./namespace-storage"

type Update = { name: string; insert: Record<string, string>; remove: string[] }

/** 主进程的替身:记下每一次调用;`hold()` 之后的 update 不回执,直到 `release()`,可以让某一次失败。 */
function fakeDriver(initial: Record<string, string> = {}) {
  const disk = new Map(Object.entries(initial))
  const calls = { items: 0, clear: 0, updates: [] as Update[] }
  let gate: Promise<void> | undefined
  let open: (() => void) | undefined
  let failNext = false
  let itemsGate: Promise<void> | undefined
  let openItems: (() => void) | undefined
  const driver: NamespaceDriver = {
    items: async () => {
      calls.items += 1
      const snapshot = Object.fromEntries(disk)
      await itemsGate
      return snapshot
    },
    update: async (name, insert, remove) => {
      calls.updates.push({ name, insert, remove })
      const fail = failNext
      failNext = false
      await gate
      if (fail) throw new Error("disk full")
      for (const [key, value] of Object.entries(insert)) disk.set(key, value)
      for (const key of remove) disk.delete(key)
    },
    clear: async () => {
      calls.clear += 1
      disk.clear()
    },
  }
  return {
    driver,
    disk,
    calls,
    hold: () => (gate = new Promise((resolve) => (open = resolve))),
    release: () => {
      open?.()
      gate = undefined
    },
    holdItems: () => (itemsGate = new Promise((resolve) => (openItems = resolve))),
    releaseItems: () => openItems?.(),
    failNextUpdate: () => (failNext = true),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("createNamespaceStorage", () => {
  test("名字空间只读一次,之后的读都是内存里的", async () => {
    const host = fakeDriver({ layout: "{}", tabs: "[]" })
    const storage = createNamespaceStorage(host.driver, "yoma.global.dat")
    expect(await storage.getItem("layout")).toBe("{}")
    expect(await storage.getItem("tabs")).toBe("[]")
    expect(await storage.getItem("missing")).toBeNull()
    expect(await storage.getLength()).toBe(2)
    expect(await storage.key(1)).toBe("tabs")
    expect(host.calls.items).toBe(1)
  })

  test("写了立刻读得到;一个窗口里的一串写合成一次 IPC,同一个键只带最后的值", async () => {
    const host = fakeDriver({ stale: "x" })
    const storage = createNamespaceStorage(host.driver, "yoma.global.dat")
    for (let width = 300; width <= 360; width += 1) await storage.setItem("layout", `{"width":${width}}`)
    await storage.setItem("tabs", "[1]")
    await storage.removeItem("stale")
    expect(await storage.getItem("layout")).toBe('{"width":360}')
    expect(await storage.getItem("stale")).toBeNull()
    expect(host.calls.updates).toEqual([])

    await vi.advanceTimersByTimeAsync(NAMESPACE_FLUSH_DELAY)
    expect(host.calls.updates).toEqual([
      { name: "yoma.global.dat", insert: { layout: '{"width":360}', tabs: "[1]" }, remove: ["stale"] },
    ])
    expect(Object.fromEntries(host.disk)).toEqual({ layout: '{"width":360}', tabs: "[1]" })
  })

  test("没有改动就不发 IPC", async () => {
    const host = fakeDriver()
    const storage = createNamespaceStorage(host.driver, "n")
    await storage.getItem("a")
    await vi.advanceTimersByTimeAsync(NAMESPACE_FLUSH_DELAY * 5)
    await storage.flush()
    expect(host.calls.updates).toEqual([])
  })

  test("加载还没回来时写的值赢过加载回来的旧值;删掉的键也不会被加载复活", async () => {
    const host = fakeDriver({ model: "old", gone: "old", other: "kept" })
    host.holdItems()
    const storage = createNamespaceStorage(host.driver, "n")
    const reading = storage.getItem("other")
    await storage.setItem("model", "new")
    await storage.removeItem("gone")
    host.releaseItems()
    expect(await reading).toBe("kept")
    expect(await storage.getItem("model")).toBe("new")
    expect(await storage.getItem("gone")).toBeNull()
  })

  test("flush 同步地把这一批交出去(pagehide 靠这个),主进程收下之后才 resolve", async () => {
    const host = fakeDriver()
    const storage = createNamespaceStorage(host.driver, "n")
    await storage.setItem("a", "1")
    host.hold()
    let done = false
    const flushed = storage.flush().then(() => (done = true))
    // 没有 await:调用返回的那一刻,这一批已经在 driver 手里了
    expect(host.calls.updates).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(false)
    host.release()
    await flushed
    expect(done).toBe(true)
    expect(host.disk.get("a")).toBe("1")
  })

  test("后一批不排在前一批的回执后面", async () => {
    const host = fakeDriver()
    const storage = createNamespaceStorage(host.driver, "n")
    await storage.setItem("a", "1")
    host.hold()
    void storage.flush()
    await storage.setItem("b", "2")
    void storage.flush()
    expect(host.calls.updates.map((update) => update.insert)).toEqual([{ a: "1" }, { b: "2" }])
    host.release()
  })

  test("一批没写成、之后也没有别的写:过 retryDelay 再试一次,不是每个窗口都撞一次", async () => {
    const host = fakeDriver()
    const storage = createNamespaceStorage(host.driver, "n", { retryDelay: 1000 })
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await storage.setItem("a", "1")
    host.failNextUpdate()
    await storage.flush()
    expect(host.disk.get("a")).toBeUndefined()
    await vi.advanceTimersByTimeAsync(NAMESPACE_FLUSH_DELAY * 5)
    expect(host.calls.updates).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(host.calls.updates.map((update) => update.insert)).toEqual([{ a: "1" }, { a: "1" }])
    expect(host.disk.get("a")).toBe("1")
    // 内存里的值一直是对的:失败不影响读
    expect(await storage.getItem("a")).toBe("1")
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })

  test("失败那一批里的键跟着下一批一起走,带的是那时最新的值,不是失败时的旧值", async () => {
    const host = fakeDriver()
    const storage = createNamespaceStorage(host.driver, "n", { retryDelay: 1000 })
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await storage.setItem("a", "1")
    await storage.setItem("b", "1")
    host.failNextUpdate()
    host.hold()
    void storage.flush()
    // 失败的回执回来之前 b 又被改了
    await storage.setItem("b", "2")
    host.release()
    await vi.advanceTimersByTimeAsync(NAMESPACE_FLUSH_DELAY)
    expect(host.calls.updates.map((update) => update.insert)).toEqual([
      { a: "1", b: "1" },
      { a: "1", b: "2" },
    ])
    expect(Object.fromEntries(host.disk)).toEqual({ a: "1", b: "2" })
    error.mockRestore()
  })

  test("失败重试排的是 2 秒,这中间来了新的写照样 100 ms 就走,不跟着等", async () => {
    const host = fakeDriver()
    const storage = createNamespaceStorage(host.driver, "n", { retryDelay: 2000 })
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await storage.setItem("a", "1")
    host.failNextUpdate()
    await storage.flush()
    await storage.setItem("b", "2")
    await vi.advanceTimersByTimeAsync(NAMESPACE_FLUSH_DELAY)
    expect(Object.fromEntries(host.disk)).toEqual({ a: "1", b: "2" })
    error.mockRestore()
  })

  test("pending:攒着的、没写成等重试的都算;落盘了才不算", async () => {
    const host = fakeDriver()
    const storage = createNamespaceStorage(host.driver, "n")
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await storage.setItem("a", "1")
    expect(storage.pending("a")).toBe(true)
    host.failNextUpdate()
    await storage.flush()
    expect(storage.pending("a")).toBe(true)
    await storage.flush()
    expect(storage.pending("a")).toBe(false)
    expect(storage.pending("never-written")).toBe(false)
    error.mockRestore()
  })

  test("读不出来(主进程那头文件被占着):这一次按没有答,下一次读再去问,不把一次失败记一辈子", async () => {
    const host = fakeDriver({ layout: "{}" })
    const items = host.driver.items
    let fail = true
    host.driver.items = async (name) => {
      if (fail) throw new Error("EBUSY")
      return items(name)
    }
    const storage = createNamespaceStorage(host.driver, "n")
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(await storage.getItem("layout")).toBeNull()
    fail = false
    expect(await storage.getItem("layout")).toBe("{}")
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })

  test("clear 的时候加载还在路上:带回来的是清空之前的内容,不许复活", async () => {
    const host = fakeDriver({ a: "1", b: "2" })
    host.holdItems()
    const storage = createNamespaceStorage(host.driver, "n")
    const reading = storage.getItem("a")
    await storage.clear()
    host.releaseItems()
    await reading
    expect(await storage.getItem("a")).toBeNull()
    expect(await storage.getLength()).toBe(0)
  })

  test("clear 丢掉缓存和攒着的改动,之后不再去读旧内容", async () => {
    const host = fakeDriver({ a: "1" })
    const storage = createNamespaceStorage(host.driver, "n")
    await storage.setItem("b", "2")
    await storage.clear()
    expect(host.calls.clear).toBe(1)
    expect(await storage.getItem("a")).toBeNull()
    expect(await storage.getItem("b")).toBeNull()
    await vi.advanceTimersByTimeAsync(NAMESPACE_FLUSH_DELAY)
    expect(host.calls.updates).toEqual([])
    expect(host.calls.items).toBe(0)
  })
})
