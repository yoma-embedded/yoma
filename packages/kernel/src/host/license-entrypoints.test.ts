/**
 * 守门:**驱动模型的调用点只许出现在过了授权检查的方法里**。
 *
 * 行为层的用例(license-gate.test.ts)钉的是今天这两个入口;这一条钉的是"明天有人加第三个入口"。
 * 发动机的 lane 上能花钱的动作就三个:`accept`(接受一轮)、`drive`(驱动它)、`compact`(手动压缩)。
 * 会话间里任何一个方法只要碰了它们,就必须先 `this.license.assertCanExecute(...)`,而且要排在
 * `this.stop(` 之前 —— 没授权的请求不该有本事打断一轮已经被接受的执行(它可能正在烧录)。
 *
 * 这是按源码文本扫的粗网:注释剥离只认整行 `//` 与块注释,够用即可,目的是让漏挂检查变成一条红的用例,
 * 而不是一次要靠审稿人眼力的评审。
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const hostDir = import.meta.dirname

/** lane 上会产生模型费用的调用。`requestAbort` / `abort` / `waitForIdle` / `navigateTree` 不在此列。 */
const PAID_CALL = /\blane!?\s*\.\s*(accept|drive|compact)\s*\(/
const GATE_CALL = /this\.license\.assertCanExecute\(/

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)[ \t]*\/\/[^\n]*/g, "$1")
}

/** 把类体粗切成方法:两格缩进的 `async name(` / `private async name(` / `name(` 起头,到下一个同级方法为止。 */
function methodsOf(source: string): Array<{ name: string; body: string }> {
  const heads = [...source.matchAll(/\n {2}(?:private |public |protected )?(?:async )?([A-Za-z_]\w*)\s*\([^\n]*\{\s*\n/g)]
  return heads.map((head, index) => ({
    name: head[1]!,
    body: source.slice(head.index!, heads[index + 1]?.index ?? source.length),
  }))
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(full)
  }
  return out
}

describe("付费执行入口的守门", () => {
  const sessionManager = stripComments(readFileSync(path.join(hostDir, "session-manager.ts"), "utf8"))

  it("session-manager 里每个碰 lane.accept / drive / compact 的方法,都先过授权检查,且排在 stop() 之前", () => {
    const paid = methodsOf(sessionManager).filter((method) => PAID_CALL.test(method.body))
    // 今天恰好是这两个。多了一个 = 新入口,先确认它挂了检查,再来改这里的清单。
    expect(paid.map((method) => method.name).sort()).toEqual(["compact", "prompt"])

    for (const method of paid) {
      const gateAt = method.body.search(GATE_CALL)
      expect(gateAt, `${method.name}() 没有授权检查`).toBeGreaterThanOrEqual(0)
      expect(gateAt, `${method.name}() 的授权检查排在付费调用之后`).toBeLessThan(method.body.search(PAID_CALL))
      const stopAt = method.body.search(/this\.stop\(/)
      if (stopAt >= 0) expect(gateAt, `${method.name}() 的授权检查排在 stop() 之后`).toBeLessThan(stopAt)
      const openAt = method.body.search(/this\.ensureOpen\(/)
      if (openAt >= 0) expect(gateAt, `${method.name}() 的授权检查排在 ensureOpen() 之后`).toBeLessThan(openAt)
    }
  })

  it("会话间之外没有第二个地方直接驱动 lane(工具间、投影器、服务都不该花模型的钱)", () => {
    const offenders = walk(hostDir)
      .filter((file) => path.basename(file) !== "session-manager.ts")
      .filter((file) => PAID_CALL.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => path.relative(hostDir, file))
    expect(offenders).toEqual([])
  })

  it("产物入口不传授权的测试接缝:kernel-entry 只认编译期注入的策略", () => {
    const repoRoot = path.resolve(hostDir, "..", "..", "..", "..")
    const entries = [
      "packages/desktop/src/main/kernel-entry.ts",
      "packages/bench/src/turn-entry.ts",
      "packages/bench/src/mailbox/host-entry.ts",
    ]
    for (const entry of entries) {
      const source = stripComments(readFileSync(path.join(repoRoot, entry), "utf8"))
      expect(source, entry).not.toMatch(/licensePolicy|licenseNow|LicenseService|trustedKeys/)
    }
  })
})
