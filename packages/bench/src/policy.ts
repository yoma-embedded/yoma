/**
 * 每任务权限策略。
 *
 * 内核的权限门有三层裁决(policy → rules → 问人),这个文件产出第一层。
 * 无人值守时"问人"不是弹窗而是**挂起任务并通知**(runner 接 escalate),
 * 所以这里每 escalate 一次都是真实成本 —— 规则要写得让常规调试动作全程不打扰人,
 * 又让"可能把板子搞坏/把代码库搞乱"的动作一个都溜不掉。
 *
 * ## 三档
 *
 * - `readonly`   只读:任何写文件/动硬件的动作都拒。用来复现和取证。
 * - `supervised` 有人看着:读类放行,写类与硬件类升级给人。默认档。
 * - `unattended` 无人值守:常规调试全程放行,危险动作升级。
 *
 * ## unattended 放行的边界(逐条都有理由)
 *
 * - `flash download/reset/info` 放行,但 **chip 必须与 job 声明的一致** ——
 *   烧错芯片就是烧别人的板子;`erase` 永远升级(擦 option bytes 能把板子锁死)。
 * - `gdb` 的读类动作放行;`eval` 带 `write:true` 升级 —— 那是往目标写内存/寄存器。
 * - `edit/write` 限制在工作树内,且不许碰 protectedPaths;超过 maxDiffLines 的
 *   单次写入升级(模型"重写整个文件"是最常见的失控形态)。
 * - `bash` 只放行白名单前缀,其余升级。**白名单匹配是逐 token 的**,不是
 *   `startsWith` —— `make` 不能顺带放行 `make-me-a-sandwich; rm -rf /`;
 *   而且命令里出现 shell 串联符(`;` `&&` `|` 反引号 `$(`)一律升级,
 *   否则白名单前缀后面可以挂任何东西。
 *
 * 判不出来的一律 escalate,绝不 allow —— 这是本文件唯一的默认值方向。
 */

import path from "node:path"

import type { PolicyDecision, PolicyProvider } from "@yoma-desktop/kernel/host"

import type { Job, PolicyName } from "./job.ts"

/** 常规嵌入式调试用得到、且不改变世界的命令。 */
const DEFAULT_ALLOWED_COMMANDS = [
  "make",
  "cmake",
  "ninja",
  "cargo",
  "west",
  "idf.py",
  "arm-none-eabi-size",
  "arm-none-eabi-objdump",
  "arm-none-eabi-nm",
  "arm-none-eabi-readelf",
  "arm-none-eabi-addr2line",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "find",
  "grep",
  "rg",
  "sed",
  "awk",
  "diff",
  "git",
  "python",
  "python3",
  "pytest",
  "node",
  "bun",
  "pwd",
  "echo",
  "true",
]

/** git 里会改变世界的子命令 —— 提交由 runner 负责,agent 不许自己 push/reset。 */
const GIT_FORBIDDEN_SUBCOMMANDS = ["push", "reset", "clean", "rebase", "merge", "checkout", "switch", "restore", "tag"]

/** shell 串联/替换符号:出现即升级,否则白名单前缀等于虚设。 */
const SHELL_CHAINING = /[;&|`]|\$\(|\n/

const READONLY_TOOLS = new Set(["read", "grep", "netlist", "datasheet", "log"])

/** gdb 的只读动作。start/break/exec/status 会控制目标运行,但不写存储;stop 是清理。 */
const GDB_READONLY_ACTIONS = new Set(["status", "stop"])

export interface PolicyContext {
  job: Job
  /** 工作树根目录,edit/write 的路径必须落在里面。 */
  workspace: string
}

export interface PolicyEscalation {
  tool: string
  title: string
  rule: string
}

/**
 * 决策解释:action 之外附一条人能读的原因,进决策日志和报告。
 * 写成交叉类型而不是 `interface extends` —— PolicyDecision 是联合类型,
 * interface 继承不会分发,结果是每个分支的判别字段全丢。
 */
export type ExplainedDecision = PolicyDecision & { why: string }

export function createPolicy(context: PolicyContext): PolicyProvider {
  const decide = createPolicyDecider(context)
  return ({ tool, input }) => decide(tool, input)
}

/** 纯函数形态,便于单测 —— 不碰文件系统,不碰内核。 */
export function createPolicyDecider(
  context: PolicyContext,
): (tool: string, input: Record<string, unknown>) => ExplainedDecision {
  const { job, workspace } = context
  const level: PolicyName = job.policy
  // 白名单按 basename 存:人写 job 时会自然地写 `./check.sh` 或 `tools/build.sh`,
  // 而匹配端拿到的是 argv[0] 的 basename。不归一化的话白名单看着写了却不生效
  // (实测:job 里写 `./check.sh`,agent 跑 `./check.sh` 照样被升级)。
  const allowedCommands = new Set(
    [...DEFAULT_ALLOWED_COMMANDS, ...(job.allowCommands ?? [])].map((entry) => path.basename(entry)),
  )
  const protectedPaths = job.protectedPaths ?? []
  const maxDiffLines = job.maxDiffLines ?? 400

  const allow = (rule: string, why: string): ExplainedDecision => ({ action: "allow", rule, why })
  const deny = (rule: string, why: string): ExplainedDecision => ({ action: "deny", rule, reason: why, why })
  const escalate = (rule: string, why: string): ExplainedDecision => ({ action: "escalate", rule, why })

  return (tool, input) => {
    const str = (key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "")

    // 只读工具:三档全放行。log 的 command 模式能起任意进程,单独判。
    if (READONLY_TOOLS.has(tool)) {
      if (tool === "log") {
        const command = str("command")
        if (command) return commandVerdict(command, "log.command")
      }
      return allow(`readonly:${tool}`, "只读工具")
    }

    if (level === "readonly") return deny(`readonly-policy:${tool}`, "本任务是只读档,不允许改动任何东西")

    switch (tool) {
      case "edit":
      case "write": {
        const target = str("path") || str("file_path")
        const verdict = pathVerdict(target)
        if (verdict) return verdict
        const lines = writeSizeOf(tool, input)
        if (lines > maxDiffLines) {
          return escalate("write.too-big", `单次改动 ${lines} 行,超过上限 ${maxDiffLines} 行`)
        }
        if (level === "supervised") return escalate(`supervised:${tool}`, "有人值守档:改文件要人点头")
        return allow(`write.in-workspace`, `改动落在工作树内,${lines} 行`)
      }

      case "bash":
        return commandVerdict(str("command"), "bash")

      case "flash": {
        const action = str("action")
        if (action === "erase") return escalate("flash.erase", "擦片会清掉 option bytes,永远要人确认")
        if (action === "list" || action === "info") return allow("flash.readonly", `flash ${action} 只读`)
        const chip = str("chip")
        if (job.bench.chip && chip && chip !== job.bench.chip) {
          return deny("flash.wrong-chip", `job 声明的芯片是 ${job.bench.chip},这次要烧 ${chip} —— 可能是别人的板子`)
        }
        if (level === "supervised") return escalate("supervised:flash", "有人值守档:烧录要人点头")
        if (!chip && !job.bench.chip) return escalate("flash.no-chip", "没有芯片名,无法确认烧的是本任务的板子")
        return allow(`flash.${action || "download"}`, `烧录到 job 声明的 ${job.bench.chip ?? chip}`)
      }

      case "gdb": {
        const action = str("action")
        if (GDB_READONLY_ACTIONS.has(action)) return allow(`gdb.${action}`, `gdb ${action} 不改目标`)
        if (action === "eval" && input.write === true) {
          return escalate("gdb.eval-write", "gdb eval 带 write:true 会往目标写内存/寄存器")
        }
        if (level === "supervised") return escalate("supervised:gdb", "有人值守档:动目标运行状态要人点头")
        return allow(`gdb.${action || "control"}`, "调试控制,不写存储")
      }

      case "stm32config": {
        const command = str("command")
        if (command === "generate") {
          // generate 会往工作树写一整个驱动工程 —— 按写文件对待。
          if (level === "supervised") return escalate("supervised:stm32config", "有人值守档:生成工程要人点头")
          return allow("stm32config.generate", "生成驱动工程")
        }
        return allow(`stm32config.${command || "query"}`, "配置查询/校验,不写文件")
      }

      default:
        // 内核新增了工具而策略还没跟上 —— 宁可挂起任务问人,也不放行未知能力。
        return escalate(`unknown-tool:${tool}`, `策略里没有 ${tool} 的规则`)
    }
  }

  function pathVerdict(target: string): ExplainedDecision | undefined {
    if (!target) return escalate("write.no-path", "没给路径,判不出改的是哪个文件")
    const absolute = path.isAbsolute(target) ? target : path.resolve(workspace, target)
    const relative = path.relative(workspace, absolute)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return deny("write.outside-workspace", `${target} 在工作树之外`)
    }
    for (const pattern of protectedPaths) {
      if (matchProtected(pattern, relative)) return escalate("write.protected", `${relative} 命中保护路径 ${pattern}`)
    }
    return undefined
  }

  function commandVerdict(command: string, ruleBase: string): ExplainedDecision {
    if (!command) return escalate(`${ruleBase}.empty`, "命令为空,判不出要做什么")
    if (SHELL_CHAINING.test(command)) {
      return escalate(`${ruleBase}.chained`, "命令里有 shell 串联/替换符号,白名单管不住后半段")
    }
    const argv = command.trim().split(/\s+/)
    const head = path.basename(argv[0] ?? "")
    if (!allowedCommands.has(head)) return escalate(`${ruleBase}.not-allowed`, `${head} 不在白名单里`)
    if (head === "git") {
      const sub = argv[1] ?? ""
      if (GIT_FORBIDDEN_SUBCOMMANDS.includes(sub)) {
        return escalate(`${ruleBase}.git-${sub}`, `git ${sub} 会改变分支/工作树状态,提交由 runner 负责`)
      }
    }
    if (level === "supervised" && !isReadOnlyCommand(head)) {
      return escalate(`supervised:${ruleBase}`, "有人值守档:非只读命令要人点头")
    }
    return allow(`${ruleBase}.allowed`, `${head} 在白名单里`)
  }
}

const READ_ONLY_COMMANDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "find",
  "grep",
  "rg",
  "diff",
  "pwd",
  "echo",
  "true",
  "arm-none-eabi-size",
  "arm-none-eabi-objdump",
  "arm-none-eabi-nm",
  "arm-none-eabi-readelf",
  "arm-none-eabi-addr2line",
])

function isReadOnlyCommand(head: string): boolean {
  return READ_ONLY_COMMANDS.has(head)
}

/** 写入规模:write 数新内容行数,edit 数所有替换段的行数之和。用来挡住"重写整个文件"。 */
function writeSizeOf(tool: string, input: Record<string, unknown>): number {
  if (tool === "write") {
    const content = typeof input.content === "string" ? input.content : ""
    return content.split("\n").length
  }
  const edits = Array.isArray(input.edits) ? input.edits : []
  let lines = 0
  for (const edit of edits) {
    if (typeof edit !== "object" || edit === null) continue
    const record = edit as Record<string, unknown>
    for (const key of ["oldText", "newText"]) {
      const text = record[key]
      if (typeof text === "string") lines += text.split("\n").length
    }
  }
  return lines
}

/**
 * 极简 glob:`*` 不跨 `/`,`**` 跨,`**` 后接 `/` 表示"零个或多个目录层"。
 * 够表达 `bootloader/**`、`*.ld`、`**` + `/secret.h` 三种写法。
 *
 * 逐字符扫描而不是链式 replace —— replace 版本会让先替换出来的正则元字符被后一条
 * 规则再吃一遍(实测 `bootloader/**` 直接失配)。
 */
export function matchGlob(pattern: string, target: string): boolean {
  let source = "^"
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]!
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 2
        while (pattern[index] === "*") index += 1
        if (pattern[index] === "/") {
          source += "(?:.*/)?"
          index += 1
        } else {
          source += ".*"
        }
      } else {
        source += "[^/]*"
        index += 1
      }
    } else if (char === "?") {
      source += "[^/]"
      index += 1
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
      index += 1
    }
  }
  return new RegExp(`${source}$`).test(target)
}

/**
 * 保护路径匹配。在 glob 之外多认一种写法:不带通配的 `bootloader` 视作整个目录 ——
 * 人写保护清单时几乎不会记得补 `/**`,而漏保护是不可接受的失败方向。
 */
export function matchProtected(pattern: string, target: string): boolean {
  if (matchGlob(pattern, target)) return true
  if (pattern.includes("*")) return false
  const dir = pattern.endsWith("/") ? pattern : `${pattern}/`
  return target.startsWith(dir)
}
