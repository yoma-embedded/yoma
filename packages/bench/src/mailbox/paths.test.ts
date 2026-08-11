import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import path from "node:path"

import { myPiConfigDir } from "@yoma-desktop/kernel/host"

import { cloneDirFor, defaultConfigDir, defaultMailboxRoot } from "./paths.ts"

describe("defaultConfigDir", () => {
  test("与内核的 myPiConfigDir() 是同一个目录 —— 分叉是静默的", () => {
    // paths.ts 刻意不 import 内核(它必须是叶子模块,否则桌面端 main 的 bundle 会被
    // 拖进整个内核,见 paths.ts 顶部)。代价是两份实现,这条断言就是那份代价的对冲:
    // 两边分叉的表现是"信箱去了一个目录、凭据在另一个",谁都不报错。
    expect(defaultConfigDir()).toBe(myPiConfigDir())
  })

  test("信箱根就在配置目录下面 —— 一处管凭据/技能/上下文/信箱", () => {
    expect(defaultMailboxRoot()).toBe(path.join(defaultConfigDir(), "mailbox"))
    expect(defaultMailboxRoot()).toBe(path.join(homedir(), ".my-pi", "mailbox"))
  })
})

describe("cloneDirFor", () => {
  const REMOTE = "git@github.com:me/mailbox.git"

  test("换分支就换目录 —— 复用停在旧分支的克隆会让 init 死在 git 报错上", () => {
    // ensureClone 见到 .git/HEAD 就早返回、不改分支,孤儿分支逻辑因此不会跑;
    // 最后 `push -u origin run-1:run-1` 报 "src refspec run-1 does not match any"。
    // 目录带上分支,这条路就走不到了。
    expect(cloneDirFor("/m", REMOTE, "mother", "run-1")).not.toBe(cloneDirFor("/m", REMOTE, "mother", "run-2"))
  })

  test("留空 / 显式 main / 带空格的 main 都是同一条分支,必须同一个目录", () => {
    // sync.ts 的 branchOf 就是 `branch ?? "main"` —— 这里不归一的话,同一条分支会有
    // 两个克隆,而用户在界面上看不出任何区别。
    const canonical = cloneDirFor("/m", REMOTE, "mother", "main")
    expect(cloneDirFor("/m", REMOTE, "mother")).toBe(canonical)
    expect(cloneDirFor("/m", REMOTE, "mother", "")).toBe(canonical)
    expect(cloneDirFor("/m", REMOTE, "mother", "  main  ")).toBe(canonical)
  })

  test("角色仍然分目录 —— 同机双角色不共享工作树", () => {
    expect(cloneDirFor("/m", REMOTE, "mother", "run-1")).not.toBe(cloneDirFor("/m", REMOTE, "runner", "run-1"))
  })

  test("远端与分支的拼接不会撞车", () => {
    // 用 \n 分隔(分支名不能含换行),否则 ("a","b") 与 ("ab","") 会哈希到一起。
    expect(cloneDirFor("/m", "a", "mother", "b")).not.toBe(cloneDirFor("/m", "ab", "mother", ""))
  })

  test("status 绝不能和守护落在同一个目录 —— 它会 reset --hard + clean -fd", () => {
    // status 要 pullReset 才能看到最新状态,而 pullReset 是破坏性的:撞上正在写这一轮
    // 的守护,就把它还没提交的 instruction/附件清掉,守护随后 commitPush 发现无改动,
    // 一整轮模型分析静默作废,报出来却是"指令推不上去"。所以 status 自己一个克隆。
    const mother = cloneDirFor("/m", REMOTE, "mother", "run-1")
    const runner = cloneDirFor("/m", REMOTE, "runner", "run-1")
    const status = cloneDirFor("/m", REMOTE, "status", "run-1")
    expect(status).not.toBe(mother)
    expect(status).not.toBe(runner)
  })

  test("同一个信箱同一个角色只有一个物理目录 —— 这是 .yoma-lock 生效的前提", () => {
    // 锁文件是 <clone>/.yoma-lock/<role>.pid,锁的是目录不是信箱。桌面端与命令行
    // 只要都走 defaultMailboxRoot() + cloneDirFor(),就一定落在同一个目录上。
    const fromDesktop = cloneDirFor(defaultMailboxRoot(), REMOTE, "mother", "run-1")
    const fromCli = cloneDirFor(defaultMailboxRoot(), REMOTE, "mother", "run-1")
    expect(fromCli).toBe(fromDesktop)
  })
})
