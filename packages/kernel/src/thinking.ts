/**
 * 思考档位求解,host 与 renderer 共用。
 *
 * harness 没人指定就 `"off"`,会把 reasoning 从请求里摘掉。两端默认都落
 * {@link DEFAULT_THINKING_LEVEL}。renderer 只有 `thinkingLevels` 字符串数组,
 * 所以不直接调 pi-ai 的 `clampThinkingLevel`(语义对齐,见 thinking.test.ts)。
 */

/**
 * 与 pi-ai 的 `EXTENDED_THINKING_LEVELS` 同序(`packages/ai/dist/models.js:206`)。
 * 抄一份是因为它没被导出;漂移由 `thinking.test.ts` 对着真档位表钉住。
 */
const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

/** 合法档位全集 —— 给"开跑前校验任务书"这类调用方用。 */
export const THINKING_LEVELS: readonly string[] = THINKING_ORDER

/** 没人表态时用 max。要省就显式选 off。 */
export const DEFAULT_THINKING_LEVEL = "max"

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
