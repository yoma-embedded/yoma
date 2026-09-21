/**
 * 子 agent 定义的发现与合并(docs/子agent-设计方案-v0.4-20260918.md §4.3)。
 *
 * 来源与覆盖照 CC(`loadAgentsDir.ts` 的 getActiveAgentsFromList + `markdownConfigLoader.ts`):
 * 内建 < 用户 `<configDir>/agents/*.md` < 项目:从 cwd 向上到 home 为止(不含 home)逐层的 `<dir>/.yoma/agents/*.md`,
 * 外层先、内层后,同名后者覆盖前者 —— 覆盖不改位置(Map 同键 set 保留原插入序),所以项目里顶掉
 * 内建 Explore 之后,它在 agent 工具描述里还排在原来那一行。
 *
 * 解析纪律也照 CC(`parseAgentFromMarkdown`):没有 frontmatter 或没有 `name` 的 md **静默跳过**(agents 目录里
 * 常有说明文档);字段写错记一条诊断、只忽略那个字段,不拒载整个 agent。
 *
 * 快照式:会话打开时读一次(与技能、上下文文件同),会话内不变 —— agent 工具的描述因此字节稳定,
 * 不存在 CC 那 10.2% cache_creation 的问题。
 */

import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import type { ThinkingLevel } from "@earendil-works/pi-agent-core"
import { parse } from "yaml"

import { BUILTIN_AGENTS } from "./builtin.ts"
import type { AgentDiagnostic, AgentProfile, AgentSource } from "./profile.ts"

export interface LoadAgentsOptions {
  /** 会话的工作目录;从它向上逐层找 `.yoma/agents`。 */
  cwd: string
  /** 全局目录(缺省 ~/.yoma);用户级定义在 `<configDir>/agents`。测试必须注入。 */
  configDir: string
  /** 祖先链走到这里为止(不含);缺省 os.homedir()。测试必须注入,否则会走到开发机真实的 home。 */
  homeDir?: string
  /** 测试用;缺省是 BUILTIN_AGENTS。 */
  builtins?: readonly AgentProfile[]
}

export interface LoadedAgents {
  profiles: AgentProfile[]
  diagnostics: AgentDiagnostic[]
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MODEL = /^(inherit|[^/\s]+\/\S+)$/
/** CC 有、yoma 没有对应能力的键:记一条诊断告诉写的人它不生效。 */
const UNSUPPORTED_KEYS: Readonly<Record<string, string>> = {
  permissionMode: "Yoma has no permission modes",
  isolation: "worktree isolation is not implemented yet",
  memory: "agent memory directories are not supported",
  mcpServers: "Yoma has no MCP",
  requiredMcpServers: "Yoma has no MCP",
  hooks: "Yoma has no hook configuration",
  effort: 'use "thinking" instead',
  criticalSystemReminder_EXPERIMENTAL: "not supported",
  omitContextFiles: "reserved for built-in agents",
  oneShot: "reserved for built-in agents",
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * 解析一个 agent md。返回 undefined 表示这个文件不是 agent 定义(没有 frontmatter / 没有 name)或不可用
 * (frontmatter 不是合法 YAML、name 或 description 不合法)—— 后两种会记诊断。
 */
export function parseAgentMarkdown(
  text: string,
  filePath: string,
  source: Exclude<AgentSource, "built-in">,
  diagnostics: AgentDiagnostic[],
): AgentProfile | undefined {
  const stripped = text.replace(/^﻿/, "")
  const match = FRONTMATTER.exec(stripped)
  if (!match) return undefined
  let data: unknown
  try {
    data = parse(match[1]!)
  } catch (error) {
    diagnostics.push({ path: filePath, message: `frontmatter is not valid YAML: ${(error as Error).message}` })
    return undefined
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    if (data !== null && data !== undefined) diagnostics.push({ path: filePath, message: "frontmatter must be a mapping" })
    return undefined
  }
  const fields = data as Record<string, unknown>
  if (fields.name === undefined) return undefined
  const warn = (message: string) => diagnostics.push({ path: filePath, message })

  if (typeof fields.name !== "string" || !NAME.test(fields.name)) {
    warn(`name must be letters, digits, ".", "_" or "-" (got ${JSON.stringify(fields.name)}); agent skipped`)
    return undefined
  }
  if (typeof fields.description !== "string" || !fields.description.trim()) {
    warn(`description is required (it tells the main agent when to use "${fields.name}"); agent skipped`)
    return undefined
  }

  const profile: AgentProfile = {
    name: fields.name,
    description: fields.description.trim(),
    prompt: stripped.slice(match[0].length).trim(),
    source,
    filePath,
  }

  const tools = stringList(fields.tools)
  if (tools === null) warn("tools must be a list or a comma-separated string; ignored")
  else if (tools) profile.tools = tools

  const disallowed = stringList(fields.disallowedTools)
  if (disallowed === null) warn("disallowedTools must be a list or a comma-separated string; ignored")
  else if (disallowed) profile.disallowedTools = disallowed

  if (fields.model !== undefined) {
    if (typeof fields.model === "string" && MODEL.test(fields.model.trim())) profile.model = fields.model.trim()
    else warn(`model must be "inherit" or "<provider>/<modelId>" (got ${JSON.stringify(fields.model)}); ignored`)
  }
  if (fields.thinking !== undefined) {
    if (typeof fields.thinking === "string" && THINKING_LEVELS.has(fields.thinking))
      profile.thinkingLevel = fields.thinking as ThinkingLevel
    else warn(`thinking must be one of ${[...THINKING_LEVELS].join(", ")} (got ${JSON.stringify(fields.thinking)}); ignored`)
  }
  if (fields.maxTurns !== undefined) {
    if (typeof fields.maxTurns === "number" && Number.isInteger(fields.maxTurns) && fields.maxTurns >= 1)
      profile.maxTurns = fields.maxTurns
    else warn(`maxTurns must be a positive integer (got ${JSON.stringify(fields.maxTurns)}); ignored`)
  }
  if (fields.background !== undefined) {
    if (typeof fields.background === "boolean") profile.background = fields.background
    else warn(`background must be true or false (got ${JSON.stringify(fields.background)}); ignored`)
  }
  const skills = stringList(fields.skills)
  if (skills === null) warn("skills must be a list or a comma-separated string; ignored")
  else if (skills) profile.skills = skills
  if (fields.initialPrompt !== undefined) {
    if (typeof fields.initialPrompt === "string") profile.initialPrompt = fields.initialPrompt
    else warn("initialPrompt must be a string; ignored")
  }
  if (fields.color !== undefined) {
    if (typeof fields.color === "string") profile.color = fields.color
    else warn("color must be a string; ignored")
  }
  for (const [key, why] of Object.entries(UNSUPPORTED_KEYS)) {
    if (key in fields) warn(`${key} is not supported (${why}); ignored`)
  }
  return profile
}

/** undefined = 没写;null = 写了但形状不对;数组 = 有效(逗号分隔的字符串也认,CC 同款)。 */
function stringList(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined
  const items =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value) && value.every((item) => typeof item === "string")
        ? (value as string[])
        : null
  if (!items) return null
  const cleaned = items.map((item) => item.trim()).filter(Boolean)
  return cleaned.length ? cleaned : undefined
}

/** 路径比较用的键:Windows 上不分大小写。 */
function pathKey(dir: string): string {
  const resolved = path.resolve(dir)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/**
 * 用户目录 + 从 cwd 向上逐层的 `.yoma/agents`(外层先);同一个物理目录只出现一次。
 *
 * 向上走到 home 为止、不含 home(CC `markdownConfigLoader.ts` 同款):home 那一份就是用户级(configDir 缺省
 * 是 ~/.yoma),而且不停在 home 的话,测试里注入的 configDir 挡不住开发机真实的 ~/.yoma/agents 从祖先链上
 * 混进来。cwd 不在 home 下面(比如 D:\MyCode)时一直走到文件系统根。
 */
export function agentDirectories(options: { cwd: string; configDir: string; homeDir?: string }): Array<{
  dir: string
  source: Exclude<AgentSource, "built-in">
}> {
  const out: Array<{ dir: string; source: Exclude<AgentSource, "built-in"> }> = [
    { dir: path.join(options.configDir, "agents"), source: "user" },
  ]
  const home = pathKey(options.homeDir ?? homedir())
  const ancestors: string[] = []
  for (let dir = path.resolve(options.cwd); ; ) {
    if (pathKey(dir) === home) break
    ancestors.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const dir of ancestors.reverse()) out.push({ dir: path.join(dir, ".yoma", "agents"), source: "project" })
  // configDir 缺省就是 ~/.yoma:home 在 cwd 的祖先链上时,"~/.yoma/agents" 会同时是用户级和项目级。只认一次。
  const seen = new Set<string>()
  return out.filter(({ dir }) => {
    const key = pathKey(dir)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort()
      .map((name) => path.join(dir, name))
  } catch {
    // 目录不存在是常态(绝大多数项目没有 .yoma/agents)。
    return []
  }
}

/** 内建 + 用户 + 项目,按名合并;覆盖不改位置。 */
export async function loadAgentProfiles(options: LoadAgentsOptions): Promise<LoadedAgents> {
  const diagnostics: AgentDiagnostic[] = []
  const byName = new Map<string, AgentProfile>()
  for (const profile of options.builtins ?? BUILTIN_AGENTS) byName.set(profile.name, profile)
  for (const { dir, source } of agentDirectories(options)) {
    for (const file of await markdownFiles(dir)) {
      let text: string
      try {
        text = await readFile(file, "utf8")
      } catch (error) {
        diagnostics.push({ path: file, message: `cannot read: ${(error as Error).message}` })
        continue
      }
      const profile = parseAgentMarkdown(text, file, source, diagnostics)
      if (profile) byName.set(profile.name, profile)
    }
  }
  return { profiles: [...byName.values()], diagnostics }
}
