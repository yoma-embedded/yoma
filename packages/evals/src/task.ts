/**
 * task spec:一个目录一道题。
 *
 * 校验是手写的而不是 zod —— 与 bench 的 `parseJob` 同一个理由:evals 直接跑源码不打包,
 * 少一个依赖少一处 install graph 的风险;而且这里要的不只是"类型对",是**把出题人能犯的
 * 错在开跑前说清楚**。一道配错的题跑完 k 遍才报错是这套系统里最贵的一种错误
 * (每一遍都是真实的模型花费),所以宁可啰嗦。
 *
 * 三条硬规矩,都有各自的血:
 *
 * 1. **`id` 必须等于目录名**。results.jsonl、trials/<task>/ 与报告全按 id 索引;
 *    两者不一致时 `--filter` 按目录名找不到题、而产物按 id 落盘,人会以为题没跑。
 * 2. **`reference` 必填**。没有参考解的题证明不了"它可解",0% 通过时分不清是 agent 笨
 *    还是题坏了(README 出题纪律第 2 条)。
 * 3. **`env.kind !== "none"` 直接报错**。v1 只有临时目录这一种环境;预留字段静默降级到
 *    "在临时目录里跑一道需要板子的题"会得到一张看起来正常、其实毫无意义的报告。
 */

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import type { FauxScript } from "@yoma-desktop/bench"

import { validateGraderSpec } from "./graders/index.ts"
import type { GraderSpec } from "./graders/types.ts"
import { isObject, str, strList } from "./graders/types.ts"

/** 能力门控。**只有 `engines` 在 v1 能被满足**,其余出现即整题 skip(见 run.ts)。 */
export const REQUIRE_KINDS = ["engines", "qemu", "board", "datasheet-server"] as const
export type RequireKind = (typeof REQUIRE_KINDS)[number]

export const ENV_KINDS = ["none", "qemu", "board", "mailbox"] as const
export type EnvKind = (typeof ENV_KINDS)[number]

export interface TaskSetupFile {
  /** 相对**仓库根**。夹具是仓里的真文件(引擎的测试 fixture 等),不复制一份进题目目录。 */
  from: string
  /** 相对**工作目录**。保留扩展名 —— 解析器认它。 */
  to: string
}

export interface TaskSetup {
  files: TaskSetupFile[]
}

export interface TaskReference {
  answer: unknown
  /** 出处。"我记得是 U3"不算出处,"check.py 直跑核实"才算。 */
  note?: string
}

export interface TaskFaux {
  good?: FauxScript
  bad?: FauxScript
}

export interface Task {
  id: string
  title: string
  tags: string[]
  requires: RequireKind[]
  env: { kind: EnvKind }
  setup: TaskSetup
  prompt: string
  reference: TaskReference
  graders: GraderSpec[]
  faux?: TaskFaux
  /** 到点 abort,trial 记 error。默认 10 分钟。 */
  timeoutMs?: number
  /** 题目目录(绝对)。 */
  dir: string
  /** task.json 绝对路径。 */
  file: string
}

export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000

export class TaskSpecError extends Error {
  constructor(
    readonly file: string,
    readonly issues: string[],
  ) {
    super(`${file} 有 ${issues.length} 处问题:\n  - ${issues.join("\n  - ")}`)
    this.name = "TaskSpecError"
  }
}

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/

/** 相对、不逃逸、不是绝对路径。夹具路径是出题人手写的,写错要当场看见。 */
function checkRelative(value: string, fieldPath: string, issues: string[]): void {
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    issues.push(`${fieldPath} "${value}" 不能是绝对路径 —— 题目要在别人的机器上也能跑`)
    return
  }
  const normalized = path.normalize(value)
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    issues.push(`${fieldPath} "${value}" 逃出了基准目录`)
  }
}

/** faux 剧本的形状校验。写坏了只在 selftest 时才炸,而那时人已经在等结果了。 */
function validateFaux(raw: unknown, fieldPath: string, issues: string[]): FauxScript | undefined {
  if (!Array.isArray(raw)) {
    issues.push(`${fieldPath} 必须是数组(一个元素 = 一次 provider 响应)`)
    return undefined
  }
  const script: FauxScript = []
  raw.forEach((message, index) => {
    const at = `${fieldPath}[${index}]`
    if (!Array.isArray(message)) {
      issues.push(`${at} 必须是数组(一条 assistant 消息的 parts)`)
      return
    }
    const parts = message.map((part, partIndex) => {
      const partAt = `${at}[${partIndex}]`
      if (!isObject(part)) {
        issues.push(`${partAt} 必须是 { text } 或 { tool, input }`)
        return undefined
      }
      if (typeof part.text === "string") return { text: part.text }
      const tool = str(part.tool)
      if (!tool) {
        issues.push(`${partAt} 必须是 { text } 或 { tool, input }`)
        return undefined
      }
      const input = isObject(part.input) ? part.input : {}
      return { tool, input }
    })
    if (parts.every((part) => part !== undefined)) script.push(parts as FauxScript[number])
  })
  return script
}

/**
 * 解析并校验一道题。**不**碰文件系统 —— `setup.files[].from` 存不存在由 trial 在
 * 准备阶段查(那时带得上"哪道题、复制到哪"的上下文,报错更有用)。
 */
export function parseTask(raw: unknown, file: string): Task {
  const issues: string[] = []
  if (!isObject(raw)) throw new TaskSpecError(file, ["task.json 必须是一个 JSON 对象"])

  const dir = path.dirname(path.resolve(file))
  const dirName = path.basename(dir)

  const id = str(raw.id)
  if (!id) issues.push("id 必填,且必须等于目录名")
  else if (!ID_RE.test(id)) issues.push(`id "${id}" 不合法,只能是小写字母/数字/点/连字符,且首字符是字母或数字`)
  else if (id !== dirName)
    issues.push(`id "${id}" 与目录名 "${dirName}" 不一致(报告与产物按 id 索引,不一致会让人以为题没跑)`)

  const title = str(raw.title)
  if (!title) issues.push("title 必填(给人看的一句话)")

  const tags = strList(raw.tags)
  if (!tags) issues.push("tags 必填,且是非空字符串数组(汇总按它分组;约定 L1/L2/L3/L4)")

  const requires: RequireKind[] = []
  if (raw.requires !== undefined) {
    if (!Array.isArray(raw.requires)) issues.push("requires 必须是字符串数组")
    else {
      for (const [index, item] of raw.requires.entries()) {
        const kind = str(item)
        // 不认识的能力名在 run.ts 里一律视为"不满足"→ 整题 skip。所以打错字的后果是
        // 一道永远跳过的题(报告里有 skip,但没人会去追是不是打错了)—— 在这里挡住。
        if (!kind || !REQUIRE_KINDS.includes(kind as RequireKind)) {
          issues.push(`requires[${index}] "${String(item)}" 不认识(可选:${REQUIRE_KINDS.join(" / ")})`)
        } else requires.push(kind as RequireKind)
      }
    }
  }

  const envRaw = raw.env
  let envKind: EnvKind = "none"
  if (!isObject(envRaw)) issues.push(`env 必填,v1 写 { "kind": "none" }`)
  else {
    const kind = str(envRaw.kind)
    if (!kind || !ENV_KINDS.includes(kind as EnvKind)) {
      issues.push(`env.kind "${String(envRaw.kind)}" 不认识(可选:${ENV_KINDS.join(" / ")})`)
    } else if (kind !== "none") {
      issues.push(`env.kind "${kind}" v1 未实现 —— 现在只有 none(一次性临时目录)`)
    } else envKind = kind
  }

  const files: TaskSetupFile[] = []
  if (raw.setup !== undefined) {
    if (!isObject(raw.setup)) issues.push("setup 必须是一个对象")
    else if (raw.setup.files !== undefined) {
      if (!Array.isArray(raw.setup.files)) issues.push("setup.files 必须是数组")
      else
        raw.setup.files.forEach((entry, index) => {
          const at = `setup.files[${index}]`
          if (!isObject(entry)) {
            issues.push(`${at} 必须是 { from, to }`)
            return
          }
          const from = str(entry.from)
          const to = str(entry.to)
          if (!from) issues.push(`${at}.from 必填(相对仓库根)`)
          else checkRelative(from, `${at}.from`, issues)
          if (!to) issues.push(`${at}.to 必填(相对工作目录)`)
          else checkRelative(to, `${at}.to`, issues)
          if (from && to) files.push({ from, to })
        })
    }
  }

  const prompt = str(raw.prompt)
  if (!prompt) issues.push("prompt 必填 —— 它是 agent 唯一的任务来源")
  else if (!prompt.includes("json")) {
    // 答案格式是这套判分唯一的锚点。题面不写 ```json 围栏,answer grader 一定判 fail,
    // 而报告上看起来像"模型不听话"。宁可在这里啰嗦一句。
    issues.push('prompt 里没提到 json 围栏 —— 必须写明"最后一条消息用 ```json 围栏给出 {"answer": …}"')
  }

  let reference: TaskReference = { answer: undefined }
  if (!isObject(raw.reference)) issues.push("reference 必填:参考解 + 出处,没有参考解的题不收")
  else if (raw.reference.answer === undefined) issues.push("reference.answer 必填")
  else reference = { answer: raw.reference.answer, note: str(raw.reference.note) }

  const graders: GraderSpec[] = []
  if (!Array.isArray(raw.graders) || raw.graders.length === 0) issues.push("graders 必填,至少一个")
  else
    raw.graders.forEach((entry, index) => {
      const spec = validateGraderSpec(entry, `graders[${index}]`, issues)
      if (spec) graders.push(spec)
    })

  let faux: TaskFaux | undefined
  if (raw.faux !== undefined) {
    if (!isObject(raw.faux)) issues.push("faux 必须是 { good?, bad? }")
    else {
      const good = raw.faux.good === undefined ? undefined : validateFaux(raw.faux.good, "faux.good", issues)
      const bad = raw.faux.bad === undefined ? undefined : validateFaux(raw.faux.bad, "faux.bad", issues)
      faux = { good, bad }
    }
  }

  let timeoutMs: number | undefined
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) {
      issues.push("timeoutMs 必须是正数(毫秒)")
    } else timeoutMs = raw.timeoutMs
  }

  if (issues.length) throw new TaskSpecError(file, issues)

  return {
    id: id!,
    title: title!,
    tags: tags!,
    requires,
    env: { kind: envKind },
    setup: { files },
    prompt: prompt!,
    reference,
    graders,
    faux,
    timeoutMs,
    dir,
    file: path.resolve(file),
  }
}

export async function loadTask(file: string): Promise<Task> {
  const text = await readFile(file, "utf8")
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new TaskSpecError(file, [`不是合法 JSON:${(error as Error).message}`])
  }
  return parseTask(raw, file)
}

/** filter 匹配 id 子串**或** tag(整词)。tag 用整词是因为 "L1" 是 "L10" 的子串。 */
export function matchesFilter(task: Task, filter: string): boolean {
  const needle = filter.trim().toLowerCase()
  if (!needle) return true
  if (task.id.toLowerCase().includes(needle)) return true
  return task.tags.some((tag) => tag.toLowerCase() === needle)
}

async function findTaskFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await findTaskFiles(full)))
    else if (entry.name === "task.json") found.push(full)
  }
  return found
}

/**
 * 递归收题。**一道坏题不阻断其余** —— 它变成一条 `errors`,由调用方决定要不要终止。
 * 出题期(并行加题的人不止一个)最常见的形态就是"别的题都好,我这道刚写坏",
 * 让整个 list/run 一起挂掉只会让人不敢跑。
 */
export async function loadTasks(
  tasksDir: string,
  filter?: string,
): Promise<{ tasks: Task[]; errors: { file: string; message: string }[] }> {
  const files = (await findTaskFiles(path.resolve(tasksDir))).sort()
  const tasks: Task[] = []
  const errors: { file: string; message: string }[] = []
  for (const file of files) {
    try {
      const task = await loadTask(file)
      if (!filter || matchesFilter(task, filter)) tasks.push(task)
    } catch (error) {
      errors.push({ file, message: (error as Error).message })
    }
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id))
  return { tasks, errors }
}
