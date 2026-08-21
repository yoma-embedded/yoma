/**
 * grader 的共享形状。
 *
 * grader 是**纯函数**:拿到一份已经收齐的证据(结果 / transcript / 答案),产出
 * `{ type, pass, detail }`。它不碰文件系统、不起进程 —— 于是每一个都能用手造的
 * context 正反各测一次(`graders.test.ts`),这正是"grader 自己也要被判"的落点。
 *
 * `detail` 是**必填的一句人话**,通过时也要写。README 的出题纪律第 6 条要求跑完读
 * transcript 判断"是真蠢还是 grader 冤枉了合法解法",没有 detail 的报告没法读。
 */

import type { TurnResult } from "@yoma-desktop/bench"

import type { AnswerExtraction } from "../answer.ts"
import type { Transcript } from "../session.ts"
import type { Task } from "../task.ts"

export interface GraderContext {
  task: Task
  result: TurnResult
  transcript: Transcript
  answer: AnswerExtraction
}

export interface GraderVerdict {
  type: string
  pass: boolean
  detail: string
}

export interface Grader {
  readonly type: string
  grade(context: GraderContext): GraderVerdict
}

// ─── 各 grader 的 spec(校验在各自模块里,注册表在 index.ts) ────────────────────

export interface AnswerGraderSpec {
  type: "answer"
  /** 围栏 JSON 里取哪个字段,默认 `answer`。 */
  field?: string
  equals?: unknown
  oneOf?: unknown[]
  /** 正则,整串匹配(锚点由 grader 加),大小写不敏感。 */
  matches?: string
  /** 数组按集合比,默认 true。 */
  unordered?: boolean
}

export interface GroundedGraderSpec {
  type: "grounded"
  /** 默认取参考答案的字符串(数组则每个元素一条)。 */
  needles?: string[]
  mode?: "all" | "any"
}

export interface ToolCalledGraderSpec {
  type: "tool-called"
  tool: string
  minCount?: number
  /** 限定工具调用的终态(`completed` / `error`);不填则不限。 */
  status?: string
}

export interface ToolForbiddenGraderSpec {
  type: "tool-forbidden"
  tools: string[]
}

export type GraderSpec = AnswerGraderSpec | GroundedGraderSpec | ToolCalledGraderSpec | ToolForbiddenGraderSpec

// ─── 手写校验的小工具(与 bench 的 parseJob 同一风格:指名字段、聚合错误) ───────

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** 非空字符串数组;不是就返回 undefined,由调用方 push 错误(它知道字段名)。 */
export function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const items = value.map((item) => str(item))
  return items.every((item): item is string => item !== undefined) ? items : undefined
}
