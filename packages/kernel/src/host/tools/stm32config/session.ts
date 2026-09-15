/**
 * stm32config 工具的厨房那一半:七个子命令 → `engines/bin/stm32kernel` → 人话。
 *
 * 退出码的分类学(与 flash 那种"非零不抛"不同,与 netlist 那种"非零就抛"也不同):
 * - 0:干净。
 * - 1:**有 ERROR 诊断,是正常结果**。stdout 上的 JSON 就是修复回路(每条诊断带 JSON Pointer 与 suggestion),
 *   配置命令附一句"修完重跑";describe-mcu / candidates 查不到型号也是 exit 1(`MCU_UNKNOWN` 带候选拼法)。
 * - 其余退出码:用法 / 内部错误或崩溃,无论 stdout 有没有内容都抛。
 *
 * 器件数据包(irpack)是 CubeMX 器件库的解析产物,**不进 git、也不随包出货**:没有 CubeMX 的构建机(CI)
 * 打出来的 Yoma 里只有内核二进制、没有数据。所以 `schema` 之外的命令在那样的机器上一个都跑不了,话要说
 * 明白(不是"引擎坏了",是"这台机器没有器件数据"),工具描述末尾那一行也从数据目录现算。
 *
 * 2026-09-15 按新内核接口重写,与阁楼版的差别:cwd 每次 execute 现取;中止走 context.abortSignal;配置文档
 * 先查存在(内核对读不到的文件回 exit 1 的 DOC_READ 诊断,那不该被说成"配置有错");`schema` 不再要求
 * 数据目录;stderr 上的进度("loaded pack …")边跑边上卡片。
 */

import { stat } from "node:fs/promises"
import path from "node:path"

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import {
  appendTail,
  assertEngineSettled,
  engineBin,
  engineDataDir,
  type EnginePathOptions,
  runEngine,
  stm32Families,
} from "../../domain/engines.ts"
import { engineErrorText, parseEngineObject, previewToolOutput } from "../../domain/tool-output.ts"
import { resolveToCwd } from "../../domain/paths.ts"
import { buildStm32ConfigArgs, CONFIG_COMMANDS, needsDataDir } from "./args.ts"
import {
  STM32CONFIG_CONTRACT,
  type Stm32ConfigCommand,
  type Stm32ConfigDetails,
  type Stm32ConfigInput,
} from "./contract.ts"

export type Stm32ConfigToolOptions = EnginePathOptions

export type Stm32ConfigTool = AgentHarnessTool<
  ExecutionToolContext,
  typeof STM32CONFIG_CONTRACT.parameters,
  Stm32ConfigDetails
>

/** 没有器件数据时给模型的话:说清是数据不在,不是引擎坏了,以及还剩什么路。 */
export function noDataPacksMessage(command: string): string {
  return (
    `stm32config ${command}: no STM32 device data packs (irpacks) are installed in this build — they are derived from STM32CubeMX and are not shipped with Yoma. ` +
    "Only `schema` works without them. Use the datasheet tool for pin / peripheral / register facts and write the HAL init by hand."
  )
}

/**
 * 支持的族由数据目录生成,不写死(见 engines.ts stm32Families() 的注释)。
 * 引擎没装好时退回一句中性的话:构造工具不该因为这个抛异常,把整个 agent 拖垮。
 */
export function describeCoverage(options?: EnginePathOptions): string {
  try {
    const families = stm32Families(options)
    if (families.length === 0) return "Coverage on this machine: no device data packs installed — only `schema` works."
    return `Device packs on this machine: ${families.length} — ${families.join(", ")}. Pack names are not a complete family catalogue (e.g. STM32L4 includes L4+); use list-mcus for parts. Packs are checked when queried.`
  } catch {
    return "Coverage on this machine: no device data packs installed (they are derived from STM32CubeMX and not shipped) — only `schema` works; use the datasheet tool for pin / peripheral facts."
  }
}

/** 数据目录:不在时把 engineBin/engineDataDir 那句"跑 engines:build"换成模型用得上的话。 */
function requireDataDir(command: Stm32ConfigCommand, options?: EnginePathOptions): string {
  try {
    const dir = engineDataDir("stm32", options)
    if (stm32Families(options).length === 0) throw new Error("empty")
    return dir
  } catch {
    throw new Error(noDataPacksMessage(command))
  }
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  )
}

export function createStm32ConfigTool(options: Stm32ConfigToolOptions = {}): Stm32ConfigTool {
  return {
    name: STM32CONFIG_CONTRACT.name,
    label: STM32CONFIG_CONTRACT.label,
    // 覆盖范围是这台机器的事实,追加在契约描述之后:契约是浏览器安全的菜单,读不了数据目录。
    description: `${STM32CONFIG_CONTRACT.description}\n\n${describeCoverage(options)}`,
    parameters: STM32CONFIG_CONTRACT.parameters,
    execute: async (_toolCallId, params, onUpdate, toolContext, _invocation, context) => {
      const cwd = toolContext.env.cwd
      const command = params.command
      const label = `stm32kernel ${command}`
      // 这一轮已经被用户停掉:别再起子进程。runEngine 要到 spawn 之后才看信号。
      if (context.abortSignal?.aborted) throw new Error(`${label} was aborted`)

      const resolved: Stm32ConfigInput = {
        ...params,
        configPath: params.configPath ? resolveToCwd(cwd, params.configPath) : undefined,
        out: params.out ? resolveToCwd(cwd, params.out) : undefined,
      }
      // 内核对读不到的配置回 exit 1 + DOC_READ 诊断,而"修复配置文档"对一个不存在的文件是错话。
      if (resolved.configPath && CONFIG_COMMANDS.includes(command) && !(await fileExists(resolved.configPath))) {
        throw new Error(`configPath not found or not a regular file: ${resolved.configPath}`)
      }

      const kernel = engineBin("stm32kernel", options)
      const dataDir = needsDataDir(command) ? requireDataDir(command, options) : ""
      const args = buildStm32ConfigArgs(resolved, dataDir, path.join(dataDir, "fw"))

      // 内核的进度("loaded pack …"、"generated N file(s)")在 stderr 上,边跑边上卡片;结果仍以 stdout 为准。
      let live = ""
      const result = assertEngineSettled(
        await runEngine(kernel, args, {
          cwd,
          signal: context.abortSignal,
          onOutput: ({ text }) => {
            live = appendTail(live, text)
            onUpdate({ content: [{ type: "text", text: live }], details: { command, exitCode: null } })
          },
        }),
        label,
      )
      if ((result.exitCode !== 0 && result.exitCode !== 1) || !result.stdout.trim()) {
        throw new Error(
          `${label} failed (exit ${result.exitCode}): ${engineErrorText(result.stderr.trim() || result.stdout.trim())}`,
        )
      }

      // schema 是字段参考文本,其余命令的协议是 JSON 对象。
      const output = command === "schema" ? undefined : parseEngineObject(result.stdout, label)
      if (result.exitCode === 1 && !Array.isArray(output?.diagnostics)) {
        throw new Error(`${label} exited 1 without diagnostic JSON: ${engineErrorText(result.stdout)}`)
      }

      // exit 1 = "有 ERROR 诊断":stdout 上的 JSON 就是修复回路,按正常结果返回。
      const notes: string[] = []
      if (result.exitCode === 1 && CONFIG_COMMANDS.includes(command) && resolved.configPath) {
        notes.push(
          "Exit code 1: the configuration has ERROR diagnostics (nothing was generated). Fix the config document at each diagnostic's path, then re-run.",
        )
      } else if (
        result.exitCode === 1 &&
        (command === "describe-mcu" || command === "list-mcus" || command === "candidates")
      ) {
        notes.push(
          "Exit code 1: read the diagnostics and correct the query parameters. MCU_UNKNOWN includes db spellings to try (e.g. STM32F405RGTx); use list-mcus to find parts or describe-mcu to find peripheral instances.",
        )
      }
      if (command === "generate" && result.exitCode === 0) {
        // 工具链文件的路径相对生成树,而 bash 跑在会话 cwd —— 没有 `cd` 的话只有 out 恰好是工作目录时才能用。
        notes.push(`Project generated at ${resolved.out}. In your shell, change to that directory, then run:
  cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=cmake/gcc-arm-none-eabi.cmake -B build
  cmake --build build`)
      }

      const stdout = await previewToolOutput(
        cwd,
        `stm32config-${command}`,
        result.stdout.trim(),
        command === "list-mcus"
          ? "narrow it with family / package / minFlashKb"
          : "re-run with a narrower query, or read the written files directly",
      )
      const text = [stdout.text, ...notes].filter(Boolean).join("\n\n") || "(no output)"
      return {
        content: [{ type: "text", text }],
        details: {
          command,
          exitCode: result.exitCode,
          ...(stdout.file ? { outputFile: stdout.file } : {}),
          ...(resolved.configPath ? { configPath: resolved.configPath } : {}),
          ...(resolved.out ? { out: resolved.out } : {}),
        },
      }
    },
  }
}
