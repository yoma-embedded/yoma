/**
 * 桌面端一个存储名字空间(`yoma.global.dat`、`yoma.workspace.….dat` 这种文件)在渲染器里的内存副本。
 *
 * 以前 `platform.storage(name)` 的每个 getItem / setItem 都是一次 IPC,而主进程那头每写一个键都是一次整份
 * 序列化 + 带 fsync 的原子写(desktop 的 json-store.ts;同步的,小文件也要 4–6 ms,实测 dev 档的 global 文件有
 * 241 KB)。拖面板、切页签、连着几次 setState,就是一串这样的写。现在:
 *   - 名字空间只从主进程读一次,之后的读是 Map 查找;
 *   - 写先落在内存里(读立刻看得见),攒一个窗口(`NAMESPACE_FLUSH_DELAY`)合成一次 IPC、主进程一次写盘;
 *   - `flush()` 把这一批**同步地**交给 driver —— 页面要走了(pagehide)时调它,消息在页面消失之前就已经发出去了。
 * 代价是明说的:硬崩溃时最多丢最后这一个窗口里的写。VS Code 的 Storage 是同一个取舍。
 *
 * 照 opencode dc46ecfc55 的 NamespaceStorage 写的,去掉了它一大半:那边是多窗口,每个值都带着主进程的修订号、
 * 要处理别的窗口的写和自己在途的写谁先谁后;yoma 只有一个窗口,主进程自己也不碰这些 `.dat` 名字空间。
 */

import type { AsyncStorage } from "@solid-primitives/storage"

/** 主进程那头:整个名字空间一次读出来,一批改动一次写进去。 */
export type NamespaceDriver = {
  items(name: string): Promise<Record<string, string>>
  update(name: string, insert: Record<string, string>, remove: string[]): Promise<void>
  clear(name: string): Promise<void>
}

export type NamespaceStorage = AsyncStorage & {
  /** 把攒着的改动现在就交出去。driver 答复之后才 resolve —— 答复可能是"没写成",所以落没落盘要再问 pending。 */
  flush(): Promise<void>
  /** 这个键还有没落盘的改动(在攒着,或者上一批没写成、等着重试)。 */
  pending(key: string): boolean
}

export const NAMESPACE_FLUSH_DELAY = 100
/** 一批没写成(磁盘满、没权限):过这么久再试,不是每 100 ms 撞一次。 */
const RETRY_DELAY = 2000

export function createNamespaceStorage(
  driver: NamespaceDriver,
  name: string,
  options: { delay?: number; retryDelay?: number } = {},
): NamespaceStorage {
  const delay = options.delay ?? NAMESPACE_FLUSH_DELAY
  const retryDelay = options.retryDelay ?? RETRY_DELAY
  const cache = new Map<string, string>()
  // 本地写过的键:加载回来的快照不许盖掉它们。
  const written = new Set<string>()
  const dirty = new Set<string>()
  const inflight = new Set<Promise<void>>()
  let loading: Promise<void> | undefined
  // clear() 之后,还在路上的那次加载带回来的是清空之前的内容,不许再放进缓存。
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let due = Infinity

  const load = () => {
    if (loading) return loading
    const started = generation
    const next: Promise<void> = driver.items(name).then(
      (items) => {
        if (started !== generation) return
        for (const [key, value] of Object.entries(items)) {
          if (!written.has(key)) cache.set(key, value)
        }
      },
      (error: unknown) => {
        // 主进程读不了这个文件(被占着、没权限):这一次按"没有"答,下一次读再去问,不把一次失败记一辈子。
        // 主进程读不了的时候也不会写(update 要先读),所以这里拿缺省值继续不会盖掉磁盘上的东西。
        if (loading === next) loading = undefined
        console.error(`[persist] ${name} 读不出来,先按空的用`, error)
      },
    )
    loading = next
    return next
  }

  // 取更早的那个期限:失败重试排的是 2 秒,这中间来了新的写,不该跟着等 2 秒。
  const schedule = (ms: number) => {
    const at = Date.now() + ms
    if (timer !== undefined && at >= due) return
    clearTimeout(timer)
    due = at
    timer = setTimeout(() => void flush(), ms)
  }

  const write = (key: string, value: string | null) => {
    if (value === null) cache.delete(key)
    else cache.set(key, value)
    written.add(key)
    dirty.add(key)
    schedule(delay)
  }

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    due = Infinity
    if (dirty.size > 0) {
      const batch = [...dirty]
      dirty.clear()
      const insert: Record<string, string> = {}
      const remove: string[] = []
      for (const key of batch) {
        const value = cache.get(key)
        if (value === undefined) remove.push(key)
        else insert[key] = value
      }
      // 这一批一切出来就交给 driver,不排在上一批的回执后面 —— pagehide 时的 flush 靠的就是这一点。
      const request = driver
        .update(name, insert, remove)
        .catch((error: unknown) => {
          // 重排的是键不是值:下次交出去时带的是那时内存里的最新值,所以这中间又被改过的键重排一次也无妨。
          for (const key of batch) dirty.add(key)
          schedule(retryDelay)
          console.error(`[persist] ${name} 这一批没写成,稍后再试`, error)
        })
        .finally(() => inflight.delete(request))
      inflight.add(request)
    }
    return Promise.all(inflight).then(() => undefined)
  }

  const storage: NamespaceStorage = {
    getItem: async (key) => {
      await load()
      return cache.get(key) ?? null
    },
    setItem: async (key, value) => write(key, value),
    removeItem: async (key) => write(key, null),
    clear: async () => {
      clearTimeout(timer)
      timer = undefined
      due = Infinity
      generation += 1
      cache.clear()
      written.clear()
      dirty.clear()
      // 清空之后内存里的(空)就是全部真相,不必再去读一遍。
      loading = Promise.resolve()
      await driver.clear(name)
    },
    key: async (index: number) => {
      await load()
      return [...cache.keys()][index]
    },
    getLength: async () => {
      await load()
      return cache.size
    },
    get length() {
      return storage.getLength()
    },
    flush,
    pending: (key) => dirty.has(key),
  }
  return storage
}
