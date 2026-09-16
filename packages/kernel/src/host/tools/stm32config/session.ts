/**
 * stm32config 工具的厨房那一半:七个子命令 → `engines/bin/stm32kernel` → 人话。
 *
 * 退出码的分类学(与 flash 那种"非零不抛"不同,与 netlist 那种"非零就抛"也不同):
 * - 0:干净。
 * - 1:**有 ERROR 诊断,是正常结果**。stdout 上的 JSON 就是修复回路(每条诊断带 JSON Pointer 与 suggestion),
 *   配置命令附一句"修完重跑";describe-mcu / candidates 查不到型号也是 exit 1(`MCU_UNKNOWN` 带候选拼法)。
 * - 其余退出码:用法 / 内部错误或崩溃,无论 stdout 有没有内容都抛。
 *
 * 器件数据和固件统一由 STM32 本地资源模块准备:来源是用户本机 CubeMX,转换结果是用户缓存,
 * 与安装包的 bin/ 目录分离。schema 不接触 CubeMX;成功生成时将可移植的资源版本记录写入工程。
 *
 * 2026-09-15 按新内核接口重写,与阁楼版的差别:cwd 每次 execute 现取;中止走 context.abortSignal;配置文档
 * 先查存在(内核对读不到的文件回 exit 1 的 DOC_READ 诊断,那不该被说成"配置有错");`schema` 不再要求
 * 数据目录;stderr 上的进度("loaded pack …")边跑边上卡片。
 */

import { copyFile, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { executionEnvSnapshot } from "../../domain/execution-env.ts"

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import { appendTail, assertEngineSettled, engineBin, type EnginePathOptions, runEngine } from "../../domain/engines.ts"
import { prepareStm32Resources } from "../../domain/stm32/resources.ts"
import { engineErrorText, parseEngineObject, previewToolOutput } from "../../domain/tool-output.ts"
import { resolveToCwd } from "../../domain/paths.ts"
import { buildStm32ConfigArgs, CONFIG_COMMANDS, needsDataDir } from "./args.ts"
import { STM32CONFIG_CONTRACT, type Stm32ConfigDetails, type Stm32ConfigInput } from "./contract.ts"

export interface Stm32ConfigToolOptions extends EnginePathOptions {
  configDir?: string
  /** 测试注入资源边界;生产环境始终走统一资源模块。 */
  prepare?: typeof prepareStm32Resources
}

export type Stm32ConfigTool = AgentHarnessTool<
  ExecutionToolContext,
  typeof STM32CONFIG_CONTRACT.parameters,
  Stm32ConfigDetails
>

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  )
}

/** 配置校验属于引擎;这里只读取资源选择所需的型号,不抢走 DOC_PARSE 诊断。 */
async function configPart(file: string): Promise<string | undefined> {
  const text = await readFile(file, "utf8")
  try {
    const document = JSON.parse(text) as { mcu?: { part?: unknown } } | null
    return typeof document?.mcu?.part === "string" ? document.mcu.part : undefined
  } catch {
    return undefined
  }
}

export function createStm32ConfigTool(options: Stm32ConfigToolOptions = {}): Stm32ConfigTool {
  return {
    name: STM32CONFIG_CONTRACT.name,
    label: STM32CONFIG_CONTRACT.label,
    description: STM32CONFIG_CONTRACT.description,
    parameters: STM32CONFIG_CONTRACT.parameters,
    execute: async (_toolCallId, params, onUpdate, toolContext, _invocation, context) => {
      const cwd = toolContext.env.cwd
      const env = executionEnvSnapshot(toolContext.env)
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

      // 内核的进度("loaded pack …"、"generated N file(s)")在 stderr 上,边跑边上卡片;结果仍以 stdout 为准。
      let live = ""
      const progress = (text: string) => {
        live = appendTail(live, text)
        onUpdate({ content: [{ type: "text", text: live }], details: { command, exitCode: null } })
      }
      // 先检查参数,不为一个缺少必填字段的请求导入整个数据库。
      buildStm32ConfigArgs(resolved, "", "")
      const kernel = engineBin("stm32kernel", options)
      const part =
        resolved.configPath && CONFIG_COMMANDS.includes(command) ? await configPart(resolved.configPath) : resolved.part
      const prepare = options.prepare ?? prepareStm32Resources
      const resourceOptions = {
        enginesDir: options.enginesDir,
        configDir: options.configDir,
        projectDir: cwd,
        env,
        signal: context.abortSignal,
        part,
        onProgress: (message: string) => progress(`${message}\n`),
      }
      let resources = needsDataDir(command) ? await prepare({ ...resourceOptions, firmware: false }) : undefined
      const execute = async (input: Stm32ConfigInput) => {
        if (context.abortSignal?.aborted) throw new Error(`${label} was aborted`)
        const operation = `stm32kernel ${input.command}`
        const args = buildStm32ConfigArgs(input, resources?.dataDir ?? "", resources?.fwDir ?? "")
        const result = assertEngineSettled(
          await runEngine(kernel, args, {
            cwd,
            env,
            signal: context.abortSignal,
            onOutput: ({ text }) => progress(text),
          }),
          operation,
        )
        if ((result.exitCode !== 0 && result.exitCode !== 1) || !result.stdout.trim()) {
          throw new Error(
            `${operation} failed (exit ${result.exitCode}): ${engineErrorText(result.stderr.trim() || result.stdout.trim())}`,
          )
        }
        // schema 是字段参考文本,其余命令的协议是 JSON 对象。
        const output = input.command === "schema" ? undefined : parseEngineObject(result.stdout, operation)
        if (result.exitCode === 1 && !Array.isArray(output?.diagnostics)) {
          throw new Error(`${operation} exited 1 without diagnostic JSON: ${engineErrorText(result.stdout)}`)
        }
        return result
      }

      // 配置修复回路只需数据库。先由引擎校验,有效后再准备固件,避免缺固件遮住 DOC_PARSE / PIN_CONFLICT。
      let result = await execute(command === "generate" ? { ...resolved, command: "validate" } : resolved)
      if (command === "generate" && result.exitCode === 0) {
        if (!part) throw new Error("stm32config generate requires mcu.part in the configuration document")
        if (context.abortSignal?.aborted) throw new Error(`${label} was aborted`)
        resources = await prepare({ ...resourceOptions, firmware: true })
        result = await execute(resolved)
      }

      // exit 1 = "有 ERROR 诊断":stdout 上的 JSON 就是修复回路,按正常结果返回。
      const notes: string[] = []
      let resourceManifest: string | undefined
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
        resourceManifest = path.join(resolved.out!, "stm32-resources.json")
        await copyFile(resources!.manifestPath, resourceManifest)
        notes.push(
          `Resource versions recorded at ${resourceManifest}. Keep this file with the configuration document to trace and compare the inputs used for generation.`,
        )
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
          ...(resourceManifest ? { resourceManifest } : {}),
        },
      }
    },
  }
}
