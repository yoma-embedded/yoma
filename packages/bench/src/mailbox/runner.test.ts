import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { runGitReal } from "../git.ts"
import type { TurnInput } from "../runner.ts"
import { initMailbox } from "./init.ts"
import { runnerStep, type MailboxRunnerOptions } from "./runner.ts"
import { parseMailboxJob } from "./spec.ts"
import {
  attachArtifacts,
  writeDecision,
  writeInstruction,
  TOOLCHAIN_FILE,
  type RoundArtifact,
  type RoundResultFile,
} from "./store.ts"
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

  test("回传通道:outbox 里的东西收进本轮 back/,收过的移进 .sent 不重传", async () => {
    const { mailbox } = await fixture()
    const workRoot = temp.dir("work-")
    await issue(mailbox, 1, "采一段 Ch2 电流回来")

    // agent 这一轮往投递目录里丢了采集(子目录形状要保得住)。
    const outcome = await runnerStep(
      options(mailbox.runnerClone, workRoot, {
        runTurn: async (input: TurnInput) => {
          const outbox = path.join(input.workspace, "outbox", "capture")
          mkdirSync(outbox, { recursive: true })
          writeFileSync(path.join(outbox, "ch2.csv"), "t,iq\n0,0.10\n")
          return fakeTurn({ text: "采完了,曲线在附件里" })
        },
      }),
    )
    expect(outcome.kind).toBe("ran")

    const verify = await freshClone(temp, mailbox.bare)
    expect(await Bun.file(path.join(verify, "rounds", "001", "back", "capture", "ch2.csv")).text()).toContain("t,iq")
    const result = (await Bun.file(path.join(verify, "rounds", "001", "result.json")).json()) as RoundResultFile
    expect(result.back?.map((item) => item.name)).toEqual(["capture/ch2.csv"])
    // 自述全文另存一份:提示词里只进节选,细节让研发端自己去读。
    expect(await Bun.file(path.join(verify, "rounds", "001", "bench-report.md")).text()).toContain("采完了")

    // 收过的移进 .sent(工位机留底),投递目录里不再有 —— 下一轮扫的是空目录,
    // 同一份采集不会被传第二次。
    const workspace = workspaceOf(workRoot)
    expect(await Bun.file(path.join(workspace, "outbox", "capture", "ch2.csv")).exists()).toBe(false)
    expect(await Bun.file(path.join(workspace, "outbox", ".sent", "001", "capture", "ch2.csv")).exists()).toBe(true)
  })

  test("推送失败时投递目录原封不动 —— 下一轮还能把同一份采集送出去", async () => {
    const { mailbox } = await fixture()
    const workRoot = temp.dir("work-")
    await issue(mailbox, 1, "采一段回来")

    // 回填那一步推不上去(网断)。这一轮不算数,底稿必须留着。
    const pushBroken: typeof runGitReal = (args, cwd) =>
      args[0] === "push" ? Promise.resolve({ ok: false, stdout: "", stderr: "网断了" }) : runGitReal(args, cwd)
    const outcome = await runnerStep(
      options(mailbox.runnerClone, workRoot, {
        gitRun: pushBroken,
        runTurn: async (input: TurnInput) => {
          mkdirSync(path.join(input.workspace, "outbox"), { recursive: true })
          writeFileSync(path.join(input.workspace, "outbox", "ch2.csv"), "t,iq\n0,0.1\n")
          return fakeTurn()
        },
      }),
    )
    expect(outcome.kind).toBe("blocked")

    // 归档发生在推送成功之后 —— 否则下一次 pullReset 的 clean -fd 会把没提交的
    // back/ 抹掉,而投递目录已经空了:那一轮的采集就永远回不去研发端。
    const workspace = workspaceOf(workRoot)
    expect(await Bun.file(path.join(workspace, "outbox", "ch2.csv")).exists()).toBe(true)
    expect(await Bun.file(path.join(workspace, "outbox", ".sent", "001", "ch2.csv")).exists()).toBe(false)
  })

  test("ASK-HUMAN.txt 抬成人工请求,不当附件传", async () => {
    const { mailbox } = await fixture()
    const workRoot = temp.dir("work-")
    await issue(mailbox, 1, "上电复现")

    await runnerStep(
      options(mailbox.runnerClone, workRoot, {
        runTurn: async (input: TurnInput) => {
          const outbox = path.join(input.workspace, "outbox")
          mkdirSync(outbox, { recursive: true })
          writeFileSync(path.join(outbox, "ASK-HUMAN.txt"), "请把台架电源设为 24V 并接到母线,电机保持不转\n")
          return fakeTurn({ text: "母线无电,先报上来" })
        },
      }),
    )

    const verify = await freshClone(temp, mailbox.bare)
    const result = (await Bun.file(path.join(verify, "rounds", "001", "result.json")).json()) as RoundResultFile
    expect(result.needsHuman).toContain("24V")
    // 它是"这轮卡在人身上"的信号,不是一件要送给研发端的资料。
    expect(result.back).toBeUndefined()
    expect(await Bun.file(path.join(verify, "rounds", "001", "back", "ASK-HUMAN.txt")).exists()).toBe(false)
  })

  test("挂起等人时工位端空转:不跑轮、把请求原样报给宿主", async () => {
    const { mailbox } = await fixture()
    await issue(mailbox, 1, "上电复现")
    await runnerStep(options(mailbox.runnerClone, temp.dir("work-")))
    // 裁决从工位端这个克隆写出去 —— 它刚推过结果,是当前的那一份;这里要验的是
    // "看到挂起就停手",不是两个克隆谁先推。
    await writeDecision(mailbox.runnerClone, {
      round: 1,
      by: "mother",
      decision: "await-human",
      ask: "请把台架电源设为 24V",
      at: new Date().toISOString(),
    })
    await commitPush({ clone: mailbox.runnerClone, author: { name: "t", email: "t@e.c" } }, "挂起")

    let turns = 0
    const outcome = await runnerStep(
      options(mailbox.runnerClone, temp.dir("work-"), {
        runTurn: async () => {
          turns += 1
          return fakeTurn()
        },
      }),
    )
    expect(turns).toBe(0)
    expect(outcome.kind).toBe("awaiting-human")
    if (outcome.kind === "awaiting-human") expect(outcome.ask).toContain("24V")
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

  describe("工具链清单", () => {
    /** 跑一轮,把交给子进程的那份 TurnInput 抓出来。 */
    async function inputOfOneRound(mailbox: { runnerClone: string }, workRoot: string): Promise<TurnInput> {
      let seen: TurnInput | undefined
      await runnerStep(
        options(mailbox.runnerClone, workRoot, {
          runTurn: async (input: TurnInput) => {
            seen = input
            return fakeTurn()
          },
        }),
      )
      if (!seen) throw new Error("这一轮没有调用 runTurn")
      return seen
    }

    /**
     * 比"同一份声明"而不是逐字节相同:清单要过一趟 git,而 Windows 上 checkout 会把
     * 行尾 LF 换成 CRLF(实测写出去 LF、收回来 CRLF)。这对下游无害 —— parseManifest
     * 走 JSON.parse,剥行注释也只认换行本身 —— 但逐字节断言会在 Windows 上假红。
     */
    function sameDocument(received: string | undefined, expected: string): void {
      expect(received).toBeDefined()
      expect(JSON.parse(received!)).toEqual(JSON.parse(expected))
    }

    test("信箱里有清单:原文灌进子进程,并按工位端一侧核对", async () => {
      // 这一侧**没有项目检出**,`<工程>/.my-pi/toolchain.json` 不在它的工作目录里。
      // 不把原文送过去,resolveToolchain 就静默返回空,工位端对"缺什么、怎么装"一无所知
      // —— 表现是 agent 撞一个 ModuleNotFoundError 再把它当成"脚本坏了"报回研发端。
      const { mailbox } = await fixture()
      const manifest = '{"schema":"yoma/toolchain@1","tools":[{"id":"jlink","side":"runner"}]}\n'
      writeFileSync(path.join(mailbox.motherClone, TOOLCHAIN_FILE), manifest)
      await issue(mailbox, 1, "跑一下")

      const input = await inputOfOneRound(mailbox, temp.dir("work-"))
      sameDocument(input.toolchainManifestText, manifest)
      expect(input.toolchainSide).toBe("runner")
    })

    test("信箱里没有清单:不编一份,但身份仍然是 runner", async () => {
      // 项目没声明工具链是常态,那条路径必须完全静默 —— 但"这台机器是工位端"与
      // "项目有没有清单"无关,side 不能因此退回 mother(退回了就会去核编译器)。
      const { mailbox } = await fixture()
      await issue(mailbox, 1, "跑一下")

      const input = await inputOfOneRound(mailbox, temp.dir("work-"))
      expect(input.toolchainManifestText).toBeUndefined()
      expect(input.toolchainSide).toBe("runner")
    })
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
