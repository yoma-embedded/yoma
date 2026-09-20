import { describe, expect, test } from "vitest"
import { formatPurchaseAmount, hasPurchaseContact, isOpenableChannel, PURCHASE } from "./purchase"

describe("purchase config", () => {
  test("试售价是 999 / 9990 元,按人计价", () => {
    expect(PURCHASE.pricing).toEqual({ currency: "CNY", monthly: 999, yearly: 9990, unit: "per-seat", trial: true })
  })

  /**
   * 今天还没有对外的购买渠道。`configured: false` 时 `channels` 必须是空的 ——
   * 留一条"示例渠道"在里面就是界面上一个假的联系方式。
   */
  test("联系方式未配置,且没有任何渠道", () => {
    expect(PURCHASE.contact.configured).toBe(false)
    expect(PURCHASE.contact.channels).toEqual([])
    expect(hasPurchaseContact()).toBe(false)
  })

  test("configured 为 true 但没有渠道时仍然走「待配置」那一支", () => {
    expect(hasPurchaseContact({ configured: true, channels: [] })).toBe(false)
    expect(
      hasPurchaseContact({ configured: true, channels: [{ kind: "email", label: "邮箱", value: "a@b.c" }] }),
    ).toBe(true)
  })

  /** 只有 http(s) 的 url 渠道可以点开;其它都只显示文本,免得把 `wechat:xxx` 丢给 shell。 */
  test("只有 http(s) 的 url 渠道可以点开", () => {
    expect(isOpenableChannel({ kind: "url", label: "官网", value: "https://example.test/buy" })).toBe(true)
    expect(isOpenableChannel({ kind: "url", label: "官网", value: "file:///etc/passwd" })).toBe(false)
    expect(isOpenableChannel({ kind: "wechat", label: "微信", value: "https://example.test" })).toBe(false)
    expect(isOpenableChannel({ kind: "email", label: "邮箱", value: "a@b.c" })).toBe(false)
  })

  test("金额格式化带上数字,并且坏币种不抛", () => {
    expect(formatPurchaseAmount(999, "CNY", "zh-CN")).toContain("999")
    expect(formatPurchaseAmount(9990, "CNY", "en")).toContain("9,990")
    expect(formatPurchaseAmount(999, "NOT-A-CURRENCY", "en")).toBe("NOT-A-CURRENCY 999")
  })

  test("说明文案只给 i18n 键,价格不写死在文案里", () => {
    for (const key of Object.values(PURCHASE.copy)) expect(key).toMatch(/^settings\.license\./)
  })
})
