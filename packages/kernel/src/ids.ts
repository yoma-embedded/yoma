/**
 * 可排序 id。
 *
 * 这是整个迁移里最容易静默出错的地方。前端每一个集合都用 Binary.search 按 id 字符串
 * 比较维护有序数组,所以 id 的字典序 **就是** transcript 的显示顺序。
 *
 * my-pi 自己的 entry id 不能用:jsonl-storage.ts 的 generateEntryId() 是
 * `uuidv7().slice(-8)` —— 取的是 uuidv7 的 **随机尾部**(它的注释写着"短 ID 必须取
 * 随机尾部",因为前缀是时间戳、两次调用间几乎不变)。把它透传进前端,消息顺序会
 * 乱,而且不报错。
 *
 * 所以 host 自己铸 id,格式与 opencode 的 Identifier 逐字节一致(前 12 位十六进制是
 * 时间戳+计数器,后 14 位 base62 随机),这样 packages/app 里现存的 id 处理代码一行
 * 不用改。host↔renderer 两侧都可能铸 id(composer 乐观插入用户消息),所以这份实现
 * 放在共享的 kernel 包里。
 */

const PREFIXES = {
  session: "ses",
  message: "msg",
  part: "prt",
  permission: "per",
} as const

export type IdPrefix = keyof typeof PREFIXES

const LENGTH = 26
/** 时间戳左移 12 位给同毫秒计数器,与 opencode 一致。 */
const COUNTER_BITS = 12n
const HEX_CHARS = 12

let lastTimestamp = 0
let counter = 0

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < length; i += 1) out += BASE62[bytes[i]! % BASE62.length]
  return out
}

function toHex(value: bigint): string {
  // 只取低 48 位 —— 与 opencode 的 6 字节写法一致。毫秒的高位变化以年计,
  // 截断不影响同一纪元内的单调性。
  let out = ""
  for (let i = 0; i < 6; i += 1) {
    const byte = Number((value >> BigInt(40 - 8 * i)) & 0xffn)
    out += byte.toString(16).padStart(2, "0")
  }
  return out
}

function nextCounted(timestamp: number): bigint {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter += 1
  return (BigInt(timestamp) << COUNTER_BITS) + BigInt(counter)
}

function build(prefix: IdPrefix, counted: bigint): string {
  return `${PREFIXES[prefix]}_${toHex(counted)}${randomBase62(LENGTH - HEX_CHARS)}`
}

/** id 的可比较前缀(时间戳+计数器)。用来做严格递增,而不是拿整个字符串比。 */
export function sortKeyOf(id: string): bigint {
  const start = id.indexOf("_") + 1
  return BigInt(`0x${id.slice(start, start + HEX_CHARS)}`)
}

export const Identifier = {
  ascending(prefix: IdPrefix, given?: string): string {
    if (given) {
      if (!given.startsWith(PREFIXES[prefix])) throw new Error(`id ${given} 不是 ${prefix} 前缀`)
      return given
    }
    return build(prefix, nextCounted(Date.now()))
  },

  /**
   * 铸一个 **严格大于** `after` 的 id。
   *
   * 必须有这个:用户消息的 id 由 renderer 乐观铸出,assistant 消息的 id 由 host 铸出,
   * 两个进程的同毫秒计数器互相看不见。同一毫秒内两边都从 counter=1 起步,时间戳段会
   * 撞上,顺序就退化成随机后缀决定 —— 那正是"回复排在提问前面"这类幽灵 bug。
   */
  ascendingAfter(prefix: IdPrefix, after: string | undefined): string {
    const now = nextCounted(Date.now())
    if (!after) return build(prefix, now)
    const previous = sortKeyOf(after)
    return build(prefix, now > previous ? now : previous + 1n)
  },

  /** 从 id 反解毫秒时间戳。 */
  timestampOf(id: string): number {
    return Number(sortKeyOf(id) >> COUNTER_BITS)
  },
}
