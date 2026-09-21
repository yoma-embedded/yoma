/**
 * 守门:**驱动模型的调用点只许出现在过了授权检查的路上**。
 *
 * 行为层的用例(license-gate.test.ts)钉的是今天这两个入口;这一条钉的是"明天有人加第三个入口"。
 * 发动机的 lane 上能花钱的动作就三个:`accept`(接受一轮)、`drive`(驱动它)、`compact`(手动压缩);
 * 另有 `steer`(往收件箱里塞东西,下一个工具边界被正在跑的那一轮取走 —— 塞的是用户的话就等于给这一轮续命)。
 *
 * 会话间的形状(子 agent 进来之后):
 *
 *   prompt()  ── 授权检查 ──▶ admitPrompt() ──▶ 空闲:runOperation()  /  正忙:lane.steer()(排队)
 *   compact() ── 授权检查 ──▶ lane.compact()
 *   wake()      ──▶ runOperation({ prompt: [] })   只取走收件箱里**已有**的东西,不带新的用户输入
 *   runChild()  ──▶ runOperation() / lane.steer()   子 agent 的一轮,只能由 TaskManager 经 taskPort() 起
 *
 * 后两条**刻意不查授权**:它们是已被接受的工作的延续 —— 子 agent 是一轮已接受的执行里的 agent / send_message
 * 工具派出去的,wake 取走的是子 agent 的完成通知与过了检查才排进来的用户消息。到期不打断已接受的执行,
 * 所以它们跑完、汇报完为止;用户想再说一句新的,仍然只有 prompt() 一条路。
 * 这张表就是下面几条断言的内容:任何一处对不上(多了一个碰 lane 的方法、多了一个调用者、prompt() 的检查被
 * 挪到分岔之后)都是一条红的用例,先确认那条新路该不该查,再来改表。
 *
 * 这是按源码文本扫的粗网:注释剥离只认整行 `//` 与块注释,够用即可,目的是让漏挂检查变成一条红的用例,
 * 而不是一次要靠审稿人眼力的评审。
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const hostDir = import.meta.dirname

/** lane 上会产生模型费用的调用。`requestAbort` / `abort` / `waitForIdle` / `navigateTree` / `cancelQueued` 不在此列。 */
const PAID_CALL = /\blane!?\s*\.\s*(accept|drive|compact)\s*\(/
/** 往收件箱里塞东西。 */
const STEER_CALL = /\blane!?\s*\.\s*steer\s*\(/
const GATE_CALL = /this\.license\.assertCanExecute\(/

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)[ \t]*\/\/[^\n]*/g, "$1")
}

interface Method {
  name: string
  isPrivate: boolean
  body: string
}

/**
 * 把 `SessionManager` 的类体粗切成方法:两格缩进起头的 `name(` / `private async name<T>(`,到下一个同级方法为止。
 * **头可以跨行**(`private async admitPrompt(\n    entry: Entry, …`)—— 第一版要求头写在一行里,于是跨行声明的方法
 * 整个并进了上一个方法的体里,而"上一个方法"恰好是 prompt():那种切法下 prompt 的体里什么都有,断言就空了。
 */
function methodsOf(source: string): Method[] {
  const classAt = source.indexOf("export class SessionManager")
  const body = classAt >= 0 ? source.slice(classAt) : source
  const heads = [
    ...body.matchAll(
      /\n {2}(private |public |protected )?(?:static )?(?:async )?(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b|await\b|new\b|typeof\b|constructor\b)([A-Za-z_]\w*)\s*(?:<[^>\n]*>)?\(/g,
    ),
  ]
  return heads.map((head, index) => ({
    name: head[2]!,
    isPrivate: head[1] === "private ",
    body: body.slice(head.index!, heads[index + 1]?.index ?? body.length),
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
  const methods = methodsOf(sessionManager)
  const method = (name: string): Method => {
    const found = methods.filter((candidate) => candidate.name === name)
    expect(found.length, `${name}() 应该恰好有一个`).toBe(1)
    return found[0]!
  }
  const callersOf = (name: string): string[] =>
    methods
      .filter((candidate) => candidate.name !== name && new RegExp(`this\\.${name}\\(`).test(candidate.body))
      .map((candidate) => candidate.name)
      .sort()

  /** 检查必须排在这个方法里的一切副作用之前:付费调用、stop()、打开会话、排队 / 起一轮的分岔。 */
  function expectGateFirst(target: Method): void {
    const gateAt = target.body.search(GATE_CALL)
    expect(gateAt, `${target.name}() 没有授权检查`).toBeGreaterThanOrEqual(0)
    for (const [what, pattern] of [
      ["付费调用", PAID_CALL],
      ["steer", STEER_CALL],
      ["stop()", /this\.stop\(/],
      ["ensureOpen()", /this\.ensureOpen\(/],
      ["admit()", /this\.admit\(/],
      ["runOperation()", /this\.runOperation\(/],
    ] as const) {
      const at = target.body.search(pattern)
      if (at >= 0) expect(gateAt, `${target.name}() 的授权检查排在 ${what} 之后`).toBeLessThan(at)
    }
  }

  it("方法切分认得跨行的方法头(否则下面几条都是空转)", () => {
    const names = methods.map((candidate) => candidate.name)
    for (const expected of ["prompt", "admitPrompt", "runOperation", "wake", "runChild", "taskPort", "compact"]) {
      expect(names, expected).toContain(expected)
    }
    // prompt() 的体到 admitPrompt 的头为止:里面不该有准备附件、排队这些属于 admitPrompt 的东西。
    expect(method("prompt").body).not.toMatch(/processImage|\.steer\(/)
  })

  it("碰 lane.accept / drive / compact 的方法只有两个:runOperation(私有)与 compact(入口自己查)", () => {
    const paid = methods.filter((candidate) => PAID_CALL.test(candidate.body))
    expect(paid.map((candidate) => candidate.name).sort()).toEqual(["compact", "runOperation"])
    expect(method("runOperation").isPrivate).toBe(true)
    expectGateFirst(method("compact"))
  })

  it("runOperation 的调用者恰好三个;带用户输入的那一条(admitPrompt)只有 prompt() 能到,而 prompt() 先查授权", () => {
    expect(callersOf("runOperation")).toEqual(["admitPrompt", "runChild", "wake"])

    expect(method("admitPrompt").isPrivate).toBe(true)
    expect(callersOf("admitPrompt")).toEqual(["prompt"])
    // 查在分岔之前:空闲时起一轮的、忙时排进收件箱的,都是用户的一句新话。
    expectGateFirst(method("prompt"))
  })

  it("不查授权的两条延续路是私有的,而且带不进新的用户输入", () => {
    // wake:空 prompt,只取走收件箱里已有的东西。
    const wake = method("wake")
    expect(wake.isPrivate).toBe(true)
    expect(wake.body).toMatch(/this\.runOperation\(\s*entry\s*,\s*\{\s*kind:\s*"prompt"\s*,\s*prompt:\s*\[\]\s*\}\s*\)/)

    // runChild:子 agent 的一轮。唯一的调用者是交给 TaskManager 的那个端口,没有任何 RPC 直接到得了它。
    expect(method("runChild").isPrivate).toBe(true)
    expect(callersOf("runChild")).toEqual(["taskPort"])
    expect(method("taskPort").isPrivate).toBe(true)
  })

  it("往收件箱里塞东西(steer)的方法就这几个;塞用户的话的只有 admitPrompt", () => {
    const steering = methods.filter((candidate) => STEER_CALL.test(candidate.body)).map((candidate) => candidate.name)
    // admitPrompt = 用户忙时发的消息(prompt() 查过了);taskPort / runChild = 主 agent 的 send_message 续跑子 agent;
    // deliver = 子 agent 的完成通知;restoreInbox = 停止时把没取走的放回去。多出来一个 = 新的注入口,先看它塞的是什么。
    expect(steering.sort()).toEqual(["admitPrompt", "deliver", "restoreInbox", "runChild", "taskPort"])
    for (const name of ["deliver", "restoreInbox"]) expect(method(name).isPrivate, name).toBe(true)
  })

  it("会话间之外没有第二个地方直接驱动 lane(工具间、投影器、TaskManager、服务都不该花模型的钱)", () => {
    const offenders = walk(hostDir)
      .filter((file) => path.basename(file) !== "session-manager.ts")
      .filter((file) => {
        const source = stripComments(readFileSync(file, "utf8"))
        return PAID_CALL.test(source) || STEER_CALL.test(source)
      })
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
