#!/usr/bin/env bun
/**
 * 信箱调试台冒烟:对 **构建产物** 用 **产品运行时** 跑一次完整的本机演练。
 *
 * 与 kernel-smoke 同一个存在理由的延伸:mailbox-host.mjs 把 bench + 内核整个
 * inline,内核或 bench 的一次重构可以零编译错误地把守护进程弄死。这里用
 * Electron + ELECTRON_RUN_AS_NODE(打包 app 里 main 起守护的同一条路)跑
 * sim 角色:守护自我 spawn 两个角色子进程 → 各自跑真内核 host → 假模型两轮
 * (第 1 轮判据失败 → mother 裁 continue → 第 2 轮 write 工具创建判据要的
 * 文件 → 守卫终局 passed)。不要 key、不要网络、不碰硬件。
 *
 * 用法:
 *   bun packages/desktop/scripts/mailbox-smoke.ts
 * 前置:先 `bun --cwd packages/desktop run build`(或单独 `bun scripts/build-mailbox.ts`)。
 */

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, "..")

const hostBundle = join(desktop, "out", "main", "mailbox-host.mjs")
const turnBundle = join(desktop, "out", "main", "mailbox-turn-entry.mjs")
const electron = join(desktop, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

for (const bundle of [hostBundle, turnBundle]) {
  if (!existsSync(bundle)) fail(`没有构建产物 ${bundle} —— 先跑 bun --cwd packages/desktop run build`)
}

// ---------------------------------------------------------------------------
// 布景:目标仓 + 各隔离目录 + 任务书 + 守护配置(全在临时目录,跑完即清)
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "yoma-mailbox-smoke-"))
const target = join(root, "target")
const git = (...args: string[]) => execFileSync("git", ["-C", target, ...args], { encoding: "utf8" })
execFileSync("git", ["init", "-q", "-b", "main", target])
git("config", "user.email", "smoke@yoma.local")
git("config", "user.name", "yoma-smoke")
writeFileSync(join(target, "main.c"), "int main(void){return 0;}\n")
git("add", "-A")
git("commit", "-q", "-m", "init")

const checkCommand = process.platform === "win32" ? "cmd /c if exist proof.txt (exit 0) else (exit 1)" : "test -f proof.txt"
const jobFile = join(root, "job.json")
writeFileSync(
  jobFile,
  JSON.stringify(
    {
      id: "smoke-1",
      title: "打包冒烟:本机演练",
      task: "演练:创建 proof.txt",
      repo: { directory: target },
      success: { checks: [{ type: "bash", command: checkCommand }] },
      policy: "unattended",
      budget: { maxIterations: 3, maxTokens: 100_000, wallClockMin: 5 },
      mailbox: { maxRounds: 3, mother: { maxTokensPerAnalysis: 50_000 } },
    },
    null,
    2,
  ),
)

const configFile = join(root, "host-config.json")
writeFileSync(
  configFile,
  JSON.stringify(
    {
      role: "sim",
      jobFile,
      root: join(root, "sim"),
      pollSeconds: 1,
      timeoutMin: 4,
      sessionsRoot: join(root, "sessions"),
      configDir: join(root, "my-pi-config"),
      turnEntry: turnBundle,
      hostEntry: hostBundle,
      faux: {
        turns: [
          [[{ text: "我先看了一圈,还没有改动" }]],
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
    null,
    2,
  ),
)

// ---------------------------------------------------------------------------
// 起守护(产品运行时:Electron + ELECTRON_RUN_AS_NODE),收 @@event 流
// ---------------------------------------------------------------------------

const execPath = existsSync(electron) ? electron : process.execPath
console.log(`守护运行时:${execPath === electron ? "Electron(RUN_AS_NODE)" : "本机 node/bun 兜底"}`)

interface DoneEvent {
  type: "done"
  exitCode: number
  detail: string
  verdict?: { outcome: string; reason: string; decidedBy?: string }
}

const child = spawn(execPath, [hostBundle, configFile], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
})

let done: DoneEvent | undefined
let sawChildHello = false
let pending = ""
child.stdout.on("data", (chunk: Buffer) => {
  pending += chunk.toString()
  const lines = pending.split("\n")
  pending = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.startsWith("@@event ")) continue
    try {
      const event = JSON.parse(line.slice("@@event ".length)) as Record<string, unknown>
      if (event.type === "progress") console.log(`  ${String(event.message)}`)
      if (event.type === "child") {
        const inner = (event as { event: { type: string } }).event
        if (inner.type === "hello") sawChildHello = true
        if (inner.type === "step") console.log(`  [${String(event.role)}] step: ${JSON.stringify((inner as { outcome: unknown }).outcome).slice(0, 120)}`)
      }
      if (event.type === "done") done = event as unknown as DoneEvent
    } catch {
      // 非 JSON 行忽略。
    }
  }
})
child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk))

const timer = setTimeout(() => {
  console.error("✗ 冒烟超时(5 分钟),杀掉守护")
  child.kill("SIGKILL")
}, 5 * 60 * 1000)

const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
clearTimeout(timer)

// ---------------------------------------------------------------------------
// 判定:done 事件 + 退出码 + 目标仓里被提交的证据,三样都要
// ---------------------------------------------------------------------------

let failed = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) console.log(`✓ ${name}`)
  else {
    failed += 1
    console.error(`✗ ${name}${detail ? `:${detail}` : ""}`)
  }
}

check("守护进程退出码 0", code === 0, `实际 ${code}`)
check("收到 done 事件且终局 passed", done?.verdict?.outcome === "passed", JSON.stringify(done))
check("终局由守卫裁决(判据不归模型管)", done?.verdict?.decidedBy === "policy", done?.verdict?.decidedBy)
check("子进程的结构化事件穿透上来了", sawChildHello)

let proof = ""
try {
  proof = git("show", "agent/smoke-1:proof.txt")
} catch {
  // 留空,下面的 check 报
}
check("proof.txt 已提交在目标仓 agent 分支上", proof.trim() === "bench-ok", proof.slice(0, 80))

if (failed === 0) rmSync(root, { recursive: true, force: true })
else console.error(`现场保留在 ${root} 供排查`)

console.log(failed === 0 ? "\n冒烟通过:打包产物在产品运行时里跑通了完整本机演练。" : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
