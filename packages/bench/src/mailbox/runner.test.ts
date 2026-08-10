import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"

import { runGitReal } from "../git.ts"
import type { TurnInput } from "../runner.ts"
import { initMailbox } from "./init.ts"
import { runnerStep, type MailboxRunnerOptions } from "./runner.ts"
import { parseMailboxJob } from "./spec.ts"
import { attachArtifacts, writeDecision, writeInstruction, type RoundArtifact, type RoundResultFile } from "./store.ts"
import { commitPush } from "./sync.ts"
import { fakeTurn, freshClone, makeMailbox, rawMailboxJob, Temp, usage } from "./testkit.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

async function fixture(jobOverrides: Record<string, unknown> = {}) {
  const mailbox = await makeMailbox(temp)
  const mailboxJob = parseMailboxJob(rawMailboxJob(jobOverrides))
  const initialized = await initMailbox({ clone: mailbox.motherClone, mailboxJob })
  expect(initialized.initialized).toBe(true)
  return { mailbox, mailboxJob }
}

/** 站在研发端下发一轮(init 不再写第一轮指令了 —— 那是研发端的活)。 */
async function issue(
  mailbox: { motherClone: string },
  round: number,
  prompt: string,
  artifacts?: RoundArtifact[],
): Promise<void> {
  await writeInstruction(mailbox.motherClone, {
    round,
    prompt,
    issuedBy: "mother",
    artifacts,
    at: new Date().toISOString(),
  })
  await commitPush({ clone: mailbox.motherClone, author: { name: "t", email: "t@e.c" } }, `下发第 ${round} 轮`)
}

/** 工位端这个任务的一次性工作目录(附件落这儿,agent 的 cwd 也是这儿)。 */
function workspaceOf(workRoot: string): string {
  return path.join(workRoot, "m-1", "work")
}

function options(clone: string, workRoot: string, overrides: Partial<MailboxRunnerOptions> = {}): MailboxRunnerOptions {
  return {
    clone,
    // 工位端没有项目检出:工作目录是一次性的,内容全部来自附件。
    workRoot,
    sessionsRoot: temp.dir("sessions-"),
    runTurn: async () => fakeTurn(),
    ...overrides,
  }
}

describe("mailbox runner", () => {
  test("领第 1 轮指令 → 跑完 → 结果回填到远端;会话指针落在工作根", async () => {
    const { mailbox } = await fixture()
    const workRoot = temp.dir("work-")
    await issue(mailbox, 1, "先复现:上电看日志")
    const prompts: string[] = []

    const outcome = await runnerStep(
      options(mailbox.runnerClone, workRoot, {
        runTurn: async (input: TurnInput) => {
          prompts.push(input.prompt)
          expect(input.workspace).toBe(workspaceOf(workRoot))
          return fakeTurn({ usage: usage(200, 100) })
        },
      }),
    )
    expect(outcome.kind).toBe("ran")

    // 会话首轮带角色说明,而且说清了"你没有这个工程的源码"。
    expect(prompts[0]).toContain("你是这个调试闭环的工位端")
    expect(prompts[0]).toContain("你没有这个工程的源码")
    expect(prompts[0]).toContain("先复现:上电看日志")

    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "001", "result.json")).json()) as RoundResultFile
    expect(result.round).toBe(1)
    expect(result.spentTokens).toBe(300)
    expect(result.turn?.text).toBe("我看了一圈")

    const session = (await Bun.file(path.join(workRoot, "m-1", "session.json")).json()) as { sessionID: string }
    expect(session.sessionID).toBe("ses-1")
  })

  test("附件穿过信箱:落到工作目录根,文件名写进提示词与 result", async () => {
    const { mailbox } = await fixture()
    const workRoot = temp.dir("work-")
    // 研发端把构建产物塞进本轮目录(它那边由 attachArtifacts 做,这里直接复用)。
    const devBuild = temp.dir("dev-build-")
    writeFileSync(path.join(devBuild, "fw.elf"), "NEW-ELF")
    const attached = await attachArtifacts(
      mailbox.motherClone,
      1,
      [{ source: path.join(devBuild, "fw.elf"), name: "fw.elf", from: "build/fw.elf" }],
      1024 * 1024,
    )
    expect(attached.ok).toBe(true)
    await issue(mailbox, 1, "新固件在附件里,弄上板然后复现", attached.ok ? attached.artifacts : undefined)

    const prompts: string[] = []
    const outcome = await runnerStep(
      options(mailbox.runnerClone, workRoot, {
        runTurn: async (input: TurnInput) => {
          prompts.push(input.prompt)
          return fakeTurn()
        },
      }),
    )
    expect(outcome.kind).toBe("ran")

    // 文件真的躺在工作目录里,而且提示词里给的是那个名字。
    expect(await Bun.file(path.join(workspaceOf(workRoot), "fw.elf")).text()).toBe("NEW-ELF")
    expect(prompts[0]).toContain("fw.elf")
    // 怎么上板不由协议规定 —— 提示词只说"怎么用由你判断"。
    expect(prompts[0]).toContain("怎么用由你判断")

    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "001", "result.json")).json()) as RoundResultFile
    expect(result.incoming).toEqual(["fw.elf"])
  })

  test("结果已回填(等研发端)时空转,不重复跑", async () => {
    const { mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    let turns = 0
    const opts = options(mailbox.runnerClone, temp.dir("work-"), {
      runTurn: async () => {
        turns += 1
        return fakeTurn()
      },
    })
    await runnerStep(opts)
    const second = await runnerStep(opts)
    expect(second.kind).toBe("idle")
    expect(turns).toBe(1)
  })

  test("kickoff(零轮次)时空转 —— 第一轮归研发端出", async () => {
    const { mailbox } = await fixture()
    const outcome = await runnerStep(options(mailbox.runnerClone, temp.dir("work-")))
    expect(outcome.kind).toBe("idle")
    if (outcome.kind === "idle") expect(outcome.detail).toContain("研发端")
  })

  test("第 2 轮的提示词 = 研发端指令,角色说明不重复", async () => {
    const { mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    const prompts: string[] = []
    const opts = options(mailbox.runnerClone, temp.dir("work-"), {
      runTurn: async (input: TurnInput) => {
        prompts.push(input.prompt)
        return fakeTurn()
      },
    })
    await runnerStep(opts)

    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "mother",
      decision: "continue",
      at: new Date(0).toISOString(),
    })
    await issue(mailbox, 2, "验证假设:中断里丢了 ORE 清理")

    const outcome = await runnerStep(opts)
    expect(outcome.kind).toBe("ran")
    expect(prompts[1]).toContain("验证假设:中断里丢了 ORE 清理")
    // 会话延续,角色说明只在首轮说一次。
    expect(prompts[1]).not.toContain("你是这个调试闭环的工位端")
  })

  test("token 预算已耗尽:拒绝开轮,error 回填", async () => {
    const { mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    let turns = 0
    const opts = options(mailbox.runnerClone, temp.dir("work-"), {
      runTurn: async () => {
        turns += 1
        return fakeTurn({ usage: usage(90_000, 10_000) }) // 轮 1 一把烧光 10 万预算
      },
    })
    await runnerStep(opts)

    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "mother",
      decision: "continue",
      at: new Date(0).toISOString(),
    })
    await issue(mailbox, 2, "继续")

    const outcome = await runnerStep(opts)
    expect(outcome.kind).toBe("ran")
    expect(turns).toBe(1) // 轮 2 没真跑
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "002", "result.json")).json()) as RoundResultFile
    expect(result.error).toContain("预算")
  })

  test("信箱空着(还没 init)就空转", async () => {
    const mailbox = await makeMailbox(temp)
    const outcome = await runnerStep(options(mailbox.runnerClone, temp.dir("work-")))
    expect(outcome.kind).toBe("idle")
  })

  test("token 跨轮累计:真相在信箱里,第 2 轮叠在第 1 轮之上", async () => {
    const { mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    const opts = options(mailbox.runnerClone, temp.dir("work-"), {
      runTurn: async () => fakeTurn({ usage: usage(200, 100) }),
    })
    await runnerStep(opts) // 轮 1:spentTokens=300

    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "mother",
      decision: "continue",
      at: new Date(0).toISOString(),
    })
    await issue(mailbox, 2, "继续")

    await runnerStep(opts) // 轮 2:300 + 300
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "002", "result.json")).json()) as RoundResultFile
    expect(result.spentTokens).toBe(600)
  })

  test("预算按两侧合计:研发端花掉的部分会让工位拒绝开轮", async () => {
    const { mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    let turns = 0
    const opts = options(mailbox.runnerClone, temp.dir("work-"), {
      runTurn: async () => {
        turns += 1
        return fakeTurn({ usage: usage(40_000, 10_000) }) // 轮 1 花 5 万
      },
    })
    await runnerStep(opts)

    // 研发端的分析烧掉 6 万(记在 decision.usage),两侧合计 11 万 > 10 万预算。
    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "mother",
      decision: "continue",
      usage: usage(50_000, 10_000),
      at: new Date(0).toISOString(),
    })
    await issue(mailbox, 2, "继续")

    const outcome = await runnerStep(opts)
    expect(outcome.kind).toBe("ran")
    expect(turns).toBe(1) // 轮 2 没真跑
    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "002", "result.json")).json()) as RoundResultFile
    expect(result.error).toContain("110000")
  })

  test("轮执行失败:error 如实回填,会话指针丢掉,下一轮重开会话", async () => {
    const { mailbox } = await fixture()
    await issue(mailbox, 1, "复现")
    const sessionIDs: (string | undefined)[] = []
    const prompts: string[] = []
    const opts = options(mailbox.runnerClone, temp.dir("work-"), {
      runTurn: async (input: TurnInput) => {
        sessionIDs.push(input.sessionID)
        prompts.push(input.prompt)
        if (input.sessionID) throw new Error("子进程没有产出结果(退出码 1)")
        return fakeTurn()
      },
    })
    await runnerStep(opts) // 轮 1:无 sessionID,正常

    await writeDecision(mailbox.motherClone, {
      round: 1,
      by: "mother",
      decision: "continue",
      at: new Date(0).toISOString(),
    })
    await issue(mailbox, 2, "继续")
    await runnerStep(opts) // 轮 2:带旧 sessionID 失败 → 如实回填 + 丢掉指针

    const verify = await freshClone(temp, mailbox.bare)
    const failed = (await Bun.file(path.join(verify, "rounds", "002", "result.json")).json()) as RoundResultFile
    expect(failed.error).toContain("agent 轮执行失败")

    await writeDecision(mailbox.motherClone, {
      round: 2,
      by: "mother",
      decision: "continue",
      at: new Date(0).toISOString(),
    })
    await issue(mailbox, 3, "再来")

    const outcome = await runnerStep(opts) // 轮 3:指针已清,重开会话
    expect(outcome.kind).toBe("ran")
    expect(sessionIDs).toEqual([undefined, "ses-1", undefined])
    // 会话重开 = 新会话,角色说明必须重新带上,否则它不知道自己是工位端。
    expect(prompts[2]).toContain("你是这个调试闭环的工位端")
  })
})

describe("mailbox runner · 安全约束", () => {
  test("总任务书(含工位安全红线)必须到达工位端 —— 它不再从别处得到这些约束", async () => {
    const { mailbox } = await fixture({ task: "绝不能让电机转动:不发任何 CLI 命令。" })
    await issue(mailbox, 1, "上电看日志")
    const prompts: string[] = []
    await runnerStep(
      options(mailbox.runnerClone, temp.dir("work-"), {
        runTurn: async (input: TurnInput) => {
          prompts.push(input.prompt)
          return fakeTurn()
        },
      }),
    )
    expect(prompts[0]).toContain("绝不能让电机转动")
  })
})

describe("分支不一致:必须在动板子之前就停", () => {
  test("停在 main 的克隆 + branch run-1 —— 不跑模型、不动硬件,直接 blocked", async () => {
    // 这是最危险的一种配错:`pullReset` 在 origin/run-1 还不存在时什么都不做(那是
    // 首推前的合法状态),于是工作树仍是 main 的内容 —— 扫描器读到的是**另一个任务**
    // 的 job.json 和待执行轮。没有闸门的话工位端会真的按另一条分支上的指令去动板子,
    // 跑完一整轮才在 push 那一下报 `src refspec run-1 does not match any`。
    const { mailbox } = await fixture()
    await issue(mailbox, 1, "别的任务的指令:把电机跑到 3000rpm")

    // 工位机手工 git clone —— 停在 main。
    const clone = await freshClone(temp, mailbox.bare)
    expect((await runGitReal(["branch", "--show-current"], clone)).stdout).toBe("main")

    const prompts: string[] = []
    const outcome = await runnerStep({
      ...options(clone, temp.dir("work-"), {
        runTurn: async (input: TurnInput) => {
          prompts.push(input.prompt)
          return fakeTurn()
        },
      }),
      branch: "run-1",
    })

    expect(outcome.kind).toBe("blocked")
    if (outcome.kind === "blocked") {
      expect(outcome.detail).toContain("停在分支 main")
      expect(outcome.detail).toContain("run-1")
    }
    // 闸门的意义全在这一条上:模型没被调用,于是板子也不可能被碰。
    expect(prompts).toEqual([])
  })
})
