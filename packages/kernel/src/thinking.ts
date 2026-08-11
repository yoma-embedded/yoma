/**
 * 思考档位的求解 —— 一份实现,host 与 renderer 共用。
 *
 * ## 为什么需要它
 *
 * my-pi 的 harness 在没人指定档位时落到 `"off"`(`agent-harness.ts:214` 的
 * `options.thinkingLevel ?? "off"`),而 `"off"` 会把 `reasoning` 整个从 provider
 * 请求里摘掉(同文件 `:429`)。对 reasoning 模型这就是**能力最强的那一档默认关掉**,
 * 而且没有任何地方提示。
 *
 * 交互式使用时这还有救 —— 桌面端的模型对话框里能选,选了就经 `session.setModel`
 * 下发。**无人值守的调试台没人看着**:实测 2026-08-11 那场信箱闭环,工位端跑
 * deepseek-v4-pro(`reasoning: true`,支持 high/max)整整 5 轮、107 条 assistant
 * 消息,reasoning token 是 0,平均每条只有 146 个输出 token —— 一步一句话、一个
 * 工具调用,从不停下来想。所以 bench 这一侧必须自己给一个默认。
 *
 * ## 为什么是"对档位列表求解"而不是直接调 pi-ai 的 clampThinkingLevel
 *
 * 语义与 `clampThinkingLevel(model, want)` 一致(要 want,没有就往上找,再没有就
 * 往下找)。之所以另写:renderer 拿不到 `Model` 对象,它手上只有结构化复制过来的
 * `ModelInfo.thinkingLevels`(就是 `getSupportedThinkingLevels(model)` 的结果)。
 * 两边各写一份必然漂,于是统一成这一个吃字符串数组的纯函数,host 侧把
 * `getSupportedThinkingLevels(model)` 喂给它。
 *
 * 非 reasoning 模型的档位表只有 `["off"]`,于是自然落回 off —— 不需要额外分支。
 */

/**
 * 与 pi-ai 的 `EXTENDED_THINKING_LEVELS` 同序(`packages/ai/dist/models.js:206`)。
 * 抄一份是因为它没被导出;漂移由 `thinking.test.ts` 对着真档位表钉住。
 */
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

/** 合法档位全集 —— 给"开跑前校验任务书"这类调用方用。 */
export const THINKING_LEVELS: readonly string[] = THINKING_ORDER

/**
 * 没人表态时要的那一档。
 *
 * 取 `high` 而不是 `max`:后者在多数模型上是"想到停不下来",按轮计费的无人值守
 * 场景里代价难估;`high` 是"会停下来想一想"的最低成本档。要更狠就在任务书里
 * 显式写 `model.thinking: "max"`。
 */
export const DEFAULT_THINKING_LEVEL = "high"

/**
 * 在 `levels` 里挑一档最接近 `want` 的。
 *
 * @param levels 该模型支持的档位,即 `ModelInfo.thinkingLevels`
 * @param want   想要哪一档;不给就用 {@link DEFAULT_THINKING_LEVEL}
 * @returns 落定的档位;`levels` 为空时返回 undefined(表示"别设",交给下游自己的默认)
 */
export function pickThinkingLevel(levels: readonly string[], want?: string): string | undefined {
  if (levels.length === 0) return undefined
  const target = want ?? DEFAULT_THINKING_LEVEL
  if (levels.includes(target)) return target

  // 不认识的档位没有"最近"可言 —— 退回该模型的第一档,和 clampThinkingLevel 一致。
  const index = THINKING_ORDER.indexOf(target as (typeof THINKING_ORDER)[number])
  if (index === -1) return levels[0]

  // 先往上找(宁可多想),再往下找(实在没有更强的才降级)。
  for (let i = index + 1; i < THINKING_ORDER.length; i++) {
    if (levels.includes(THINKING_ORDER[i]!)) return THINKING_ORDER[i]
  }
  for (let i = index - 1; i >= 0; i--) {
    if (levels.includes(THINKING_ORDER[i]!)) return THINKING_ORDER[i]
  }
  return levels[0]
}
