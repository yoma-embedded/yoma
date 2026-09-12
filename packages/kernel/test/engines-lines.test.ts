/**
 * runEngineLines(host/domain/engines.ts)的验收:流式子进程那一条。
 *
 * 单独开一个文件而不是往 engines.test.ts 里塞,是为了第 3 刀两个人并行时不撞同一个文件;
 * 纪律上它与 runEngine 是同一套(argv 直传、杀树、有界结算),那一组仍在 engines.test.ts。
 *
 * 这里只钉三件 runEngine 给不了的事:逐行回调真的逐行、onLine 说 stop 时子进程真的死、超时仍然有界。
 * 第二条是 grep / find 的命根子:`rg --json` 在一个真工程上能吐几十 MB,而模型只要头 100 行 ——
 * "数到 limit 就杀掉 rg"要是没生效,表现不是报错,而是一次搜索把上下文预算烧光。
 */

import { describe, expect, it } from "vitest"

import { runEngineLines } from "../src/host/domain/engines.ts"

/** 假引擎一律是当前这个 node 跑一段 -e 脚本:argv 直传,三平台同构,不碰 .cmd 启动器。 */
function node(script: string): [string, string[]] {
  return [process.execPath, ["-e", script]]
}

describe("runEngineLines", () => {
  it("逐行回调,最后一行没有换行符也照样交付", async () => {
    const lines: string[] = []
    // 故意分三次写、最后一行不带 \n:一次 data 事件不等于一行,而收尾的冲刷是独立的一支。
    const [bin, args] = node(
      `process.stdout.write("one\\n"); process.stdout.write("tw"); process.stdout.write("o\\nthree");`,
    )
    const result = await runEngineLines(bin, args, { onLine: (line) => void lines.push(line) })
    expect(lines).toEqual(["one", "two", "three"])
    expect(result.exitCode).toBe(0)
    expect(result.stopped).toBe(false)
    expect(result.timedOut).toBe(false)
  })

  it("onLine 返回 stop 就杀掉子进程:后面的行不再来,也不等它活完", async () => {
    const lines: string[] = []
    // 打一行就睡 30 s:没被杀掉的话这条用例会超时,而不是断言失败。
    const [bin, args] = node(
      `process.stdout.write("first\\n"); setTimeout(() => process.stdout.write("second\\n"), 200); setTimeout(() => {}, 30000);`,
    )
    const started = Date.now()
    const result = await runEngineLines(bin, args, {
      onLine: (line) => {
        lines.push(line)
        return "stop"
      },
    })
    expect(lines).toEqual(["first"])
    expect(result.stopped).toBe(true)
    // 30 s 的脚本必须在几百毫秒内结算 —— 这就是"真的被杀了"的可观察形式。
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it("超时也有界:进程不退也会带着 timedOut 结算", async () => {
    const [bin, args] = node(`setTimeout(() => {}, 30000);`)
    const result = await runEngineLines(bin, args, { timeoutMs: 300, onLine: () => {} })
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
  })
})
