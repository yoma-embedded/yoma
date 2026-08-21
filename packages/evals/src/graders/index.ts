/**
 * grader 注册表 —— 加一个新类型不用改 runner。
 *
 * 两张表并排:`VALIDATORS` 在**出题期**(parseTask)把 spec 校干净并指名字段,
 * `FACTORIES` 在**跑分期**把 spec 变成 grader。分开的理由是它们的失败时机不同:
 * 前者要在一次都没跑之前就把人喊住(跑完一整轮再报"grader 配错了"是最贵的错误),
 * 后者只在有证据之后才有意义。
 *
 * 未知 type 由 {@link validateGraderSpec} 报出来 —— 写错 `tool-forbiden` 的后果否则是
 * 一条静默消失的红线。
 */

import { createAnswerGrader, validateAnswerSpec } from "./answer.ts"
import { createGroundedGrader, validateGroundedSpec } from "./grounded.ts"
import { createToolCalledGrader, validateToolCalledSpec } from "./tool-called.ts"
import { createToolForbiddenGrader, validateToolForbiddenSpec } from "./tool-forbidden.ts"
import type { Grader, GraderSpec } from "./types.ts"
import { isObject, str } from "./types.ts"

type Validator = (raw: Record<string, unknown>, fieldPath: string, issues: string[]) => GraderSpec

const VALIDATORS: Record<string, Validator> = {
  answer: validateAnswerSpec,
  grounded: validateGroundedSpec,
  "tool-called": validateToolCalledSpec,
  "tool-forbidden": validateToolForbiddenSpec,
}

const FACTORIES: Record<string, (spec: never) => Grader> = {
  answer: createAnswerGrader as (spec: never) => Grader,
  grounded: createGroundedGrader as (spec: never) => Grader,
  "tool-called": createToolCalledGrader as (spec: never) => Grader,
  "tool-forbidden": createToolForbiddenGrader as (spec: never) => Grader,
}

export const GRADER_TYPES = Object.keys(VALIDATORS)

/** 校验一条 grader spec。返回 undefined 表示这一条报废了(错误已进 issues)。 */
export function validateGraderSpec(raw: unknown, fieldPath: string, issues: string[]): GraderSpec | undefined {
  if (!isObject(raw)) {
    issues.push(`${fieldPath} 必须是一个对象`)
    return undefined
  }
  const type = str(raw.type)
  if (!type) {
    issues.push(`${fieldPath}.type 必填(可选:${GRADER_TYPES.join(" / ")})`)
    return undefined
  }
  const validate = VALIDATORS[type]
  if (!validate) {
    issues.push(`${fieldPath}.type "${type}" 不认识(可选:${GRADER_TYPES.join(" / ")})`)
    return undefined
  }
  return validate(raw, fieldPath, issues)
}

export function createGrader(spec: GraderSpec): Grader {
  const factory = FACTORIES[spec.type]
  // parseTask 已经挡过一次;这里再挡是给"绕过解析直接构造 Task"的调用方(测试)兜底。
  if (!factory) throw new Error(`未知 grader 类型 ${spec.type}`)
  return factory(spec as never)
}

export type { Grader, GraderContext, GraderSpec, GraderVerdict } from "./types.ts"
export type { AnswerGraderSpec, GroundedGraderSpec, ToolCalledGraderSpec, ToolForbiddenGraderSpec } from "./types.ts"
export { needlesFromReference } from "./grounded.ts"
export { DEFAULT_ANSWER_FIELD } from "./answer.ts"
