/**
 * flash 工具的厨房那一半:探针独占执行器。
 *
 * 2026-08 起不再内置 probe-rs(Windows 上它要求换 WinUSB 驱动,与厂商驱动互斥 ——
 * 对 J-Link 用户等于弄坏 SEGGER 全家)。烧录命令由模型自带(OpenOCD / J-Link
 * Commander / STM32CubeProgrammer CLI / pyocd / west / esptool …),这个工具只管
 * 三件 bash 给不了的事:
 *
 * 1. 探针租约:gdb server、日志采集与烧录抢同一个探针时,错误要指名持有者 ——
 *    bash 起的进程在租约体系里是隐形的,所以凡碰探针的命令都该走这里。
 * 2. 有界超时 + 杀树(runEngine):挂死的烧录器攥着探针不放,下一次失败长得和
 *    硬件坏了一模一样。
 * 3. flash-state 落账:exit 0 且给了 elfPath 时记录 sha256,gdb attach 用它判断
 *    "手里的 ELF 是不是就是片子里跑的那个"。
 *
 * 错误分类学与其他引擎工具不同:烧录器非零退出**不抛错**,而是把输出连同
 * "占用/没插"的分诊当正常结果返回 —— 没插探针是常态而非异常,模型要读到
 * 提示才知道让用户接硬件。只有超时/中断才抛。
 *
 * 2026-09-11 按新内核接口重写,三处与 attic 版不同:
 * - env 不再由工厂注入,每次 execute 从 toolContext 拿 —— 内核每轮重解析工具上下文,
 *   工厂期拿住的 env 会停在建会话那一刻的 cwd 上。
 * - 中止改走 context.abortSignal(新 execute 没有 signal 参数)。忘了递下去的代价是
 *   用户按"停止"时烧录器不死、探针不放,而下一次失败长得和板子坏了一样。
 * - flash-state 直接用 node:fs,不再绕 ExecutionEnv 的 Result 接口:攥探针的工具本来
 *   就只在探针插着的那台机器上起子进程,多一层可插拔文件系统换不来任何可移植性。
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { executionEnvSnapshot } from "../../domain/execution-env.ts"

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import {
  assertEngineSettled,
  claimProbe,
  clamp,
  describeProbeConflict,
  probeFailedHint,
  releaseProbe,
  runEngine,
} from "../../domain/engines.ts"
import { appendTail } from "../../domain/engines.ts"
import { resolveToCwd } from "../../domain/paths.ts"
import { FLASH_CONTRACT, type FlashDetails } from "./contract.ts"

/** 烧录动真实硬件,默认超时比引擎默认值(5 分钟)紧。 */
const FLASH_TIMEOUT_MS = 2 * 60 * 1000
const MIN_TIMEOUT_MS = 5 * 1000
const MAX_TIMEOUT_MS = 10 * 60 * 1000

/** 超时钳位单独成函数:纯函数可测,不必为了钉"下界 5 秒"真起一个子进程去赌计时。 */
export function flashTimeoutMs(timeoutMs: number | undefined): number {
  return clamp(timeoutMs, FLASH_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/**
 * 最后一次成功烧录的记录。gdb 会话靠它判断"手里的 ELF 是不是就是片子里跑的那个"。
 *
 * 这条记录挡的是整套工具里最贵的一次失败,而且那次失败**没有任何错误文本**:
 * 改了代码、重编了、忘了烧,然后问 agent 为什么新逻辑不生效。行号偏几行、
 * 调用栈看着合理、变量值看着合理,于是模型写出一份完全自洽、完全虚构的根因分析。
 */
export interface FlashState {
  elfPath: string
  sha256: string
  at: number
}

/** 工具产物只许落 <工程>/.yoma/(那个目录自带 .gitignore)。 */
export const FLASH_STATE_FILE = path.join(".yoma", "flash-state.json")

export async function sha256File(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
}

/** 读不到/读坏了都返回 undefined:这是提示信息,不该成为烧录或调试的拦路虎。 */
export async function readFlashState(cwd: string): Promise<FlashState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(cwd, FLASH_STATE_FILE), "utf8")) as FlashState
    return typeof parsed?.sha256 === "string" ? parsed : undefined
  } catch {
    return undefined
  }
}

/** gdb 的 `load` 也会改写片子里的镜像,所以它也要记这本账(否则下一次 gdb start 会把它报成"镜像不符")。 */
export async function writeFlashState(cwd: string, state: FlashState): Promise<void> {
  const file = path.join(cwd, FLASH_STATE_FILE)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(state, null, "\t")}\n`)
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

export function createFlashTool(): AgentHarnessTool<
  ExecutionToolContext,
  typeof FLASH_CONTRACT.parameters,
  FlashDetails
> {
  return {
    name: FLASH_CONTRACT.name,
    label: FLASH_CONTRACT.label,
    description: FLASH_CONTRACT.description,
    parameters: FLASH_CONTRACT.parameters,
    // 一次烧录攥着探针:两条 flash 并发跑只会互相撞成 0xe00002c5。
    executionMode: "sequential",
    // replay 不声明(默认 never):崩溃恢复绝不自动重烧 —— 有副作用的硬件动作重放一次
    // 的代价可能是一块砖,而"上次烧到哪一步"内核并不知道。
    execute: async (_toolCallId, params, onUpdate, toolContext, _invocation, context) => {
      const cwd = toolContext.env.cwd
      const processEnv = executionEnvSnapshot(toolContext.env)
      const command = params.command
      if (command.length === 0 || !command[0]?.trim()) {
        throw new Error(
          'flash requires command — the flasher argv, e.g. ["openocd","-f",...] or ["JLink","-CommanderScript",...]',
        )
      }
      const elf = params.elfPath ? resolveToCwd(cwd, params.elfPath) : undefined
      // 预检存在性:烧一个不存在的镜像时,烧录器自己的报错五花八门,而这一句是确定的。
      if (elf && !(await fileExists(elf))) throw new Error(`elfPath not found: ${elf}`)

      const label = path.basename(command[0])
      // 这一轮已经被用户停掉:一个探针都别碰。runEngine 要到 spawn 之后才看信号,
      // 不在这里拦的话,"停止"之后烧录器仍会真的起一次、真的攥一下探针。
      if (context.abortSignal?.aborted) throw new Error(`flash ${label} was aborted`)
      // runEngine 是一次性调用,租约只在这一次调用期间成立。claim 与冲突 throw 必须留在 try 之外:
      // releaseProbe 只比 owner 名,挪进去的话,撞上**上一次还没跑完的 flash** 时 finally 会把它的
      // 租约抹掉,于是两路烧录各自以为独占探针。
      const holder = claimProbe("flash", label)
      if (holder) throw new Error(`flash: ${describeProbeConflict(holder)}`)
      let result: Awaited<ReturnType<typeof runEngine>>
      // 烧录器的输出边跑边上卡片:"** Programming Started **" 该在它出现的那一秒被看见,
      // 而不是几十秒后整条命令结束时。快照只是活尾巴,全文仍在结果里。
      let live = ""
      try {
        result = await runEngine(command[0], command.slice(1), {
          cwd,
          env: processEnv,
          signal: context.abortSignal,
          timeoutMs: flashTimeoutMs(params.timeoutMs),
          onOutput: ({ text }) => {
            live = appendTail(live, text)
            // running 态的 exitCode 恒为 null,不是"被信号杀掉":将来的烧录卡片按 state.status 判,别看这一格。
            onUpdate({ content: [{ type: "text", text: live }], details: { command, exitCode: null } })
          },
        })
      } finally {
        releaseProbe("flash")
      }
      // 只判超时/中断:烧录器非零退出不抛错(见文件头),那条策略留在下面。
      assertEngineSettled(result, `flash ${label}`)

      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
      const details: FlashDetails = { command, exitCode: result.exitCode }
      if (result.exitCode !== 0) {
        const text = `flash \`${label}\` failed (exit ${result.exitCode}):\n${output || "(no output)"}\n${probeFailedHint(output)}`
        return { content: [{ type: "text", text }], details }
      }
      let recorded = ""
      if (elf) {
        // 算 hash 和落盘都不该让一次成功的烧录变成报错(elfPath 指到目录、预检之后被删、没权限):
        // 片子已经烧好了,报错只会让模型再烧一次 —— 它只是让 gdb 少一条校验线索。
        const ok = await (async () => {
          await writeFlashState(cwd, { elfPath: elf, sha256: await sha256File(elf), at: Date.now() })
          return true
        })().catch(() => false)
        if (ok) {
          details.recordedElf = elf
          recorded = `\nrecorded ${elf} as the image on the target — gdb start will verify against it.`
        }
      }
      return {
        content: [{ type: "text", text: `${output || `flash \`${label}\` completed (exit 0)`}${recorded}` }],
        details,
      }
    },
  }
}
