/**
 * 档位求解的不变式。
 *
 * 最要紧的一条是**和 pi-ai 的 clampThinkingLevel 同解** —— 我们另写了一份是因为
 * renderer 只拿得到档位字符串数组而不是 Model 对象(见 thinking.ts 的头注释),
 * 那就必须有一道闸门盯着两份实现不许分叉。这里直接拿真的 pi-ai 来对答案。
 */

import { describe, expect, test } from "bun:test"
import { clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai"

import { DEFAULT_THINKING_LEVEL, THINKING_LEVELS, pickThinkingLevel } from "./thinking.ts"

/** 只需要 reasoning + thinkingLevelMap 两个字段就能问出档位表。 */
function model(reasoning: boolean, map?: Record<string, string | null>): Model<string> {
  return { id: "m", provider: "p", reasoning, thinkingLevelMap: map } as unknown as Model<string>
}

/** deepseek-v4-pro 的真实档位表(coding-agent/src/acp/models.ts)。 */
const DEEPSEEK = { minimal: null, low: null, medium: null, high: "high", max: "max" }

describe("pickThinkingLevel", () => {
  test("默认档是 high —— 不是 off", () => {
    // 这条测试就是这次改动的理由本身:reasoning 模型不该默认不思考。
    expect(DEFAULT_THINKING_LEVEL).toBe("high")
    expect(pickThinkingLevel(["off", "high", "max"])).toBe("high")
  })

  test("非 reasoning 模型落回 off —— 不需要调用方分支", () => {
    expect(pickThinkingLevel(getSupportedThinkingLevels(model(false)) as string[])).toBe("off")
  })

  test("要的档位没有就往上找,再没有才往下降", () => {
    // 只有 max:high 够不着,往上找到 max(宁可多想)。
    expect(pickThinkingLevel(["off", "max"])).toBe("max")
    // 只有 low:high 之上没有,往下降到 low。
    expect(pickThinkingLevel(["off", "low"])).toBe("low")
  })

  test("显式档位优先于默认,包括显式 off", () => {
    expect(pickThinkingLevel(["off", "high", "max"], "max")).toBe("max")
    expect(pickThinkingLevel(["off", "high", "max"], "off")).toBe("off")
  })

  test("不认识的档位(错字)退回第一档,不抛", () => {
    expect(pickThinkingLevel(["off", "high", "max"], "hight")).toBe("off")
  })

  test("空档位表返回 undefined —— 意思是别设,交给下游默认", () => {
    expect(pickThinkingLevel([])).toBeUndefined()
  })

  test("THINKING_LEVELS 覆盖 pi-ai 认得的全部档位", () => {
    // 任务书校验拿它当白名单;漏一档的后果是合法配置被判非法。
    const everything = getSupportedThinkingLevels(
      model(true, { minimal: "a", low: "b", medium: "c", high: "d", xhigh: "e", max: "f" }),
    ) as string[]
    for (const level of everything) expect(THINKING_LEVELS).toContain(level)
  })

  test("与 pi-ai 的 clampThinkingLevel 同解 —— 两份实现不许分叉", () => {
    const models = [
      model(false),
      model(true, DEEPSEEK),
      model(true, {}),
      model(true, { minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" }),
      model(true, { high: null, xhigh: null, max: null }),
    ]
    for (const candidate of models) {
      const levels = getSupportedThinkingLevels(candidate) as string[]
      for (const want of THINKING_LEVELS) {
        expect(pickThinkingLevel(levels, want)).toBe(clampThinkingLevel(candidate, want as never) as string)
      }
    }
  })
})
