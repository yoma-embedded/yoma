// 流式分行的两个坑各钉一条。两条都是**静默**失败,而且从前 sim.ts 那份逐 chunk
// toString().split("\n") 的写法两条全中 —— 所以这里必须按字节喂,不能"跑个打中文的
// 例子看花不花"(那种写法在任何一台 UTF-8 开发机上都会通过,是个不会响的闸门)。
import { describe, expect, it } from "bun:test"

import { lineDecoder } from "./lines.ts"

function feed(chunks: Buffer[], flush = true): string[] {
  const out: string[] = []
  const decoder = lineDecoder((line) => out.push(line))
  for (const chunk of chunks) decoder.push(chunk)
  if (flush) decoder.flush()
  return out
}

describe("lineDecoder", () => {
  it("chunk 边界劈开一个汉字也不产生 U+FFFD", () => {
    const bytes = Buffer.from("研发端开局:读任务书\n", "utf8")
    // 在第一个汉字的三个字节中间切开
    for (const cut of [1, 2, 4, 5]) {
      const out = feed([bytes.subarray(0, cut), bytes.subarray(cut)])
      expect(out).toEqual(["研发端开局:读任务书"])
      expect(out.join("")).not.toContain("�")
    }
  })

  it("跨 chunk 的长行拼回一整行,不被劈成两行", () => {
    // 终局那条 @@event 带着整篇终报,远超一个 pipe chunk(≤64KiB)。
    const payload = `@@event ${JSON.stringify({ type: "snapshot", report: "很长的终报".repeat(20_000) })}`
    const bytes = Buffer.from(`${payload}\n`, "utf8")
    expect(bytes.byteLength).toBeGreaterThan(64 * 1024)
    const chunks: Buffer[] = []
    for (let i = 0; i < bytes.byteLength; i += 65536) chunks.push(bytes.subarray(i, i + 65536))
    expect(chunks.length).toBeGreaterThan(1)

    const out = feed(chunks)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(payload)
    // host.ts 就是靠这条正则把它升格成结构化事件的 —— 劈开就整条丢掉。
    expect(/^@@event (.*)$/.exec(out[0]!)).not.toBeNull()
  })

  it("flush 冲出没有换行结尾的残行;不 flush 就留在解码器里", () => {
    expect(feed([Buffer.from("没有换行", "utf8")])).toEqual(["没有换行"])
    expect(feed([Buffer.from("没有换行", "utf8")], false)).toEqual([])
  })

  it("空行与只有空白的行照旧跳过", () => {
    expect(feed([Buffer.from("a\n\n  \nb\n", "utf8")])).toEqual(["a", "b"])
  })
})
