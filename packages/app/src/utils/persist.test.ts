import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"

type PersistTestingType = typeof import("./persist").PersistTesting
type PersistType = typeof import("./persist").Persist
type RemovePersistedType = typeof import("./persist").removePersisted

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  readonly events: string[] = []
  readonly calls = { get: 0, set: 0, remove: 0 }

  clear() {
    this.values.clear()
  }

  get length() {
    return this.values.size
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }

  getItem(key: string) {
    this.calls.get += 1
    this.events.push(`get:${key}`)
    if (key.startsWith("yoma.throw")) throw new Error("storage get failed")
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.calls.set += 1
    this.events.push(`set:${key}`)
    if (key.startsWith("yoma.quota")) throw new DOMException("quota", "QuotaExceededError")
    if (key.startsWith("yoma.throw")) throw new Error("storage set failed")
    this.values.set(key, value)
  }

  removeItem(key: string) {
    this.calls.remove += 1
    this.events.push(`remove:${key}`)
    if (key.startsWith("yoma.throw")) throw new Error("storage remove failed")
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()

let persistTesting: PersistTestingType
let Persist: PersistType
let removePersisted: RemovePersistedType

beforeAll(async () => {
  vi.doMock("@/context/platform", () => ({
    usePlatform: () => ({ platform: "web" }),
  }))

  const mod = await import("./persist")
  persistTesting = mod.PersistTesting
  Persist = mod.Persist
  removePersisted = mod.removePersisted
})

beforeEach(() => {
  storage.clear()
  storage.events.length = 0
  storage.calls.get = 0
  storage.calls.set = 0
  storage.calls.remove = 0
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  })
})

describe("persist localStorage resilience", () => {
  test("does not cache values as persisted when quota write and eviction fail", () => {
    const storageApi = persistTesting.localStorageWithPrefix("yoma.quota.scope")
    storageApi.setItem("value", '{"value":1}')

    expect(storage.getItem("yoma.quota.scope:value")).toBeNull()
    expect(storageApi.getItem("value")).toBeNull()
  })

  test("disables only the failing scope when storage throws", () => {
    const bad = persistTesting.localStorageWithPrefix("yoma.throw.scope")
    bad.setItem("value", '{"value":1}')

    const before = storage.calls.set
    bad.setItem("value", '{"value":2}')
    expect(storage.calls.set).toBe(before)
    expect(bad.getItem("value")).toBeNull()

    const healthy = persistTesting.localStorageWithPrefix("yoma.safe.scope")
    healthy.setItem("value", '{"value":3}')
    expect(storage.getItem("yoma.safe.scope:value")).toBe('{"value":3}')
  })

  test("failing fallback scope does not poison direct storage scope", () => {
    const broken = persistTesting.localStorageWithPrefix("yoma.throw.scope2")
    broken.setItem("value", '{"value":1}')

    const direct = persistTesting.localStorageDirect()
    direct.setItem("direct-value", '{"value":5}')

    expect(storage.getItem("direct-value")).toBe('{"value":5}')
  })

  test("normalizer rejects malformed JSON payloads", () => {
    const result = persistTesting.normalize({ value: "ok" }, '{"value":"\\x"}')
    expect(result).toBeUndefined()
  })

  test("workspace storage sanitizes Windows filename characters", () => {
    const result = persistTesting.workspaceStorage("C:\\Users\\foo")

    expect(result.startsWith("yoma.workspace.")).toBe(true)
    expect(result.endsWith(".dat")).toBe(true)
    expect(/[:\\/]/.test(result)).toBe(false)
  })

  test("workspace target keeps raw path storage as legacy fallback", () => {
    const target = Persist.workspace("C:\\Users\\foo", "vcs")

    expect(target.storage).toBe(persistTesting.workspaceStorage("C:/Users/foo"))
    expect(target.legacyStorageNames).toEqual([persistTesting.workspaceStorage("C:\\Users\\foo")])
  })

  test("workspace target keeps backslash storage as fallback for normalized Windows paths", () => {
    const target = Persist.workspace("C:/Users/foo", "vcs")

    expect(target.storage).toBe(persistTesting.workspaceStorage("C:/Users/foo"))
    expect(target.legacyStorageNames).toEqual([persistTesting.workspaceStorage("C:\\Users\\foo")])
  })

  test("migrates direct legacy keys into scoped storage", () => {
    storage.setItem("legacy.workspace", '{"value":2}')
    const target = Persist.workspace("C:/Users/foo", "demo", ["legacy.workspace"])
    const current = persistTesting.localStorageWithPrefix(target.storage!)
    const legacyStore = persistTesting.localStorageDirect()

    const result = persistTesting.migrateLegacy({
      current,
      legacyStore,
      stores: [],
      keys: target.legacy!,
      key: target.key,
      defaults: { value: 1 },
    })

    expect(result).toBe('{"value":2}')
    expect(storage.getItem(`${target.storage}:${target.key}`)).toBe('{"value":2}')
    expect(legacyStore.getItem("legacy.workspace")).toBeNull()
    expect(storage.getItem("legacy.workspace")).toBeNull()
  })

  test("removes legacy workspace storage when removing persisted target", () => {
    const target = Persist.workspace("C:\\Users\\foo", "terminal")
    storage.setItem(`${target.storage}:${target.key}`, '{"value":1}')
    storage.setItem(`${target.legacyStorageNames![0]}:${target.key}`, '{"value":2}')

    removePersisted(target)

    expect(storage.getItem(`${target.storage}:${target.key}`)).toBeNull()
    expect(storage.getItem(`${target.legacyStorageNames![0]}:${target.key}`)).toBeNull()
  })

  test("draft target isolates storage per draft and namespaces keys", () => {
    const a = Persist.draft("draft-a", "prompt")
    const b = Persist.draft("draft-b", "prompt")

    expect(a.key).toBe("draft:prompt")
    expect(a.storage).not.toBe(b.storage)
    expect(a.storage).not.toBe(Persist.workspace("/home/luke/repo", "prompt").storage)
  })

  test("removes draft storage when removing persisted target", () => {
    const target = Persist.draft("draft-a", "prompt")
    storage.setItem(`${target.storage}:${target.key}`, '{"value":1}')

    removePersisted(target)

    expect(storage.getItem(`${target.storage}:${target.key}`)).toBeNull()
  })

  /**
   * 这一组钉的是**用户硬盘上已有的键**。多服务器时代的 `Persist.server*` 变体没了,
   * 留下的 global / workspace / session / draft 必须和当年 scope === "local" 时
   * 算出来的字节完全一样,否则升级之后草稿、评论、文件视图、通知已读全部失踪。
   */
  test("global target keeps its storage name, key and legacy key", () => {
    expect(Persist.global("layout", ["layout.v6"])).toEqual({
      storage: "yoma.global.dat",
      key: "layout",
      legacy: ["layout.v6"],
    })
    expect(Persist.global("notification", ["notification.v1"])).toEqual({
      storage: "yoma.global.dat",
      key: "notification",
      legacy: ["notification.v1"],
    })
    expect(Persist.global("tabs")).toEqual({ storage: "yoma.global.dat", key: "tabs", legacy: undefined })
    expect(Persist.global("server", ["server.v3"])).toEqual({
      storage: "yoma.global.dat",
      key: "server",
      legacy: ["server.v3"],
    })
  })

  test("workspace and session targets keep their exact storage name and key", () => {
    expect(Persist.workspace("/home/luke/repo", "prompt")).toEqual({
      storage: "yoma.workspace.-home-luke-r.1dbjore.dat",
      legacyStorageNames: undefined,
      key: "workspace:prompt",
      legacy: undefined,
    })
    expect(Persist.session("/home/luke/repo", "ses_1", "prompt", ["/home/luke/repo/prompt/ses_1.v2"])).toEqual({
      storage: "yoma.workspace.-home-luke-r.1dbjore.dat",
      legacyStorageNames: undefined,
      key: "session:ses_1:prompt",
      legacy: ["/home/luke/repo/prompt/ses_1.v2"],
    })
    expect(Persist.scoped("/home/luke/repo", undefined, "file-view")).toEqual(
      Persist.workspace("/home/luke/repo", "file-view"),
    )
    expect(Persist.scoped("/home/luke/repo", "ses_1", "comments")).toEqual(
      Persist.session("/home/luke/repo", "ses_1", "comments"),
    )
  })
})

// 桌面端的 setItem 先落在内存里、攒一批才写盘(namespace-storage.ts)。搬家跨两个名字空间:新家没落盘之前
// 不许删旧家的,不然那一批要是没写成,这个值就哪儿都没有了(审查抓到的顺序问题)。
describe("桌面端搬旧键:新的落盘了才删旧的", () => {
  function memory(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial))
    const log: string[] = []
    const api = {
      getItem: async (key: string) => data.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        log.push(`set ${key}`)
        data.set(key, value)
      },
      removeItem: async (key: string) => {
        log.push(`remove ${key}`)
        data.delete(key)
      },
    }
    return { api, data, log }
  }

  test("新家是攒批的名字空间:先 flush,落盘了再删旧的", async () => {
    const order: string[] = []
    const current = memory()
    const legacy = memory({ "language.v1": '{"locale":"zh"}' })
    const storage = {
      ...current.api,
      flush: async () => void order.push("flush"),
      pending: () => false,
    }
    const removeItem = legacy.api.removeItem
    legacy.api.removeItem = async (key) => {
      order.push("remove legacy")
      return removeItem(key)
    }
    const value = await persistTesting.migrateLegacyAsync({
      current: storage as never,
      legacyStore: legacy.api as never,
      stores: [],
      keys: ["language.v1"],
      key: "language",
      defaults: { locale: "en" },
    })
    expect(value).toBe('{"locale":"zh"}')
    expect(order).toEqual(["flush", "remove legacy"])
    expect(legacy.data.size).toBe(0)
  })

  test("新家那一批没写成(还 pending):旧的留着,下次启动再搬", async () => {
    const current = memory()
    const legacy = memory({ "language.v1": '{"locale":"zh"}' })
    const storage = { ...current.api, flush: async () => undefined, pending: () => true }
    const value = await persistTesting.migrateLegacyAsync({
      current: storage as never,
      legacyStore: legacy.api as never,
      stores: [],
      keys: ["language.v1"],
      key: "language",
      defaults: { locale: "en" },
    })
    // 这一次会话照样用得上搬过来的值
    expect(value).toBe('{"locale":"zh"}')
    expect(legacy.data.get("language.v1")).toBe('{"locale":"zh"}')
  })

  test("不是攒批的存储(没有 flush / pending):照旧,写完就删", async () => {
    const current = memory()
    const legacy = memory({ old: '{"a":1}' })
    await persistTesting.migrateLegacyAsync({
      current: current.api as never,
      legacyStore: legacy.api as never,
      stores: [],
      keys: ["old"],
      key: "new",
      defaults: { a: 0 },
    })
    expect(current.data.get("new")).toBe('{"a":1}')
    expect(legacy.data.size).toBe(0)
  })
})
