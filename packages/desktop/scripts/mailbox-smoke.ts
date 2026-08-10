#!/usr/bin/env bun
/**
 * 信箱调试台冒烟:对 **构建产物** 用 **产品运行时** 跑一次完整的本机演练。
 *
 * 与 kernel-smoke 同一个存在理由的延伸:mailbox-host.mjs 把 bench + 内核整个
 * inline,内核或 bench 的一次重构可以零编译错误地把守护进程弄死。这里用
 * Electron + ELECTRON_RUN_AS_NODE(打包 app 里 main 起守护的同一条路)跑
 * sim 角色:守护自我 spawn 两个角色子进程 → 各自跑真内核 host → 假模型两轮
 * (第 1 轮工位端报"东西不在" → 研发端 write 修复并把产物**当附件**下发 →
 * 第 2 轮工位端在自己的一次性工作目录里读到它 → 研发端裁 done)。
 * 不要 key、不要网络、不碰硬件。
 *
 * 用法:
 *   bun packages/desktop/scripts/mailbox-smoke.ts
 * 前置:先 `bun --cwd packages/desktop run build`(或单独 `bun scripts/build-mailbox.ts`)。
 */

import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, "..")

const hostBundle = join(desktop, "out", "main", "mailbox-host.mjs")
const turnBundle = join(desktop, "out", "main", "mailbox-turn-entry.mjs")

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/**
 * Electron 二进制的位置按平台不同。**找不到就失败,绝不静默回退到本机 bun/node** ——
 * 这个冒烟的全部意义就是"用产品运行时跑打包产物",退回去之后绿灯只代表 bun 能跑,
 * 而 Windows CI 恰恰是最需要它的地方(那里没有 .app 目录)。
 */
function resolveElectron(): string {
  const dist = join(desktop, "node_modules", "electron", "dist")
  const candidates =
    process.platform === "darwin"
      ? [join(dist, "Electron.app", "Contents", "MacOS", "Electron")]
      : process.platform === "win32"
        ? [join(dist, "electron.exe")]
        : [join(dist, "electron")]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  fail(`找不到 Electron 二进制(找过 ${candidates.join("、")})—— 先 bun install;这个冒烟必须跑在产品运行时上`)
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

const jobFile = join(root, "job.json")
writeFileSync(
  jobFile,
  JSON.stringify(
    {
      id: "smoke-1",
      title: "打包冒烟:本机演练",
      task: "演练:创建 proof.txt",
      repo: { directory: target },
      budget: { maxRounds: 3, maxTokens: 100_000, wallClockMin: 5 },
      mailbox: { mother: { maxTokensPerAnalysis: 50_000 } },
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
      // 假模型脚本:分工与生产一致 —— **代码归研发端,工位端只观察**,而且工位端
      // 没有项目检出,东西全靠附件过去。剧本覆盖的正是这条链:改码 → 构建产物当
      // 附件下发 → 工位端在自己的一次性工作目录里拿到 → 研发端读自述判定 done。
      faux: {
        turns: [
          [[{ text: "上板看了一圈:工作目录里没有 proof.txt,现象复现" }]],
          [[{ text: "收到附件了,读出来是 bench-ok" }]],
        ],
        mother: [
          [
            {
              text: '开局先确认现状。\n```json\n{"decision":"continue","analysis":"还没有任何观测","instruction":"上板复现一次,报告你看到了什么"}\n```',
            },
          ],
          // 研发端读完第 1 轮结果:先在项目仓里改代码……
          [{ tool: "write", input: { path: "proof.txt", content: "bench-ok\n" } }],
          // ……再把产物**当附件**下发。工位端没有项目检出,附件是它拿到东西的唯一通道。
          [
            {
              text: '缺的东西补上了,产物随这一轮附过去。\n```json\n{"decision":"continue","analysis":"第 1 轮确认了缺失,已补上","instruction":"附件里有 proof.txt,确认它到了你的工作目录并把内容报回来","artifacts":["proof.txt"]}\n```',
            },
          ],
          // 第 2 轮回填之后:研发端自己判断做完了 —— 没有独立判据,done 是模型说的。
          [
            {
              text: '证据够了。\n```json\n{"decision":"done","analysis":"工位端确认收到并读出了 bench-ok","reason":"proof.txt 已送达工位端并被读出,内容正确"}\n```',
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

const execPath = resolveElectron()
console.log(`守护运行时:Electron(RUN_AS_NODE)—— ${execPath}`)

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
// 逐 chunk `toString()` 会劈断多字节 UTF-8:done 事件那一行带着整份终报,中文
// 3 字节/字,轻松超过一个 pipe chunk(≤64KiB),边界大概率落在字符中间。各自解码
// 得到两个 U+FFFD,而 JSON 的结构字符全是 ASCII,parse 照样成功 —— 乱码静默进
// 判定。与 main/mailbox.ts 同一条纪律:TextDecoder + { stream: true }。
const stdoutDecoder = new TextDecoder()
child.stdout.on("data", (chunk: Buffer) => {
  pending += stdoutDecoder.decode(chunk, { stream: true })
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
        if (inner.type === "step")
          console.log(
            `  [${String(event.role)}] step: ${JSON.stringify((inner as { outcome: unknown }).outcome).slice(0, 120)}`,
          )
      }
      if (event.type === "done") done = event as unknown as DoneEvent
    } catch {
      // 非 JSON 行忽略。
    }
  }
})
child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk))

/**
 * 停守护:**先 SIGTERM,宽限后才 SIGKILL**。
 *
 * sim 守护自己 spawn 两个角色子进程,角色守护又 spawn turn 孙进程。SIGKILL 捕获不到,
 * 守护来不及转杀,孙进程就漏成孤儿 —— 实测踩过:一次超时的冒烟留下一个 mother host
 * 空转轮询了一天多(5 分钟 CPU)。这里是 mother 角色所以只是白烧 CPU,同样的漏法
 * 出在 runner 角色上就是一个攥着探针不放的孤儿,而那个报错长得和"没插板子"一样。
 * 与 app 退出路径(main/mailbox.ts 的 stopAll)同一条纪律。
 */
const KILL_GRACE_MS = 10_000
function stopDaemon(why: string): void {
  console.error(`✗ ${why},停守护`)
  child.kill("SIGTERM")
  const hard = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
  hard.unref?.()
}

const timer = setTimeout(() => stopDaemon("冒烟超时(5 分钟)"), 5 * 60 * 1000)
// Ctrl-C 同理:默认行为只带走本进程,守护与孙进程会活下来继续跑。
const onSignal = (signal: NodeJS.Signals) => stopDaemon(`收到 ${signal}`)
process.once("SIGINT", onSignal)
process.once("SIGTERM", onSignal)

const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
clearTimeout(timer)
process.off("SIGINT", onSignal)
process.off("SIGTERM", onSignal)

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
check("终局由研发端裁决(通过与否归模型)", done?.verdict?.decidedBy === "mother", done?.verdict?.decidedBy)
check("子进程的结构化事件穿透上来了", sawChildHello)

let proof = ""
try {
  proof = git("show", "agent/smoke-1:proof.txt")
} catch {
  // 留空,下面的 check 报
}
check("proof.txt 已提交在目标仓 agent 分支上", proof.trim() === "bench-ok", proof.slice(0, 80))

// 附件是工位端拿到任何东西的**唯一**通道 —— 这条链断了整个闭环就是哑的,必须钉住。
let attached = ""
try {
  attached = readFileSync(join(root, "sim", "mother-clone", "rounds", "002", "instruction.json"), "utf8")
} catch {
  // 留空,下面的 check 报
}
check("第 2 轮指令带上了 proof.txt 附件", attached.includes('"name": "proof.txt"'), attached.slice(0, 200))

if (failed === 0) rmSync(root, { recursive: true, force: true })
else console.error(`现场保留在 ${root} 供排查`)

console.log(failed === 0 ? "\n冒烟通过:打包产物在产品运行时里跑通了完整本机演练。" : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
