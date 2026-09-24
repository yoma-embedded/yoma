/**
 * 渲染器的名字空间缓存(app 的 namespace-storage.ts)读整个名字空间时,值的口径。一批改动一次写进去的那一半在
 * json-store.ts 的 `update`。
 */

/** 和 store-get 同一个口径:字符串原样,别的序列化,null / undefined 当作没有。 */
export function stringItems(data: Record<string, unknown>): Record<string, string> {
  const items: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    items[key] = typeof value === "string" ? value : JSON.stringify(value)
  }
  return items
}
