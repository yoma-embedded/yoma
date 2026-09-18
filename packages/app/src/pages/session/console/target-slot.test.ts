/**
 * 目标格的两件可测的事:卡片往哪儿落,以及"钉住"这一位怎么落盘。
 *
 * 落点为什么要测:状态栏在整页最底、目标格在最左,这两处**恰好是两条会把浮层推出视口的边**。
 * 算错了不报错,表现是卡片有一半在屏幕外 —— 而这正是 v3 在抽屉里吃过的那种亏。
 */
import { describe, expect, test } from "vitest"
import { anchorPopover, TARGET_CARD_WIDTH } from "./target-slot"
import { readTargetCardPinned } from "./target-card-state"

const viewport = { width: 1440, height: 900 }

describe("anchorPopover", () => {
  test("卡在格子正上方、左边对齐,隔着 6px 的缝", () => {
    // 状态栏 24px 高,坐在 900 的底上 → top = 876。
    expect(anchorPopover({ left: 12, top: 876 }, viewport)).toEqual({ left: 12, bottom: 30 })
  })

  test("左边永远留 8px —— 格子贴着窗口左缘时卡不跟着贴出去", () => {
    expect(anchorPopover({ left: 0, top: 876 }, viewport).left).toBe(8)
    expect(anchorPopover({ left: -20, top: 876 }, viewport).left).toBe(8)
  })

  test("右边放不下时往里收,不是横着溢出去", () => {
    const anchor = anchorPopover({ left: 1400, top: 876 }, viewport)
    expect(anchor.left + TARGET_CARD_WIDTH).toBeLessThanOrEqual(viewport.width - 8)
  })

  test("窗口比卡还窄时仍然从 8px 起(宁可右边被裁,也不要左边看不见)", () => {
    expect(anchorPopover({ left: 100, top: 400 }, { width: 200, height: 600 }).left).toBe(8)
  })

  test("1280 宽下 1280×800 的落点", () => {
    expect(anchorPopover({ left: 12, top: 776 }, { width: 1280, height: 800 })).toEqual({ left: 12, bottom: 30 })
  })
})

describe("钉住这一位的落盘", () => {
  test("没存过 / 存了垃圾一律当作没钉过", () => {
    expect(readTargetCardPinned(null)).toBe(false)
    expect(readTargetCardPinned("")).toBe(false)
    expect(readTargetCardPinned("{oops")).toBe(false)
    expect(readTargetCardPinned("[]")).toBe(false)
    expect(readTargetCardPinned('"true"')).toBe(false)
  })

  test("只有 pinned 真的是 true 才算钉住(字符串 \"true\" 不算)", () => {
    expect(readTargetCardPinned('{"pinned":true}')).toBe(true)
    expect(readTargetCardPinned('{"pinned":"true"}')).toBe(false)
    expect(readTargetCardPinned('{"pinned":false}')).toBe(false)
  })
})
