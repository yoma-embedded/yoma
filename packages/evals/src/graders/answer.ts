/**
 * `answer` —— 判**产出**,不判路径。
 *
 * 它是四个 grader 里唯一必需的那个:没有"最终答案对不对",别的都只是过程指标。
 * 三种判法互斥地叠加(全都填就全都要满足),校验期要求至少填一种 —— 一个什么都不填的
 * answer grader 会永远亮绿,那正是"不会响的闸门"。
 */

import { answerEquals, answerMatches, answerOneOf, describeAnswer, readAnswerField } from "../answer.ts"
import type { AnswerGraderSpec, Grader, GraderContext, GraderVerdict } from "./types.ts"
import { str } from "./types.ts"

export const DEFAULT_ANSWER_FIELD = "answer"

export function validateAnswerSpec(
  raw: Record<string, unknown>,
  fieldPath: string,
  issues: string[],
): AnswerGraderSpec {
  const spec: AnswerGraderSpec = { type: "answer" }
  const field = str(raw.field)
  if (raw.field !== undefined && !field) issues.push(`${fieldPath}.field 必须是非空字符串`)
  spec.field = field

  if ("equals" in raw) spec.equals = raw.equals
  if (raw.oneOf !== undefined) {
    if (!Array.isArray(raw.oneOf) || raw.oneOf.length === 0) issues.push(`${fieldPath}.oneOf 必须是非空数组`)
    else spec.oneOf = raw.oneOf
  }
  const matches = str(raw.matches)
  if (raw.matches !== undefined && !matches) issues.push(`${fieldPath}.matches 必须是非空字符串(正则)`)
  else if (matches) {
    try {
      new RegExp(matches)
      spec.matches = matches
    } catch (error) {
      issues.push(`${fieldPath}.matches 不是合法正则:${(error as Error).message}`)
    }
  }
  if (raw.unordered !== undefined) {
    if (typeof raw.unordered !== "boolean") issues.push(`${fieldPath}.unordered 必须是 true/false`)
    else spec.unordered = raw.unordered
  }

  // 一个都不填 = 永远通过。宁可在出题的当下报错,也不要在跑完之后拿一张全绿的假报告。
  if (spec.equals === undefined && !spec.oneOf && !spec.matches) {
    issues.push(`${fieldPath} 至少要有 equals / oneOf / matches 之一,否则它永远判通过`)
  }
  return spec
}

export function createAnswerGrader(spec: AnswerGraderSpec): Grader {
  const field = spec.field ?? DEFAULT_ANSWER_FIELD
  const unordered = spec.unordered ?? true
  return {
    type: "answer",
    grade(context: GraderContext): GraderVerdict {
      if (context.answer.parsed === undefined) {
        return { type: "answer", pass: false, detail: context.answer.error ?? "没有拿到最终答案" }
      }
      const read = readAnswerField(context.answer.parsed, field)
      if (!read.ok) return { type: "answer", pass: false, detail: read.error }

      const actual = read.value
      const got = describeAnswer(actual)
      const reasons: string[] = []
      if (spec.equals !== undefined && !answerEquals(actual, spec.equals, unordered)) {
        reasons.push(`应为 ${describeAnswer(spec.equals)}`)
      }
      if (spec.oneOf && !answerOneOf(actual, spec.oneOf, unordered)) {
        reasons.push(`应为 ${spec.oneOf.map(describeAnswer).join(" / ")} 之一`)
      }
      if (spec.matches && !answerMatches(actual, spec.matches)) {
        reasons.push(`应整串匹配 /${spec.matches}/i`)
      }
      if (reasons.length) return { type: "answer", pass: false, detail: `${field} = ${got},但${reasons.join(";")}` }
      return { type: "answer", pass: true, detail: `${field} = ${got}` }
    },
  }
}
