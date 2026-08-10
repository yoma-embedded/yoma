/**
 * 守护宿主(host.ts)—— 桌面端产品形态的引擎侧入口。
 *
 * 压轴的是 sim 自我 spawn 的假模型全闭环:两个真子进程(bun 跑 host-entry.ts)、
 * 真 git 信箱、真内核 host、真 write 工具、真附件邮路 —— 只有模型是脚本。
 * 它钉住的与 P1 打包冒烟(纯 node 对 esbuild 产物)是同一条代码路径,两边只差
 * 运行时;这里绿了而冒烟红了,问题必然在打包管线而不是引擎。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { FauxScript } from "../faux.ts"
import { runGitReal } from "../git.ts"
import type { TurnResult } from "../turn.ts"
import { runMailboxHost, type MailboxHostEvent } from "./host.ts"
import { readVerdict } from "./store.ts"
import { makeMailbox, makeTargetRepo, rawMailboxJob, Temp } from "./testkit.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

function collect(): { events: MailboxHostEvent[]; emit: (event: MailboxHostEvent) => void } {
  const events: MailboxHostEvent[] = []
  return { events, emit: (event) => events.push(event) }
}

async function writeJobFile(dir: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const file = path.join(dir, "job.json")
  await writeFile(file, JSON.stringify(rawMailboxJob(overrides), null, 2))
  return file
}

describe("runMailboxHost:一次性角色", () => {
  test("init 入箱后 status 能看到 kickoff(第一轮归研发端),事件全程结构化", async () => {
    const { bare, motherClone } = await makeMailbox(temp)
    const jobFile = await writeJobFile(temp.dir("job-"))

    const init = collect()
    const initCode = await runMailboxHost({ role: "init", clone: motherClone, jobFile }, init.emit)
    expect(initCode).toBe(0)
    expect(init.events[0]).toEqual({ type: "hello", role: "init", pid: process.pid })
    const initDone = init.events.find((event) => event.type === "done")
    expect(initDone?.exitCode).toBe(0)

    // status 用一个全新克隆看远端真相 —— init 的产物必须已经推出去。
    const statusClone = path.join(temp.dir("status-"), "clone")
    const status = collect()
    const statusCode = await runMailboxHost({ role: "status", clone: statusClone, remote: bare }, status.emit)
    expect(statusCode).toBe(0)
    const snapshot = status.events.find((event) => event.type === "snapshot")
    if (snapshot?.type !== "snapshot") throw new Error("没有 snapshot 事件")
    expect(snapshot.snapshot.state).toEqual({ kind: "kickoff" })
    expect(snapshot.snapshot.job?.id).toBe("m-1")
    // init 只放任务书 —— 一个轮次都还没有。
    expect(snapshot.snapshot.rounds).toEqual([])
  })

  test("配置残缺时如实抛,不猜默认值", async () => {
    const { emit } = collect()
    await expect(runMailboxHost({ role: "init", clone: undefined, jobFile: "x.json" }, emit)).rejects.toThrow("守护配置缺 clone")
  })
})

describe("faux 脚本穿过真 turn-entry 子进程", () => {
  test("TurnInput.faux 让一轮不要 key 跑完,text 与工具调用如实回填", async () => {
    const workspace = await makeTargetRepo(temp)
    const input = {
      job: { ...rawMailboxJob(), repo: { directory: workspace } },
      workspace,
      sessionsRoot: temp.dir("sessions-"),
      stateDir: temp.dir("state-"),
      configDir: temp.dir("config-"),
      prompt: "演练:创建 proof.txt",
      maxTokens: 100_000,
      spentTokens: 0,
      faux: [
        [{ tool: "write", input: { path: "proof.txt", content: "bench-ok\n" } }],
        [{ text: "已创建 proof.txt" }],
      ] satisfies FauxScript,
    }
    const inputFile = path.join(temp.dir("turn-"), "in.json")
    const outputFile = inputFile.replace("in.json", "out.json")
    await writeFile(inputFile, JSON.stringify(input))

    const entry = path.join(import.meta.dir, "..", "turn-entry.ts")
    const child = spawn(process.execPath, [entry, inputFile, outputFile], { stdio: ["ignore", "ignore", "inherit"] })
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
    expect(code).toBe(0)

    const result = JSON.parse(await readFile(outputFile, "utf8")) as TurnResult
    expect(result.text).toBe("已创建 proof.txt")
    expect(result.toolCalls.map((call) => call.tool)).toEqual(["write"])
    expect(result.stopReason).toBeUndefined()
    expect(await readFile(path.join(workspace, "proof.txt"), "utf8")).toBe("bench-ok\n")
  }, 30_000)
})

describe("sim 自我 spawn:假模型全闭环", () => {
  test("两轮走到 verdict passed,代码改动落在研发端的 agent 分支上", async () => {
    const target = await makeTargetRepo(temp)
    const root = temp.dir("sim-root-")
    const jobFile = await writeJobFile(temp.dir("job-"))

    const { events, emit } = collect()
    const code = await runMailboxHost(
      {
        role: "sim",
        jobFile,
        // 工程目录是本机配置,不在任务书里 —— 演练走的是和生产同一条路。
        projectDir: target,
        root: path.join(root, "sim"),
        pollSeconds: 1,
        timeoutMin: 3,
        sessionsRoot: temp.dir("sessions-"),
        configDir: temp.dir("config-"),
        hostEntry: path.join(import.meta.dir, "host-entry.ts"),
        faux: {
          // 工位端只观察、只汇报 —— 它没有项目检出,手上只有附件。
          turns: [
            [[{ text: "上电看了一圈,工作目录里没有 proof.txt" }]],
            [[{ text: "研发端给的 proof.txt 已就位,内容是 bench-ok" }]],
          ],
          // 研发端一条共享队列:开局取证 → 改代码(write)+ 附产物 → 读证据收工。
          mother: [
            [
              {
                text: '还没有任何证据,先让工位端看一眼。\n```json\n{"decision":"continue","analysis":"开局先取证","instruction":"看看工作目录里有没有 proof.txt,把结果说回来"}\n```',
              },
            ],
            [{ tool: "write", input: { path: "proof.txt", content: "bench-ok\n" } }],
            [
              {
                text: '我把 proof.txt 建好了,顺手附给你。\n```json\n{"decision":"continue","analysis":"缺的就是这个文件","instruction":"东西在附件里,再验一次并把内容原文贴回来","artifacts":["proof.txt"]}\n```',
              },
            ],
            [
              {
                text: '工位端读到的内容和我发过去的一致。\n```json\n{"decision":"done","analysis":"附件已到位且内容对得上","reason":"工位端原文回报 bench-ok,与研发端构建的产物一致"}\n```',
              },
            ],
          ],
        },
      },
      emit,
    )

    const done = events.find((event) => event.type === "done")
    expect(done?.type === "done" && done.verdict?.outcome).toBe("passed")
    expect(code).toBe(0)

    // 子进程的结构化事件穿透上来了(sim 转发的 child 事件)。
    expect(events.some((event) => event.type === "child" && event.event.type === "hello")).toBe(true)

    // 终局真相从模拟根里研发端的克隆读(runSim 收尾时已对齐远端)。
    const verdict = await readVerdict(path.join(root, "sim", "mother-clone"))
    expect(verdict?.outcome).toBe("passed")
    expect(verdict?.decidedBy).toBe("mother")

    // 目标仓:agent 分支上有提交,proof.txt 是被**研发端**提交的,不是散落的工作区文件。
    const show = await runGitReal(["show", "agent/m-1:proof.txt"], target)
    expect(show.ok).toBe(true)
    expect(show.stdout.trim()).toBe("bench-ok")

    // 附件真的穿过了信箱,落在工位端那个一次性工作目录里(它没有项目检出)。
    expect(await readFile(path.join(root, "sim", "work", "m-1", "work", "proof.txt"), "utf8")).toBe("bench-ok\n")
  }, 180_000)
})
