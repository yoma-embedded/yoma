import { parseArgs } from "node:util"
import type { ThinkingLevel } from "@yoma/agent"

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

export function thinkingLevel(value: string): ThinkingLevel {
  if (!THINKING_LEVELS.includes(value as ThinkingLevel)) {
    throw new Error(`未知思考档位 ${value}；可选：${THINKING_LEVELS.join(", ")}`)
  }
  return value as ThinkingLevel
}

export function modelIdentity(value: string): { provider: string; modelId: string } {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) throw new Error("模型格式：provider/model-id")
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
}

export function parseCliArgs(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      print: { type: "boolean", short: "p" },
      continue: { type: "boolean", short: "c" },
      session: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
      "config-dir": { type: "string" },
      "sessions-dir": { type: "string" },
    },
  })
  if (values.continue && values.session) throw new Error("--continue 与 --session 不能同时使用")
  if (values.model) modelIdentity(values.model)
  return {
    help: values.help ?? false,
    print: values.print ?? false,
    prompt: positionals.join(" "),
    cwd: values.cwd,
    model: values.model,
    thinking: values.thinking === undefined ? undefined : thinkingLevel(values.thinking),
    resume: values.continue ? "latest" : values.session,
    configDir: values["config-dir"],
    sessionsRoot: values["sessions-dir"],
  }
}

export const CLI_HELP = `Yoma CLI — 当前 Harness 的独立终端入口

用法：npm run cli [选项] [提示词]
  --cwd <目录>              工程目录，默认当前目录
  -p, --print               执行一次后退出；非终端 stdin 也作为提示词
  -c, --continue            恢复该工程最近修改的 CLI 会话
  --session <ID或前缀>      恢复该工程的指定会话
  --model <provider/id>     指定模型，优先于已保存的模型和环境变量
  --thinking <档位>         off/minimal/low/medium/high/xhigh/max
  --config-dir <目录>       凭据与上下文目录，默认 ~/.yoma
  --sessions-dir <目录>     会话目录，默认 <config-dir>/cli/sessions
  -h, --help                显示帮助，不读取凭据

交互命令：
  /help                     显示命令
  /status                   当前工程、模型、档位、会话 ID 和文件
  /models                   列出已配置的模型
  /model <provider/id>       切换模型，并重新钳制思考档位
  /thinking <档位>          切换思考档位
  /history                  显示当前分支对话正文（不含工具全文）
  /compact [说明]           手动压缩
  /retry                    手动重试上一条失败的助手回合
  /abort                    停止本轮，不退出
  /quit                     停止本轮、保存并退出

Ctrl+C：忙时停止本轮，空闲时退出。Ctrl+D：停止并退出。
只装配 read/bash/edit/write；不加载硬件工具，不自动重试或压缩。
默认新会话思考档位 max，按模型支持范围钳制；恢复时保留原档位。
恢复只恢复已保存的历史，不会自动重跑中断时的工具。
`
