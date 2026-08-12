/**
 * 子进程输出的**流式**分行。零 import 的叶子模块。
 *
 * 两个坑都是"逐 chunk `chunk.toString().split("\n")`"这一种写法自带的,而且都静默:
 *
 * 1. **多字节 UTF-8 被劈断**。chunk 边界落在一个汉字中间,两半各自解码就是两个 U+FFFD,
 *    而且不可逆(根 CLAUDE.md「会咬人的地方」里那条)。进度行里全是中文。
 * 2. **一行被劈成两行**。一条行可以远超一个 pipe chunk(≤64KiB):终局那条 `@@event`
 *    带着几万字的终报,中文 3 字节/字。劈开之后 `host.ts` 的
 *    `/^\[(runner|mother)\] @@event (.*)$/` 两半都匹配不上 —— 终局快照**整条丢掉**,
 *    还倒过来被当成两行乱码进度转发。
 *
 * `TextDecoder` + `{ stream: true }` 管第一条(半个字符留在解码器里),`pending` 管第二条
 * (半行留到下一个 chunk)。**每条流各建一个**:stdout 与 stderr 共用一个的话,两边的
 * 半行会互相串进对方的行里。
 */

export interface LineDecoder {
  push(chunk: Buffer): void
  /** 流结束时冲掉最后那条没有换行结尾的残行。 */
  flush(): void
}

export function lineDecoder(onLine: (line: string) => void): LineDecoder {
  const decoder = new TextDecoder()
  let pending = ""
  return {
    push(chunk) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) onLine(line.trimEnd())
    },
    flush() {
      if (pending.trim()) onLine(pending.trimEnd())
      pending = ""
    },
  }
}
