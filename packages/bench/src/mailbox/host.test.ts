/**
 * 守护宿主(host.ts)—— 桌面端产品形态的引擎侧入口。
 *
 * 压轴的是 sim 自我 spawn 的假模型全闭环:两个真子进程(bun 跑 host-entry.ts)、
 * 真 git 信箱、真内核 host、真权限门、真 write 工具、真判据 —— 只有模型是脚本。
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

async function writeJobFile(dir: string, targetDir: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const file = path.join(dir, "job.json")
  await writeFile(file, JSON.stringify(rawMailboxJob(targetDir, overrides), null, 2))
  return file
}

describe("runMailboxHost:一次性角色", () => {
  test("init 入箱后 status 能看到 awaiting-runner,事件全程结构化", async () => {
    const target = await makeTargetRepo(temp)
    const { bare, motherClone } = await makeMailbox(temp)
    const jobFile = await writeJobFile(temp.dir("job-"), target)

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
    expect(snapshot.snapshot.state).toEqual({ kind: "awaiting-runner", round: 1 })
    expect(snapshot.snapshot.job?.id).toBe("m-1")
    expect(snapshot.snapshot.rounds[0]?.instruction?.issuedBy).toBe("init")
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
      job: rawMailboxJob(workspace),
      workspace,
      sessionsRoot: temp.dir("sessions-"),
      stateDir: temp.dir("state-"),
      configDir: temp.dir("config-"),
      prompt: "演练:创建 proof.txt",
      maxTokens: 100_000,
      spentTokens: 0,
      unattended: true,
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
  test("两轮走到 verdict passed,改动真的落在目标仓 agent 分支上", async () => {
    const target = await makeTargetRepo(temp)
    const root = temp.dir("sim-root-")
    const jobFile = await writeJobFile(temp.dir("job-"), target, {
      success: { checks: [{ type: "bash", command: "test -f proof.txt" }] },
    })

    const { events, emit } = collect()
    const code = await runMailboxHost(
      {
        role: "sim",
        jobFile,
        root: path.join(root, "sim"),
        pollSeconds: 1,
        timeoutMin: 3,
        sessionsRoot: temp.dir("sessions-"),
        configDir: temp.dir("config-"),
        hostEntry: path.join(import.meta.dir, "host-entry.ts"),
        faux: {
          turns: [
            // 第 1 轮:只侦察不动手 —— 判据必须失败,逼出 mother 的 continue。
            [[{ text: "我先看了一圈,还没有改动" }]],
            // 第 2 轮:真的用 write 工具创建判据要的文件。
            [[{ tool: "write", input: { path: "proof.txt", content: "bench-ok\n" } }], [{ text: "已创建 proof.txt" }]],
          ],
          mother: [
            [
              {
                text: '第 1 轮没有改动,判据自然不过。\n```json\n{"decision":"continue","analysis":"首轮只是侦察","instruction":"用 write 工具创建 proof.txt,内容 bench-ok"}\n```',
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

    // 终局真相从模拟根里 mother 的克隆读(runSim 收尾时已对齐远端)。
    const verdict = await readVerdict(path.join(root, "sim", "mother-clone"))
    expect(verdict?.outcome).toBe("passed")
    expect(verdict?.decidedBy).toBe("policy")

    // 目标仓:agent 分支上有提交,proof.txt 是被提交的(不是散落的工作区文件)。
    const show = await runGitReal(["show", "agent/m-1:proof.txt"], target)
    expect(show.ok).toBe(true)
    expect(show.stdout.trim()).toBe("bench-ok")
  }, 180_000)
})
