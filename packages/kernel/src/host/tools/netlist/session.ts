/**
 * netlist 工具的厨房那一半:两种模式 → 两个引擎 → 人话。
 *
 * - 不带 part:`controller_map <netlist> [--main-controller REF]`,stdout 是原始逐 pin 连接图(JSON,几十 KB),
 *   stderr 是探测说明("Detected main controller (auto): U2 …"、低信心警告)。图只为认出板子和主控,所以比引擎
 *   通用上限更紧地截到 10 000 字符:它是一次会话里最肥的工具载荷,而精炼过的 board IR 只差一个 part 参数。
 * - 带 part:`board_ir <netlist> --stm32kernel … --data-dir … --part P --out-dir D --stem S`,三个 JSON 落盘
 *   (`<stem>_board_ir.json` 全图、`<stem>_stm32_map.json` 外设建议、`<stem>_cfg_seed.json` 起步配置);后两个
 *   截断后内联,全图只报路径(模型要看再 read)。
 *
 * 两个引擎对这两种模式而言非零退出都是真失败(不像 stm32kernel 的 exit 1 与 flash 的烧录器),抛错带上 stderr。
 * board_ir 和 stm32config 向同一个资源模块申请本机 CubeMX 的器件缓存,不读取安装目录里的数据。
 *
 * 2026-09-15 按新内核接口重写:cwd 每次 execute 现取;中止走 context.abortSignal(并在 spawn 前先看一眼);
 * 文件访问直接 node:fs;探测行边跑边上卡片;主控 ref 与信心从 controller_map 的 JSON 里读出来进 details。
 */

import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { executionEnvSnapshot } from "../../domain/execution-env.ts"

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core"

import {
  appendTail,
  assertEngineSettled,
  capEngineOutput,
  engineBin,
  type EnginePathOptions,
  runEngine,
} from "../../domain/engines.ts"
import { prepareStm32Resources } from "../../domain/stm32/resources.ts"
import { createToolOutputDir, engineErrorText, parseEngineObject, previewToolOutput } from "../../domain/tool-output.ts"
import { resolveToCwd } from "../../domain/paths.ts"
import { NETLIST_CONTRACT, type NetlistDetails } from "./contract.ts"

export interface NetlistToolOptions extends EnginePathOptions {
  configDir?: string
  /** 测试注入资源边界;生产环境始终走统一资源模块。 */
  prepare?: typeof prepareStm32Resources
}

export type NetlistTool = AgentHarnessTool<ExecutionToolContext, typeof NETLIST_CONTRACT.parameters, NetlistDetails>

/** 原始连接图的内联上限(比引擎通用的 24 000 紧)。 */
export const RAW_MAP_MAX_CHARS = 10_000

/**
 * 输出文件名的词干:去扩展名,不安全字符换下划线。
 * 按 Unicode 字母/数字保留:纯 ASCII 白名单会把「咖啡机.NET」整个吞成 "_",两张中文名网表就会共用同一组
 * 缓存文件互相覆盖。
 */
export function sanitizeStem(name: string): string {
  const stem = path.basename(name).replace(/\.[^.]*$/, "")
  return stem.replace(/[^\p{L}\p{N}_.-]+/gu, "_") || "board"
}

/** controller_map 的 JSON 里读主控 ref 与信心;读不出来就不填(输出被截断前先解析整份 stdout)。 */
export function detectedController(stdout: string): { controller?: string; lowConfidence?: boolean } {
  try {
    const parsed = JSON.parse(stdout) as { controller?: { ref?: unknown }; low_confidence?: unknown }
    const ref = parsed?.controller?.ref
    return {
      ...(typeof ref === "string" && ref ? { controller: ref } : {}),
      ...(typeof parsed?.low_confidence === "boolean" ? { lowConfidence: parsed.low_confidence } : {}),
    }
  } catch {
    return {}
  }
}

async function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  )
}

export function createNetlistTool(options: NetlistToolOptions = {}): NetlistTool {
  return {
    name: NETLIST_CONTRACT.name,
    label: NETLIST_CONTRACT.label,
    description: NETLIST_CONTRACT.description,
    parameters: NETLIST_CONTRACT.parameters,
    execute: async (_toolCallId, params, onUpdate, toolContext, _invocation, context) => {
      const cwd = toolContext.env.cwd
      const env = executionEnvSnapshot(toolContext.env)
      const mode: NetlistDetails["mode"] = params.part ? "board_ir" : "map"
      const engineLabel = mode === "map" ? "controller_map" : "board_ir"
      if (context.abortSignal?.aborted) throw new Error(`${engineLabel} was aborted`)

      const netlist = resolveToCwd(cwd, params.netlistPath)
      if (!(await fileExists(netlist))) throw new Error(`netlist file not found or not a regular file: ${netlist}`)

      // 两个分支跑的是两个不同的引擎,善后逐字一样;非零退出对这两个引擎都是真失败。
      const runOrThrow = async (bin: string, args: string[], label: string, partial: NetlistDetails) => {
        let live = ""
        const result = assertEngineSettled(
          await runEngine(bin, args, {
            cwd,
            env,
            signal: context.abortSignal,
            onOutput: ({ text }) => {
              live = appendTail(live, text)
              onUpdate({ content: [{ type: "text", text: live }], details: partial })
            },
          }),
          label,
        )
        if (result.exitCode !== 0) {
          throw new Error(
            `${label} failed (exit ${result.exitCode}): ${engineErrorText(result.stderr.trim() || result.stdout.trim())}${label === "board_ir" ? "\nCheck part with stm32config describe-mcu and verify mainController; omit part for a raw map." : "\nUse an Altium Smart PDF or an exported Altium/OrCAD/KiCad netlist."}`,
          )
        }
        return result
      }

      // 不带 part:controller_map 输出原始连接图,stderr 上是探测说明。
      if (!params.part) {
        const bin = engineBin("controller_map", options)
        const args = [netlist]
        if (params.mainController) args.push("--main-controller", params.mainController)
        const result = await runOrThrow(bin, args, "controller_map", { mode, netlist })
        const notes = capEngineOutput(result.stderr.trim(), "check the controller and part before configuring", 8_000)
        parseEngineObject(result.stdout, "controller_map")
        const detected = detectedController(result.stdout)
        const map = await previewToolOutput(
          cwd,
          "netlist-map",
          result.stdout.trim(),
          "re-run with `part` set to get the condensed board IR instead of the raw pin map",
          RAW_MAP_MAX_CHARS,
        )
        const text = [notes && `[detection]\n${notes}`, map.text].filter(Boolean).join("\n\n")
        return {
          content: [{ type: "text", text: text || "(no output)" }],
          details: { mode, netlist, ...detected, ...(map.file ? { outputFile: map.file } : {}) },
        }
      }

      // 带 part:board_ir 联动 stm32kernel 的数据,产出三个 JSON 文件。
      if (!/^STM32/i.test(params.part)) {
        throw new Error(
          "netlist board_ir supports STM32 parts only; omit part for the raw connection map of other MCUs.",
        )
      }
      const bin = engineBin("board_ir", options)
      const kernel = engineBin("stm32kernel", options)
      const resources = await (options.prepare ?? prepareStm32Resources)({
        enginesDir: options.enginesDir,
        configDir: options.configDir,
        projectDir: cwd,
        env,
        signal: context.abortSignal,
        part: params.part,
        onProgress: (message) =>
          onUpdate({
            content: [{ type: "text", text: message }],
            details: { mode, netlist, part: params.part },
          }),
      })
      if (context.abortSignal?.aborted) throw new Error(`${engineLabel} was aborted`)

      const stem = sanitizeStem(netlist)
      // 每次调用保留自己的证据:同名网表、不同 part、并发调用都不能互相覆盖。
      let outDir: string
      if (params.outDir) {
        const root = resolveToCwd(cwd, params.outDir)
        await mkdir(root, { recursive: true })
        outDir = await mkdtemp(path.join(root, `${stem}-`))
      } else {
        outDir = await createToolOutputDir(cwd, "netlist")
      }
      const files = {
        boardIr: path.join(outDir, `${stem}_board_ir.json`),
        stm32Map: path.join(outDir, `${stem}_stm32_map.json`),
        cfgSeed: path.join(outDir, `${stem}_cfg_seed.json`),
      }

      const args = [
        netlist,
        "--stm32kernel",
        kernel,
        "--data-dir",
        resources.dataDir,
        "--part",
        params.part,
        "--out-dir",
        outDir,
        "--stem",
        stem,
      ]
      if (params.mainController) args.push("--main-controller", params.mainController)

      const result = await runOrThrow(bin, args, "board_ir", { mode, netlist, part: params.part, files })

      const readProduct = async (file: string) => {
        let text: string
        try {
          text = (await readFile(file, "utf8")).trim()
        } catch {
          throw new Error(`board_ir exited 0 but a required output file is missing or unreadable: ${file}`)
        }
        parseEngineObject(text, `board_ir file ${file}`)
        return text
      }
      await readProduct(files.boardIr)
      const stm32Map = await readProduct(files.stm32Map)
      const cfgSeed = await readProduct(files.cfgSeed)

      const notes = capEngineOutput(result.stderr.trim(), "check the controller and part before configuring", 8_000)
      // 两个文件都在盘上、路径就在上面:截断内联只让模型多一次 read,整份内联则没有上限。
      const text = [
        notes && `[detection]\n${notes}`,
        `Board IR files written to ${outDir}:`,
        `- ${files.boardIr} (full component/net graph; read it on demand)`,
        `- ${files.stm32Map}`,
        `- ${files.cfgSeed}`,
        stm32Map &&
          `[stm32_map] peripheral suggestions with evidence/confidence:\n${capEngineOutput(stm32Map, `read ${files.stm32Map} for the rest`)}`,
        cfgSeed &&
          `[cfg_seed] starter stm32config document (extend it, then validate):\n${capEngineOutput(cfgSeed, `read ${files.cfgSeed} for the rest`)}`,
      ]
        .filter(Boolean)
        .join("\n\n")

      return {
        content: [{ type: "text", text }],
        details: { mode, netlist, part: params.part, files },
      }
    },
  }
}
