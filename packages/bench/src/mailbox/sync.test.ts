/**
 * 同步层对真仓库测(与 git.test.ts 同一条纪律)。重点是三件协议赖以成立的行为:
 * pullReset 让工作树等于远端真相(残渣消失、被 ignore 的本地状态幸存)、
 * commitPush 在对方先说话时 rebase 后重推、空信箱的首推能建出分支。
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { mkdir, writeFile } from "node:fs/promises"

import { fileExists } from "../fsx.ts"
import { cloneMailbox, commitPush, flushThenPullReset, initBareMailbox, pullReset, type MailboxSyncContext } from "./sync.ts"
import { freshClone, makeMailbox, Temp } from "./testkit.ts"
import { runGitReal } from "../git.ts"

const temp = new Temp()
afterEach(() => temp.cleanup())

function ctx(clone: string): MailboxSyncContext {
  return { clone, author: { name: "test", email: "test@example.com" } }
}

describe("mailbox sync", () => {
  test("空信箱首推建出 main;另一侧 pullReset 后看到内容", async () => {
    const { bare, runnerClone, motherClone } = await makeMailbox(temp)

    writeFileSync(path.join(motherClone, "job.json"), "{}\n")
    const pushed = await commitPush(ctx(motherClone), "init")
    expect(pushed.pushed).toBe(true)

    await pullReset(ctx(runnerClone))
    expect(await Bun.file(path.join(runnerClone, "job.json")).exists()).toBe(true)

    const verify = await freshClone(temp, bare)
    expect(await Bun.file(path.join(verify, "job.json")).exists()).toBe(true)
  })

  test("对方先推了别的路径:commitPush rebase 后重推,两边内容都在", async () => {
    const { bare, runnerClone, motherClone } = await makeMailbox(temp)

    writeFileSync(path.join(motherClone, "job.json"), "{}\n")
    expect((await commitPush(ctx(motherClone), "init")).pushed).toBe(true)

    // runner 先同步,然后 mother 又说了一句 —— runner 的 push 会被拒一次。
    await pullReset(ctx(runnerClone))
    mkdirSync(path.join(motherClone, "rounds", "002"), { recursive: true })
    writeFileSync(path.join(motherClone, "rounds", "002", "instruction.json"), "{}\n")
    expect((await commitPush(ctx(motherClone), "round 2")).pushed).toBe(true)

    mkdirSync(path.join(runnerClone, "rounds", "001"), { recursive: true })
    writeFileSync(path.join(runnerClone, "rounds", "001", "result.json"), "{}\n")
    expect((await commitPush(ctx(runnerClone), "round 1 result")).pushed).toBe(true)

    const verify = await freshClone(temp, bare)
    expect(await Bun.file(path.join(verify, "rounds", "001", "result.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(verify, "rounds", "002", "instruction.json")).exists()).toBe(true)
  })

  test("pullReset 清掉崩溃残渣,但被 .gitignore 的本地状态幸存", async () => {
    const { motherClone } = await makeMailbox(temp)
    writeFileSync(path.join(motherClone, "job.json"), "{}\n")
    await commitPush(ctx(motherClone), "init")

    // 崩溃残渣:写了一半没提交的轮次文件。
    mkdirSync(path.join(motherClone, "rounds", "001"), { recursive: true })
    writeFileSync(path.join(motherClone, "rounds", "001", "result.json"), "半截")
    // 本地状态:自带 .gitignore 的 .mother 目录(会话指针住在这)。
    mkdirSync(path.join(motherClone, ".mother"), { recursive: true })
    writeFileSync(path.join(motherClone, ".mother", ".gitignore"), "*\n")
    writeFileSync(path.join(motherClone, ".mother", "state.json"), `{"sessionID":"ses-9"}\n`)

    await pullReset(ctx(motherClone))
    expect(await Bun.file(path.join(motherClone, "rounds", "001", "result.json")).exists()).toBe(false)
    expect(await Bun.file(path.join(motherClone, ".mother", "state.json")).exists()).toBe(true)
  })

  test("没有改动就不提交不推送", async () => {
    const { motherClone } = await makeMailbox(temp)
    const outcome = await commitPush(ctx(motherClone), "空话")
    expect(outcome.committed).toBe(false)
    expect(outcome.pushed).toBe(false)
  })

  test("push 失败的欠账在下次同步先被推完 —— 跑完的一步不重跑", async () => {
    const { bare, runnerClone, motherClone } = await makeMailbox(temp)
    writeFileSync(path.join(motherClone, "job.json"), "{}\n")
    await commitPush(ctx(motherClone), "init")
    await pullReset(ctx(runnerClone))

    // 结果写完、本地提交成功,但 push 那一下断网。
    mkdirSync(path.join(runnerClone, "rounds", "001"), { recursive: true })
    writeFileSync(path.join(runnerClone, "rounds", "001", "result.json"), `{"round":1}\n`)
    const broken = await commitPush(
      { ...ctx(runnerClone), run: (args, cwd) => (args[0] === "push" ? Promise.resolve({ ok: false, stdout: "", stderr: "网断了" }) : runGitReal(args, cwd)) },
      "round 1",
    )
    expect(broken.committed).toBe(true)
    expect(broken.pushed).toBe(false)

    // 网络恢复后的第一次同步:欠账先推走,而不是被 reset 丢掉。
    await flushThenPullReset(ctx(runnerClone))
    const verify = await freshClone(temp, bare)
    expect(await Bun.file(path.join(verify, "rounds", "001", "result.json")).exists()).toBe(true)
  })

  test("欠账与远端同路径冲突(这步已被替代)时不硬推,照协议清场", async () => {
    const { runnerClone, motherClone } = await makeMailbox(temp)
    writeFileSync(path.join(motherClone, "job.json"), "{}\n")
    await commitPush(ctx(motherClone), "init")
    await pullReset(ctx(runnerClone))

    // runner 攒下一笔推不出去的欠账(轮 1 结果)……
    mkdirSync(path.join(runnerClone, "rounds", "001"), { recursive: true })
    writeFileSync(path.join(runnerClone, "rounds", "001", "result.json"), `{"from":"stale"}\n`)
    await commitPush(
      { ...ctx(runnerClone), run: (args, cwd) => (args[0] === "push" ? Promise.resolve({ ok: false, stdout: "", stderr: "断" }) : runGitReal(args, cwd)) },
      "欠账",
    )
    // ……与此同时这一步已被重跑并推送(同一路径,内容不同)—— rebase 必然冲突。
    mkdirSync(path.join(motherClone, "rounds", "001"), { recursive: true })
    writeFileSync(path.join(motherClone, "rounds", "001", "result.json"), `{"from":"fresh"}\n`)
    await commitPush(ctx(motherClone), "替代")

    await flushThenPullReset(ctx(runnerClone))
    // 远端版本获胜,欠账被照协议丢弃(不硬推、不留 rebase 残局)。
    expect(await Bun.file(path.join(runnerClone, "rounds", "001", "result.json")).text()).toContain("fresh")
    expect((await runGitReal(["status", "--porcelain"], runnerClone)).stdout).toBe("")
  })
})

describe("一个信箱仓跑第二个任务:新分支必须是空的", () => {
  test("远端还没有这条分支时从空树起 —— 不继承上一个任务的 verdict", async () => {
    const root = temp.dir("mailbox-branch-")
    const bare = path.join(root, "origin.git")
    await initBareMailbox(bare)

    // 第一个任务:main 上跑完,留下 job.json / rounds / verdict.json。
    const first = path.join(root, "first")
    await cloneMailbox(bare, first)
    await writeFile(path.join(first, "job.json"), "{}")
    await mkdir(path.join(first, "rounds", "001"), { recursive: true })
    await writeFile(path.join(first, "rounds", "001", "instruction.json"), "{}")
    await writeFile(path.join(first, "verdict.json"), '{"outcome":"passed"}')
    await commitPush({ clone: first, author: { name: "t", email: "t@e.c" } }, "第一个任务跑完")

    // 第二个任务换一条分支:克隆下来必须看不到上一个任务的任何东西。
    const second = path.join(root, "second")
    await cloneMailbox(bare, second, { branch: "run-2" })
    expect(await fileExists(path.join(second, "verdict.json"))).toBe(false)
    expect(await fileExists(path.join(second, "job.json"))).toBe(false)
    expect(await fileExists(path.join(second, "rounds", "001", "instruction.json"))).toBe(false)
    // 孤儿分支此刻还"未出生"(没有提交),`rev-parse --abbrev-ref HEAD` 会答 "HEAD" ——
    // 要用 branch --show-current 才看得到名字。首推之后它就正常了。
    expect((await runGitReal(["branch", "--show-current"], second)).stdout).toBe("run-2")

    // 而且它推得出去,推完 main 上的旧任务不受影响。
    await writeFile(path.join(second, "job.json"), '{"id":"第二个"}')
    const pushed = await commitPush({ clone: second, branch: "run-2", author: { name: "t", email: "t@e.c" } }, "第二个任务入箱")
    expect(pushed.pushed).toBe(true)

    const check = path.join(root, "check-main")
    await cloneMailbox(bare, check)
    expect(await fileExists(path.join(check, "verdict.json"))).toBe(true)
  })

  test("远端已有这条分支就正常跟踪它,不当成新分支清空", async () => {
    const root = temp.dir("mailbox-branch-")
    const bare = path.join(root, "origin.git")
    await initBareMailbox(bare)
    const first = path.join(root, "first")
    await cloneMailbox(bare, first, { branch: "run-3" })
    await writeFile(path.join(first, "job.json"), "{}")
    await commitPush({ clone: first, branch: "run-3", author: { name: "t", email: "t@e.c" } }, "入箱")

    const second = path.join(root, "second")
    await cloneMailbox(bare, second, { branch: "run-3" })
    expect(await fileExists(path.join(second, "job.json"))).toBe(true)
  })
})
