/**
 * 渲染器的名字空间缓存(app 的 namespace-storage.ts)在主进程这头要的两件事:整个名字空间一次读出来,
 * 一批改动一次写进去。纯函数,好测;真正碰文件的那一下在 ipc.ts 里。
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

/** 出一份新对象,不动传进来的那份:赋回去的那一下才是唯一的一次写盘。 */
export function applyUpdate(
  data: Record<string, unknown>,
  insert: Record<string, string>,
  remove: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...data, ...insert }
  for (const key of remove) delete next[key]
  return next
}
