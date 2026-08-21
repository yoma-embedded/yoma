/**
 * `grounded` —— 答案得**有出处**。
 *
 * 打的是嵌入式的头号失败模式:没量就猜。模型对着一个它没打开过的网表说"主控是 U3",
 * 恰好蒙对时 `answer` 是绿的,而这套 agent 的产品是**证据**,不是运气。所以再问一句:
 * 你说的这个词,在某次真的跑完的工具调用输出里出现过吗?
 *
 * 只认 `completed` 的调用:报错的那次输出是错误消息,把它算成"看见过"等于承认
 * "工具炸了但我从错误信息里读到了答案"—— 那不是接地,那是另一种猜。
 *
 * 反过来,它**不**要求"是这次调用让它知道的":因果关系读不出来,能读出来的只有
 * "证据在不在场"。冤枉合法解法的风险由出题人用 needles 收窄(见 README 出题纪律 3)。
 */

import { normalizeText } from "../answer.ts"
import type { Grader, GraderContext, GraderVerdict, GroundedGraderSpec } from "./types.ts"
import { strList } from "./types.ts"

/** 参考答案 → 默认 needles。数组每个元素一条,标量一条;空字符串不要(它到处都在)。 */
export function needlesFromReference(answer: unknown): string[] {
  const items = Array.isArray(answer) ? answer : [answer]
  return items.map((item) => normalizeText(item)).filter((item) => item.length > 0)
}

export function validateGroundedSpec(
  raw: Record<string, unknown>,
  fieldPath: string,
  issues: string[],
): GroundedGraderSpec {
  const spec: GroundedGraderSpec = { type: "grounded" }
  if (raw.needles !== undefined) {
    const needles = strList(raw.needles)
    if (!needles) issues.push(`${fieldPath}.needles 必须是非空字符串数组`)
    else spec.needles = needles
  }
  if (raw.mode !== undefined) {
    if (raw.mode !== "all" && raw.mode !== "any") issues.push(`${fieldPath}.mode 只能是 all 或 any`)
    else spec.mode = raw.mode
  }
  return spec
}

export function createGroundedGrader(spec: GroundedGraderSpec): Grader {
  const mode = spec.mode ?? "all"
  return {
    type: "grounded",
    grade(context: GraderContext): GraderVerdict {
      const needles = spec.needles ?? needlesFromReference(context.task.reference.answer)
      if (!needles.length) {
        return { type: "grounded", pass: false, detail: "没有可查的 needle(参考答案是空的,请显式写 needles)" }
      }
      const completed = context.transcript.toolCalls.filter((call) => call.status === "completed")
      if (!completed.length) {
        return { type: "grounded", pass: false, detail: `没有任何已完成的工具调用,${needles.join(" / ")} 无处可查` }
      }
      const haystacks = completed.map((call) => ({ tool: call.name, text: call.output.toLowerCase() }))
      const hits = needles.map((needle) => ({
        needle,
        tool: haystacks.find((haystack) => haystack.text.includes(needle.toLowerCase()))?.tool,
      }))
      const found = hits.filter((hit) => hit.tool)
      const missing = hits.filter((hit) => !hit.tool).map((hit) => hit.needle)
      const pass = mode === "all" ? missing.length === 0 : found.length > 0

      const where = found.map((hit) => `${hit.needle}@${hit.tool}`).join(", ")
      if (pass) return { type: "grounded", pass: true, detail: `在工具输出里找到 ${where || "(无)"}` }
      return {
        type: "grounded",
        pass: false,
        detail:
          `${missing.join(" / ")} 没出现在任何已完成工具的输出里` +
          `(查了 ${completed.length} 次调用${where ? `,找到 ${where}` : ""})`,
      }
    },
  }
}
