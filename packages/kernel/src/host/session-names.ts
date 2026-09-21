/**
 * 不打开会话,从 JSONL 里读出它的会话名。
 *
 * 【为什么需要】`repo.list` 只读会话文件的头一行,而会话名是后来追加的一条值写(namespace `pi.session.name`)——
 * 列表里的会话因此只有占位标题(工程目录名),要等被打开时 `fillListed` 才补上。自动起名之前这只是"重启后
 * 侧栏里全是同一个名字、点开才对";有了自动起名,它就变成"起好的名字重启就没了"。
 *
 * 【为什么不走 repo.open】那要把整个会话解析进内存,而且一个会话同一时刻只许开一次(repo.open 对已开的直接抛)。
 * 这里只按字节扫值行:找 `"namespace":"pi.session.name"` 这串字节,命中才解析那一行,最后一次 set / delete 为准
 * (改过名的,后写的赢)。消息正文里的同样字样在 JSONL 里是转义过的(`\"namespace\":\"pi…`),对不上这串字节。
 *
 * 【格式是上游的】packages/agent 的 JSONL v4:一行一个事务,单条写是对象、多条写是数组(`io.ts` 的
 * serializeJsonlTransaction)。session-names.test.ts 用真 repo 写名字再读回来,上游一改格式它先红。
 * 读不出来(旧的 v3 格式、文件坏了、正被改写)一律当"没有名字":只关乎显示,打开会话时 fillListed 会补上真名。
 */

import { open } from "node:fs/promises"

import { sessionName } from "@earendil-works/pi-agent-core"

const NEEDLE = Buffer.from(`"namespace":${JSON.stringify(sessionName.namespace)}`)
const NEWLINE = 0x0a
const CHUNK_BYTES = 1 << 20
/**
 * 一行超过这么长就不攒了,直接跳到下一个换行。名字那一行只有几十个字节;超长的是大段工具输出,
 * 攒着它们只会让每读一块都把前面整行再拷一遍。
 */
const MAX_LINE_BYTES = 1 << 20

/** 一行(一个事务)里对会话名的写:有 set 取最后一个值,有 delete 就是没名字,都没有是 undefined。 */
function nameWrite(line: string): { name: string | undefined } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  let result: { name: string | undefined } | undefined
  for (const write of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!write || typeof write !== "object") continue
    const { kind, op, namespace, key, value } = write as Record<string, unknown>
    if (kind !== "value" || namespace !== sessionName.namespace || key !== sessionName.key) continue
    if (op === "set" && typeof value === "string") result = { name: value }
    else if (op === "delete") result = { name: undefined }
  }
  return result
}

/** 会话文件里最后写下的会话名;没有、或读不出来是 undefined。 */
export async function readSessionName(file: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, "r")
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
    let name: string | undefined
    let carry: Buffer = Buffer.alloc(0)
    // 正在跳过一条超长的行:它的开头已经丢了,里面就算命中也不是完整的一行。
    let skipping = false
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, null)
      if (bytesRead === 0) break
      const buffer = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      const complete = buffer.lastIndexOf(NEWLINE) + 1
      let from = 0
      if (skipping) {
        const end = buffer.indexOf(NEWLINE)
        if (end === -1) {
          carry = Buffer.alloc(0)
          continue
        }
        skipping = false
        from = end + 1
      }
      for (let hit = buffer.indexOf(NEEDLE, from); hit !== -1 && hit < complete; hit = buffer.indexOf(NEEDLE, from)) {
        const start = buffer.lastIndexOf(NEWLINE, hit) + 1
        const end = buffer.indexOf(NEWLINE, hit)
        const found = nameWrite(buffer.toString("utf8", Math.max(start, from), end))
        if (found) name = found.name
        from = end + 1
      }
      // 没有换行结尾的那半行留到下一块;太长就放弃它,从下一个换行接着读。
      const rest = buffer.subarray(complete)
      if (rest.length > MAX_LINE_BYTES) {
        carry = Buffer.alloc(0)
        skipping = true
      } else {
        carry = Buffer.from(rest)
      }
    }
    // 写到一半的最后一行(没有换行结尾)不算:下次打开会话时上游自己会修掉它。
    return name
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}
