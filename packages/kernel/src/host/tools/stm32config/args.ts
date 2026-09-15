/**
 * stm32kernel 的 argv 构造:纯函数,与 `stm32kernel --help` 逐字对应。传入的路径必须已经解析成绝对路径。
 */

import type { Stm32ConfigCommand, Stm32ConfigInput } from "./contract.ts"

/** 需要 config 文档的命令:文件先存在,exit 1 时给模型附上"修复后重跑"的指引。 */
export const CONFIG_COMMANDS: readonly Stm32ConfigCommand[] = ["candidates", "solve-clock", "validate", "generate"]

/** 除 schema 外的命令都要器件数据目录。 */
export function needsDataDir(command: Stm32ConfigCommand): boolean {
  return command !== "schema"
}

export function buildStm32ConfigArgs(params: Stm32ConfigInput, dataDir: string, fwDir: string): string[] {
  const need = (field: "part" | "configPath" | "out" | "peripheral", flag: string) => {
    const value = params[field]
    if (!value) throw new Error(`stm32config ${params.command} requires ${field} (${flag})`)
    return value
  }
  switch (params.command) {
    case "schema":
      return ["schema"]
    case "list-mcus": {
      if (
        params.minFlashKb !== undefined &&
        (!Number.isInteger(params.minFlashKb) || params.minFlashKb < 0 || params.minFlashKb > 0xffffffff)
      ) {
        throw new Error("stm32config list-mcus minFlashKb must be an integer between 0 and 4294967295")
      }
      const args = ["list-mcus", "--data-dir", dataDir, "--pretty"]
      if (params.family) args.push("--family", params.family)
      if (params.package) args.push("--package", params.package)
      if (params.minFlashKb !== undefined) args.push("--min-flash-kb", String(params.minFlashKb))
      return args
    }
    case "describe-mcu":
      return ["describe-mcu", need("part", "<PART>"), "--data-dir", dataDir, "--pretty"]
    case "candidates": {
      if (!params.configPath && !params.part) {
        throw new Error("stm32config candidates requires configPath or part")
      }
      const args = ["candidates"]
      if (params.configPath) args.push("--config", params.configPath)
      else args.push("--part", need("part", "--part"))
      args.push("--peripheral", need("peripheral", "--peripheral"), "--data-dir", dataDir, "--pretty")
      if (params.signal) args.push("--signal", params.signal)
      return args
    }
    case "solve-clock":
      return ["solve-clock", "--config", need("configPath", "--config"), "--data-dir", dataDir, "--pretty"]
    case "validate":
      return ["validate", "--config", need("configPath", "--config"), "--data-dir", dataDir, "--pretty"]
    case "generate":
      return [
        "generate",
        "--config",
        need("configPath", "--config"),
        "--out",
        need("out", "--out"),
        "--fw-dir",
        fwDir,
        "--data-dir",
        dataDir,
        "--pretty",
      ]
  }
}
