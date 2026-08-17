/**
 * 数据手册服务器地址:没有内置默认。
 *
 * 公开仓库不能把团队机器写进每个人的安装包。没配 YOMA_DATASHEET_SERVER 时,
 * datasheet 工具自己报告查不了,不会去猜芯片手册。
 *
 * 配置和凭据/技能同一个目录:~/.yoma/.env(可用 YOMA_ENV_FILE 改)。
 * 内核的 datasheet 工具只读 process.env,看不见这个文件,所以内核进程入口调
 * ensureDatasheetServerEnv(),把文件里的值(若有)喂进 process.env。
 */
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** 与 kernel `yomaConfigDir()` 同一个目录。 */
function configHome(): string {
  return path.join(os.homedir(), ".yoma")
}

function envFiles(): string[] {
  const explicit = process.env.YOMA_ENV_FILE?.trim()
  if (explicit) return [explicit]
  return [path.join(configHome(), ".env")]
}

function fromEnvFile(name: string): string | undefined {
  for (const file of envFiles()) {
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1 || trimmed.slice(0, eq).trim() !== name) continue
      let val = trimmed.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (val) return val
    }
  }
  return undefined
}

/** 内核进程入口调用:把 ~/.yoma/.env 里的地址喂进 process.env。没有内置主机。 */
export function ensureDatasheetServerEnv(): void {
  if (process.env.YOMA_DATASHEET_SERVER?.trim()) return
  const fromFile = fromEnvFile("YOMA_DATASHEET_SERVER")
  if (fromFile) process.env.YOMA_DATASHEET_SERVER = fromFile
}
