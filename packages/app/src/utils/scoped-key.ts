/**
 * 持久化键的组装器。顶替 `utils/server-scope.ts`。
 *
 * 多服务器概念没了,`ServerScope` 这个类型也就没了 —— 一个进程里只有一个内核。
 * 但**前缀字面量必须原样保留**:`"local"` 已经写进用户 localStorage 的键里了
 * (`local<NUL><dir><NUL><sessionID>` 这种形状)。把它删掉或改名 = 所有本地状态
 * (输入框草稿、评论、文件视图、终端、通知已读)在升级后集体失踪。
 *
 * 所以这里的做法是:把原来到处传递的 `scope` 参数塌成一个模块级常量,
 * 键的字节序列一个都不变,只是调用点不用再拿着 scope 走来走去。
 */

export type SessionRouteKey = string & { readonly __brand: "SessionRouteKey" }
export type SessionStateKey = string & { readonly __brand: "SessionStateKey" }
export type ScopedKey = string & { readonly __brand: "ScopedKey" }

/** U+0000。用 fromCharCode 构造,免得源码里出现裸控制字符。 */
const separator = String.fromCharCode(0)

/**
 * 历史遗留的作用域前缀。以前是 `ServerScope`(远程服务器用它的 URL 当前缀),
 * 现在只有内核一个"服务器",恒为 `"local"`。**不要改这个值。**
 */
export const LOCAL_SCOPE = "local"

function fragment(label: string, value: string) {
  if (value.includes(separator)) throw new Error(`${label} cannot contain null bytes`)
  return value
}

function compose(parts: string[]) {
  return [LOCAL_SCOPE, ...parts.map((part) => fragment("Scoped key part", part))].join(separator)
}

export const SessionRouteKey = {
  fromRoute(dir: string | undefined, sessionID?: string) {
    return fragment("Session route", `${dir ?? ""}${sessionID ? "/" + sessionID : ""}`) as SessionRouteKey
  },
  fromLegacy(key: string) {
    return fragment("Legacy session route", key) as SessionRouteKey
  },
}

export const SessionStateKey = {
  from(route: SessionRouteKey) {
    return compose([route]) as SessionStateKey
  },
  route(key: string) {
    const split = key.lastIndexOf(separator)
    return SessionRouteKey.fromLegacy(split === -1 ? key : key.slice(split + 1))
  },
  /**
   * 这条记录属不属于本机内核。多服务器时代 localStorage 里可能留下了
   * `https://debian.example<NUL>…` 这类远程条目;它们现在没有归属了,读的时候跳过。
   */
  isLocal(key: string) {
    const split = key.indexOf(separator)
    if (split === -1) return true
    return key.slice(0, split) === LOCAL_SCOPE
  },
}

export const ScopedKey = {
  from(...parts: string[]) {
    return compose(parts) as ScopedKey
  },
  prefix(...parts: string[]) {
    return `${ScopedKey.from(...parts)}${separator}`
  },
}

export function migrateLegacySessionStateKeys(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const entries = Object.entries(value)
  if (entries.every(([key]) => key.includes(separator))) return value
  const scoped = Object.fromEntries(entries.filter(([key]) => key.includes(separator)))
  for (const [key, item] of entries) {
    if (key.includes(separator)) continue
    const next = SessionStateKey.from(SessionRouteKey.fromLegacy(key))
    if (!(next in scoped)) scoped[next] = item
  }
  return scoped
}
